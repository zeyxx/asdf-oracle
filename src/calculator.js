/**
 * K-Metric Calculator
 *
 * Calculates holder conviction from local SQLite data.
 * No API calls - instant calculation.
 *
 * Uses $1 USD threshold (from sync) or MIN_BALANCE fallback.
 */

import db from './db.js';
import { pct, log, loadEnv } from './utils.js';
import webhooks from './webhooks.js';

loadEnv();

const MIN_BALANCE_FALLBACK = parseInt(process.env.MIN_BALANCE || '1000');

// Track last K for change detection
let lastK = null;
const TOKEN_LAUNCH_TS = parseInt(process.env.TOKEN_LAUNCH_TS || '0');
const OG_EARLY_WINDOW = parseInt(process.env.OG_EARLY_WINDOW || '21') * 86400; // days to seconds
const OG_HOLD_THRESHOLD = parseInt(process.env.OG_HOLD_THRESHOLD || '55') * 86400; // days to seconds

/**
 * Get minimum balance threshold ($1 USD or fallback)
 */
async function getMinBalance() {
  // Try to get $1 threshold from sync state
  const threshold = await db.getSyncState('one_usd_threshold');
  if (threshold) {
    return parseInt(threshold);
  }
  // Fallback to env MIN_BALANCE
  return MIN_BALANCE_FALLBACK;
}

/**
 * Calculate K-Metric from stored wallet data
 * @returns {Object} K-metric data
 */
export async function calculate() {
  log('INFO', 'Calculating K-Metric...');
  const startTime = Date.now();

  // Get $1 threshold or fallback
  const minBalance = await getMinBalance();

  // Get all wallets with minimum balance
  const wallets = await db.getWallets(minBalance);

  if (wallets.length === 0) {
    log('WARN', 'No wallets found with minimum balance');
    return null;
  }

  const results = [];

  for (const wallet of wallets) {
    // All values are BigInt from db.getWallets()
    const firstBuy = wallet.first_buy_amount || wallet.current_balance;
    const sent = wallet.total_sent || 0n;
    const balance = wallet.current_balance;

    // Calculate retention ratio (convert BigInt to Number for floating point)
    const firstBuyNum = Number(firstBuy);
    const balanceNum = Number(balance);
    const retention = firstBuyNum > 0 ? balanceNum / firstBuyNum : 1;

    // Calculate hold days
    const now = Math.floor(Date.now() / 1000);
    const holdDays = wallet.first_buy_ts
      ? Math.floor((now - wallet.first_buy_ts) / 86400)
      : 0;

    // OG = early buyer (within first 21 days) AND held for 55+ days
    const isEarlyBuyer = wallet.first_buy_ts && wallet.first_buy_ts <= TOKEN_LAUNCH_TS + OG_EARLY_WINDOW;
    const hasHeldLongEnough = wallet.first_buy_ts && (now - wallet.first_buy_ts) >= OG_HOLD_THRESHOLD;
    const isOG = isEarlyBuyer && hasHeldLongEnough;

    results.push({
      address: wallet.address,
      balance: balanceNum,
      firstBuy: firstBuyNum,
      sent: Number(sent),
      retention,
      neverSold: sent === 0n,
      holdDays,
      isOG,
    });
  }

  const total = results.length;

  // Classify holders
  const neverSold = results.filter((r) => r.neverSold).length;
  const accumulators = results.filter((r) => r.retention >= 1.5).length;
  const maintained = results.filter((r) => r.retention >= 1.0).length;
  const partialSellers = results.filter((r) => r.retention >= 0.5 && r.retention < 1.0).length;
  const majorSellers = results.filter((r) => r.retention < 0.5).length;

  // K = maintained + accumulators (those who kept or grew their position)
  const k = pct(maintained, total);

  // Average hold time
  const avgHoldDays = Math.round(
    results.reduce((sum, r) => sum + r.holdDays, 0) / total
  );

  // OG holders (early buyers who held 55+ days)
  const og = results.filter((r) => r.isOG).length;

  const elapsed = Date.now() - startTime;
  log('INFO', `K-Metric calculated: K=${k}% (${elapsed}ms)`);

  const data = {
    k,
    holders: total,
    neverSold,
    neverSoldPct: pct(neverSold, total),
    accumulators,
    accumulatorsPct: pct(accumulators, total),
    maintained,
    maintainedPct: pct(maintained, total),
    partialSellers,
    partialSellersPct: pct(partialSellers, total),
    majorSellers,
    majorSellersPct: pct(majorSellers, total),
    avgHoldDays,
    og,
    ogPct: pct(og, total),
    calculatedAt: new Date().toISOString(),
    calculationTimeMs: elapsed,
  };

  return data;
}

/**
 * Calculate and save a snapshot
 * Triggers k_change webhook if K changes significantly
 */
export async function calculateAndSave() {
  const data = await calculate();
  if (data) {
    await db.saveSnapshot(data);
    log('INFO', 'Snapshot saved');

    // Trigger k_change webhook if delta > 1%
    if (lastK !== null) {
      const delta = data.k - lastK;
      if (Math.abs(delta) >= 1) {
        webhooks.triggerKChange({
          previousK: lastK,
          newK: data.k,
          delta,
          holders: data.holders,
        }).catch(err => log('ERROR', `[Webhook] k_change trigger failed: ${err.message}`));
      }
    }
    lastK = data.k;
  }
  return data;
}

/**
 * Get historical snapshots
 */
export async function getHistory(days = 30) {
  const snapshots = await db.getSnapshots(days);
  return snapshots.map((s) => ({
    date: new Date(s.created_at * 1000).toISOString(),
    k: s.k,
    holders: s.holders,
    neverSoldPct: s.never_sold_pct,
    accumulatorsPct: s.accumulators_pct,
  }));
}

export default { calculate, calculateAndSave, getHistory };
