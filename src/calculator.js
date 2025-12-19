/**
 * K-Metric Calculator
 *
 * Calculates holder conviction from local SQLite data.
 * No API calls - instant calculation.
 */

import db from './db.js';
import { pct, log } from './utils.js';

const MIN_BALANCE = parseInt(process.env.MIN_BALANCE || '1000');

/**
 * Calculate K-Metric from stored wallet data
 * @returns {Object} K-metric data
 */
export async function calculate() {
  log('INFO', 'Calculating K-Metric...');
  const startTime = Date.now();

  // Get all wallets with minimum balance
  const wallets = await db.getWallets(MIN_BALANCE);

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
    const holdDays = wallet.first_buy_ts
      ? Math.floor((Date.now() / 1000 - wallet.first_buy_ts) / 86400)
      : 0;

    results.push({
      address: wallet.address,
      balance: balanceNum,
      firstBuy: firstBuyNum,
      sent: Number(sent),
      retention,
      neverSold: sent === 0n,
      holdDays,
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

  // OG holders (held for 30+ days)
  const og = results.filter((r) => r.holdDays >= 30).length;

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
 */
export async function calculateAndSave() {
  const data = await calculate();
  if (data) {
    await db.saveSnapshot(data);
    log('INFO', 'Snapshot saved');
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
