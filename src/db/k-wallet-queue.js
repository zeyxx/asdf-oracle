/**
 * K_wallet Queue Database Operations
 *
 * Background queue for K_wallet calculations.
 * Uses locking to prevent race conditions.
 */

import { getDb } from './connection.js';

/**
 * Enqueue a wallet for K_wallet calculation
 */
export async function enqueueKWallet(address, priority = 0) {
  const db = await getDb();
  const stmt = db.prepare(`
    INSERT INTO k_wallet_queue (address, priority, created_at)
    VALUES (?, ?, unixepoch())
    ON CONFLICT(address) DO UPDATE SET
      priority = MAX(k_wallet_queue.priority, excluded.priority),
      locked_until = NULL
  `);
  stmt.run(address, priority);
}

/**
 * Enqueue multiple wallets (batch)
 */
export async function enqueueKWalletBatch(addresses, priority = 0) {
  const db = await getDb();
  const stmt = db.prepare(`
    INSERT INTO k_wallet_queue (address, priority, created_at)
    VALUES (?, ?, unixepoch())
    ON CONFLICT(address) DO UPDATE SET
      priority = MAX(k_wallet_queue.priority, excluded.priority),
      locked_until = NULL
  `);
  for (const address of addresses) {
    stmt.run(address, priority);
  }
}

/**
 * Get next wallet to process from queue
 * Uses locking to prevent race conditions
 */
export async function dequeueKWallet() {
  const db = await getDb();
  const now = Math.floor(Date.now() / 1000);
  const lockDuration = 300; // 5 min lock

  const stmt = db.prepare(`
    SELECT address FROM k_wallet_queue
    WHERE locked_until IS NULL OR locked_until < ?
    ORDER BY priority DESC, created_at ASC
    LIMIT 1
  `);
  const row = stmt.get(now);

  if (!row) return null;

  const lockStmt = db.prepare(`
    UPDATE k_wallet_queue SET locked_until = ? WHERE address = ?
  `);
  lockStmt.run(now + lockDuration, row.address);

  return row.address;
}

/**
 * Mark K_wallet calculation as complete
 */
export async function completeKWallet(address, kWallet, tokensAnalyzed, slot = null) {
  const db = await getDb();

  const updateStmt = db.prepare(`
    UPDATE wallets SET
      k_wallet = ?,
      k_wallet_tokens = ?,
      k_wallet_updated_at = unixepoch(),
      k_wallet_slot = ?
    WHERE address = ?
  `);
  updateStmt.run(kWallet, tokensAnalyzed, slot, address);

  const deleteStmt = db.prepare('DELETE FROM k_wallet_queue WHERE address = ?');
  deleteStmt.run(address);
}

/**
 * Mark K_wallet calculation as failed (will retry)
 */
export async function failKWallet(address, error) {
  const db = await getDb();
  const stmt = db.prepare(`
    UPDATE k_wallet_queue SET
      attempts = attempts + 1,
      last_error = ?,
      locked_until = NULL
    WHERE address = ?
  `);
  stmt.run(error, address);
}

/**
 * Remove stale entries (too many attempts)
 */
export async function cleanupKWalletQueue(maxAttempts = 5) {
  const db = await getDb();
  const stmt = db.prepare('DELETE FROM k_wallet_queue WHERE attempts >= ?');
  stmt.run(maxAttempts);
}

/**
 * Clear the entire K_wallet queue
 */
export async function clearKWalletQueue() {
  const db = await getDb();
  const stmt = db.prepare('DELETE FROM k_wallet_queue');
  stmt.run();
}

/**
 * Get queue stats
 */
export async function getKWalletQueueStats() {
  const db = await getDb();
  const now = Math.floor(Date.now() / 1000);

  const total = db.prepare('SELECT COUNT(*) as count FROM k_wallet_queue').get();
  const pending = db.prepare('SELECT COUNT(*) as count FROM k_wallet_queue WHERE locked_until IS NULL OR locked_until < ?').get(now);
  const processing = db.prepare('SELECT COUNT(*) as count FROM k_wallet_queue WHERE locked_until >= ?').get(now);
  const withKWallet = db.prepare('SELECT COUNT(*) as count FROM wallets WHERE k_wallet IS NOT NULL').get();

  return {
    queue_total: total?.count || 0,
    queue_pending: pending?.count || 0,
    queue_processing: processing?.count || 0,
    wallets_with_k_wallet: withKWallet?.count || 0,
  };
}

export default {
  enqueueKWallet,
  enqueueKWalletBatch,
  dequeueKWallet,
  completeKWallet,
  failKWallet,
  cleanupKWalletQueue,
  clearKWalletQueue,
  getKWalletQueueStats,
};
