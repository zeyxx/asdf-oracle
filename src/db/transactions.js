/**
 * Transaction Database Operations
 *
 * Records and queries for transaction history.
 */

import { getDb, getDbSync } from './connection.js';

/**
 * Record a transaction
 */
export async function recordTransaction(tx) {
  const db = await getDb();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO transactions (signature, slot, block_time, wallet, amount_change)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(tx.signature, tx.slot || 0, tx.blockTime, tx.wallet, String(tx.amountChange || 0));
}

/**
 * Get last processed PoH slot
 */
export async function getLastProcessedSlot() {
  const db = await getDb();
  const stmt = db.prepare('SELECT MAX(slot) as last_slot FROM transactions');
  const row = stmt.get();
  return row?.last_slot || 0;
}

/**
 * Get last processed transaction signature
 */
export async function getLastProcessedSignature() {
  const db = await getDb();
  const stmt = db.prepare('SELECT signature FROM transactions ORDER BY block_time DESC LIMIT 1');
  const row = stmt.get();
  return row?.signature;
}

/**
 * Get recent transactions for live feed
 */
export function getRecentTransactions(limit = 10) {
  const db = getDbSync();
  if (!db) return [];

  const stmt = db.prepare(`
    SELECT t.signature, t.slot, t.block_time, t.wallet, t.amount_change, t.processed_at,
           w.current_balance
    FROM transactions t
    LEFT JOIN wallets w ON t.wallet = w.address
    ORDER BY t.slot DESC
    LIMIT ?
  `);
  return stmt.all(limit);
}

export default {
  recordTransaction,
  getLastProcessedSlot,
  getLastProcessedSignature,
  getRecentTransactions,
};
