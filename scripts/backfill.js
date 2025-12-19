#!/usr/bin/env node
/**
 * K-Metric Backfill Script
 *
 * Initial sync of all historical transactions for the token.
 * Run once, then use webhooks for real-time updates.
 *
 * Usage:
 *   node scripts/backfill.js          # Normal sync
 *   node scripts/backfill.js --force  # Delete DB and resync
 */

import { existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import db from '../src/db.js';
import helius from '../src/helius.js';
import calculator from '../src/calculator.js';
import { loadEnv, log, delay } from '../src/utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'k-metric.db');

loadEnv();

const TOKEN_MINT = process.env.TOKEN_MINT;

async function main() {
  const startTime = Date.now();
  const forceResync = process.argv.includes('--force');

  log('INFO', '═══════════════════════════════════════════');
  log('INFO', 'K-METRIC BACKFILL STARTED');
  log('INFO', `Token: ${TOKEN_MINT}`);
  log('INFO', '═══════════════════════════════════════════');

  // Force resync: delete database
  if (forceResync && existsSync(DB_PATH)) {
    log('WARN', 'Force resync: deleting existing database...');
    unlinkSync(DB_PATH);
  }

  // Initialize database
  await db.getDb();

  // Check if already synced
  const lastSync = await db.getSyncState('last_full_sync');
  if (lastSync && !forceResync) {
    log('INFO', `Already synced on ${new Date(parseInt(lastSync) * 1000).toISOString()}`);
    log('INFO', 'Use --force to resync from scratch');

    // Just recalculate K
    const kMetric = await calculator.calculateAndSave();
    log('INFO', `Current K: ${kMetric.k}%`);
    return;
  }

  // Step 1: Fetch current holders
  log('INFO', 'Step 1/3: Fetching current holders...');
  const holders = await helius.fetchHolders();

  // Update wallet balances
  for (const holder of holders) {
    await db.upsertWallet({
      address: holder.address,
      balance: holder.balance,
      firstBuyTs: null,
      firstBuyAmount: 0,
      received: 0,
      sent: 0,
      lastTxSig: null,
    });
  }
  log('INFO', `Stored ${holders.length} holder balances`);

  // Step 2: Stream all transactions
  log('INFO', 'Step 2/3: Streaming historical transactions...');

  const walletData = new Map();
  let txCount = 0;
  let firstTxTime = null;

  await helius.streamMintTransactions(async (transactions) => {
    for (const tx of transactions) {
      const changes = helius.parseTransaction(tx);

      for (const change of changes) {
        txCount++;

        // Track first transaction time
        if (!firstTxTime || change.blockTime < firstTxTime) {
          firstTxTime = change.blockTime;
        }

        // Update wallet data
        if (!walletData.has(change.wallet)) {
          walletData.set(change.wallet, {
            firstBuyTs: null,
            firstBuyAmount: 0,
            totalReceived: 0,
            totalSent: 0,
          });
        }

        const data = walletData.get(change.wallet);

        if (change.amountChange > 0) {
          // Buy/receive
          data.totalReceived += change.amountChange;
          if (!data.firstBuyTs) {
            data.firstBuyTs = change.blockTime;
            data.firstBuyAmount = change.amountChange;
          }
        } else {
          // Sell/send
          data.totalSent += Math.abs(change.amountChange);
        }

        // Record transaction
        await db.recordTransaction(change);
      }
    }

    return transactions.length;
  });

  log('INFO', `Processed ${txCount} token transfers`);

  // Step 3: Update wallet histories
  log('INFO', 'Step 3/3: Updating wallet histories...');

  for (const [address, data] of walletData) {
    // Find current balance from holders list
    const holder = holders.find((h) => h.address === address);
    const balance = holder?.balance || 0;

    await db.upsertWallet({
      address,
      balance,
      firstBuyTs: data.firstBuyTs,
      firstBuyAmount: data.firstBuyAmount,
      received: data.totalReceived,
      sent: data.totalSent,
      lastTxSig: null,
    });
  }

  // Mark sync complete
  await db.setSyncState('last_full_sync', Math.floor(Date.now() / 1000).toString());
  await db.setSyncState('first_tx_time', firstTxTime?.toString() || '0');
  await db.setSyncState('total_transactions', txCount.toString());

  // Calculate and save initial K-metric
  log('INFO', 'Calculating initial K-metric...');
  const kMetric = await calculator.calculateAndSave();

  const elapsed = Math.round((Date.now() - startTime) / 1000);

  log('INFO', '═══════════════════════════════════════════');
  log('INFO', 'BACKFILL COMPLETE');
  log('INFO', `Duration: ${elapsed}s`);
  log('INFO', `Transactions: ${txCount}`);
  log('INFO', `Wallets: ${walletData.size}`);
  log('INFO', `K-Metric: ${kMetric.k}%`);
  log('INFO', '═══════════════════════════════════════════');

  // Print stats
  const stats = await db.getStats();
  console.log('\nDatabase stats:', stats);
}

main().catch((error) => {
  log('ERROR', `Backfill failed: ${error.message}`);
  console.error(error);
  process.exit(1);
});
