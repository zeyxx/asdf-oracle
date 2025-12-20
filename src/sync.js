/**
 * K-Metric Sync Service
 *
 * Hybrid sync: Webhook (real-time) + Polling (fallback)
 * Uses PoH slot as ordering key to avoid duplicates.
 */

import db from './db.js';
import helius from './helius.js';
import calculator from './calculator.js';
import walletScore from './wallet-score.js';
import { log } from './utils.js';

const POLL_INTERVAL = 5 * 60 * 1000; // 5 minutes
const TOKEN_MINT = process.env.TOKEN_MINT;

let pollTimer = null;
let isPolling = false;

/**
 * Fetch new transactions since last processed slot
 */
async function fetchNewTransactions() {
  if (isPolling) {
    log('DEBUG', 'Polling already in progress, skipping');
    return 0;
  }

  isPolling = true;
  const startTime = Date.now();

  try {
    const lastSlot = await db.getLastProcessedSlot();
    log('INFO', `Polling for new transactions (last slot: ${lastSlot})`);

    // Fetch recent transactions for the token
    const result = await helius.rpc('getSignaturesForAddress', [
      TOKEN_MINT,
      { limit: 100 }
    ]);

    if (!result || result.length === 0) {
      log('DEBUG', 'No new signatures found');
      return 0;
    }

    // Filter signatures newer than our last slot
    const newSignatures = result.filter(sig => sig.slot > lastSlot);

    if (newSignatures.length === 0) {
      log('DEBUG', 'All signatures already processed');
      return 0;
    }

    log('INFO', `Found ${newSignatures.length} new transactions to process`);

    // Fetch full transaction details
    let processed = 0;
    for (const sig of newSignatures) {
      try {
        const tx = await helius.rpc('getTransaction', [
          sig.signature,
          { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }
        ]);

        if (!tx) continue;

        // Parse token transfers
        const changes = helius.parseTransaction(tx);

        for (const change of changes) {
          // Record transaction with PoH slot
          await db.recordTransaction({
            signature: `${change.signature}-${change.wallet}`,
            slot: tx.slot,
            blockTime: tx.blockTime,
            wallet: change.wallet,
            amountChange: change.amountChange,
          });

          // Update wallet balance
          await updateWalletBalance(change);

          // Queue K_wallet recalculation (high priority - tx triggered)
          await walletScore.enqueueWallet(change.wallet);

          processed++;
        }
      } catch (e) {
        log('WARN', `Error processing ${sig.signature}: ${e.message}`);
      }
    }

    if (processed > 0) {
      // Recalculate K
      const kMetric = await calculator.calculate();
      const elapsed = Date.now() - startTime;
      log('INFO', `Polling complete: ${processed} transfers, K=${kMetric?.k}% (${elapsed}ms)`);
    }

    return processed;

  } catch (error) {
    log('ERROR', `Polling error: ${error.message}`);
    return 0;
  } finally {
    isPolling = false;
  }
}

/**
 * Update wallet balance from a transfer
 */
async function updateWalletBalance(change) {
  const wallets = await db.getWallets(0);
  const existing = wallets.find(w => w.address === change.wallet);

  if (existing) {
    const newBalance = Number(existing.current_balance) + change.amountChange;
    await db.upsertWallet({
      address: change.wallet,
      balance: Math.max(0, newBalance),
      firstBuyTs: existing.first_buy_ts,
      firstBuyAmount: Number(existing.first_buy_amount),
      received: change.amountChange > 0 ? change.amountChange : 0,
      sent: change.amountChange < 0 ? Math.abs(change.amountChange) : 0,
      lastTxSig: change.signature,
    });
  } else if (change.amountChange > 0) {
    // New wallet
    await db.upsertWallet({
      address: change.wallet,
      balance: change.amountChange,
      firstBuyTs: change.blockTime,
      firstBuyAmount: change.amountChange,
      received: change.amountChange,
      sent: 0,
      lastTxSig: change.signature,
    });
  }
}

/**
 * Start polling service
 */
export function startPolling(intervalMs = POLL_INTERVAL) {
  if (pollTimer) {
    log('WARN', 'Polling already started');
    return;
  }

  log('INFO', `Starting polling service (interval: ${intervalMs / 1000}s)`);

  // Initial poll after 30 seconds
  setTimeout(() => {
    fetchNewTransactions();
  }, 30000);

  // Regular polling
  pollTimer = setInterval(() => {
    fetchNewTransactions();
  }, intervalMs);

  return pollTimer;
}

/**
 * Stop polling service
 */
export function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    log('INFO', 'Polling service stopped');
  }
}

/**
 * Manual sync trigger
 */
export async function syncNow() {
  return await fetchNewTransactions();
}

/**
 * Get sync status
 */
export async function getStatus() {
  const lastSlot = await db.getLastProcessedSlot();
  const stats = await db.getStats();

  return {
    lastProcessedSlot: lastSlot,
    isPolling,
    pollInterval: POLL_INTERVAL,
    ...stats,
  };
}

export default {
  startPolling,
  stopPolling,
  syncNow,
  getStatus,
};
