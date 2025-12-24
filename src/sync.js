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
import ws from './ws.js';
import { log } from './utils.js';

const POLL_INTERVAL = 5 * 60 * 1000; // 5 minutes
const TOKEN_MINT = process.env.TOKEN_MINT;

let pollTimer = null;
let isPolling = false;

/**
 * Sync holder delta: compare on-chain vs DB, add missing holders
 * Filters by $1 USD minimum using real-time price
 * Called at startup and periodically
 */
export async function syncHolderDelta() {
  log('INFO', 'Syncing holder delta (on-chain vs DB)...');
  const startTime = Date.now();

  try {
    // 1. Get current token price for $1 filter
    const tokenInfo = await helius.fetchTokenInfo();
    const price = tokenInfo.price || 0;

    if (price <= 0) {
      log('WARN', 'Could not get token price, using MIN_BALANCE fallback');
      return { added: 0, error: 'no_price' };
    }

    // $1 in raw tokens (6 decimals)
    const oneUsdInTokens = Math.floor((1 / price) * 1e6);
    log('INFO', `$1 filter = ${(oneUsdInTokens / 1e6).toFixed(0)}M tokens (price: $${price.toFixed(6)})`);

    // 2. Fetch on-chain holders
    const onChainHolders = await helius.fetchHolders();
    const qualifiedHolders = onChainHolders.filter(h => h.balance >= oneUsdInTokens);

    log('INFO', `On-chain: ${onChainHolders.length} total, ${qualifiedHolders.length} >= $1`);

    // 3. Get DB holders
    const dbWallets = await db.getWallets(0);
    const dbAddresses = new Set(dbWallets.map(w => w.address));

    // 4. Find missing holders
    const missing = qualifiedHolders.filter(h => !dbAddresses.has(h.address));

    if (missing.length === 0) {
      log('INFO', 'Holder delta: no missing holders');
      return { added: 0, onChain: qualifiedHolders.length, db: dbWallets.length };
    }

    log('INFO', `Found ${missing.length} missing holders, adding to DB...`);

    // 5. Add missing holders
    for (const holder of missing) {
      await db.upsertWallet({
        address: holder.address,
        balance: holder.balance,
        firstBuyTs: null,
        firstBuyAmount: holder.balance, // Assume current balance is first buy for now
        received: holder.balance,
        sent: 0,
        lastTxSig: null,
      });

      // Queue K_wallet calculation
      await walletScore.enqueueWallet(holder.address);
    }

    const elapsed = Date.now() - startTime;
    log('INFO', `Holder delta complete: +${missing.length} holders (${elapsed}ms)`);

    // 6. Store $1 threshold for calculator to use
    await db.setSyncState('one_usd_threshold', oneUsdInTokens.toString());
    await db.setSyncState('token_price', price.toString());

    // 7. Recalculate K with updated holders
    await calculator.calculate();

    return {
      added: missing.length,
      onChain: qualifiedHolders.length,
      db: dbWallets.length + missing.length,
      oneUsdThreshold: oneUsdInTokens,
      elapsed,
    };

  } catch (error) {
    log('ERROR', `Holder delta sync failed: ${error.message}`);
    return { added: 0, error: error.message };
  }
}

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

    // Fetch all transactions in parallel (3x faster than sequential)
    const BATCH_SIZE = 10; // Parallel batch size (respects rate limit)
    const allTransactions = [];

    for (let i = 0; i < newSignatures.length; i += BATCH_SIZE) {
      const batch = newSignatures.slice(i, i + BATCH_SIZE);
      const txPromises = batch.map(sig =>
        helius.rpc('getTransaction', [
          sig.signature,
          { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }
        ]).catch(e => {
          log('WARN', `Error fetching ${sig.signature.slice(0, 8)}: ${e.message}`);
          return null;
        })
      );
      const results = await Promise.all(txPromises);
      allTransactions.push(...results.filter(Boolean));
    }

    // Sort by slot (PoH ordering) to process in correct order
    allTransactions.sort((a, b) => a.slot - b.slot);

    // Process transactions sequentially (maintains PoH order)
    let processed = 0;
    for (const tx of allTransactions) {
      try {
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

          // Update wallet balance and detect holder changes
          const holderChange = await updateWalletBalance(change);

          // Queue K_wallet recalculation (high priority - tx triggered)
          await walletScore.enqueueWallet(change.wallet);

          // WebSocket broadcast: transaction
          ws.broadcast('tx', {
            signature: change.signature,
            wallet: change.wallet,
            amount: change.amountChange,
            slot: tx.slot,
            type: change.amountChange > 0 ? 'buy' : 'sell',
          });

          // WebSocket broadcast: holder changes
          if (holderChange === 'new') {
            ws.broadcast('holder:new', {
              address: change.wallet,
              balance: change.amountChange,
            });
          } else if (holderChange === 'exit') {
            ws.broadcast('holder:exit', {
              address: change.wallet,
              lastBalance: Math.abs(change.amountChange),
            });
          }

          processed++;
        }
      } catch (e) {
        log('WARN', `Error processing tx: ${e.message}`);
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
 * @returns {'new'|'exit'|null} Holder change type
 */
async function updateWalletBalance(change) {
  const wallets = await db.getWallets(0);
  const existing = wallets.find(w => w.address === change.wallet);

  if (existing) {
    const oldBalance = Number(existing.current_balance);
    const newBalance = oldBalance + change.amountChange;
    await db.upsertWallet({
      address: change.wallet,
      balance: Math.max(0, newBalance),
      firstBuyTs: existing.first_buy_ts,
      firstBuyAmount: Number(existing.first_buy_amount),
      received: change.amountChange > 0 ? change.amountChange : 0,
      sent: change.amountChange < 0 ? Math.abs(change.amountChange) : 0,
      lastTxSig: change.signature,
    });
    // Detect exit: had balance, now zero
    if (oldBalance > 0 && newBalance <= 0) {
      return 'exit';
    }
    return null;
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
    return 'new';
  }
  return null;
}

/**
 * Start polling service
 * Runs holder delta sync immediately, then polls for new transactions
 */
export function startPolling(intervalMs = POLL_INTERVAL) {
  if (pollTimer) {
    log('WARN', 'Polling already started');
    return;
  }

  log('INFO', `Starting polling service (interval: ${intervalMs / 1000}s)`);

  // Immediate: sync holder delta (find missing $1+ holders)
  syncHolderDelta().catch(e => log('ERROR', `Initial delta sync failed: ${e.message}`));

  // Initial transaction poll after 30 seconds
  setTimeout(() => {
    fetchNewTransactions();
  }, 30000);

  // Regular polling (transactions + delta every 5 polls)
  let pollCount = 0;
  pollTimer = setInterval(async () => {
    await fetchNewTransactions();
    pollCount++;
    // Delta sync every 5 polls (25 minutes)
    if (pollCount % 5 === 0) {
      await syncHolderDelta();
    }
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
  syncHolderDelta,
  getStatus,
};
