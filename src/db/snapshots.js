/**
 * Snapshots & Sync State Database Operations
 *
 * K-metric history and sync state management.
 */

import { getDb } from './connection.js';

/**
 * Save a K-metric snapshot
 */
export async function saveSnapshot(data) {
  const db = await getDb();
  const stmt = db.prepare(`
    INSERT INTO snapshots (k, holders, never_sold, never_sold_pct, accumulators, accumulators_pct, maintained, maintained_pct)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(data.k, data.holders, data.neverSold, data.neverSoldPct, data.accumulators, data.accumulatorsPct, data.maintained, data.maintainedPct);
}

/**
 * Get K-metric snapshots
 */
export async function getSnapshots(limit = 30) {
  const db = await getDb();
  const stmt = db.prepare('SELECT * FROM snapshots ORDER BY created_at DESC LIMIT ?');
  return stmt.all(limit);
}

/**
 * Get sync state value
 */
export async function getSyncState(key) {
  const db = await getDb();
  const stmt = db.prepare('SELECT value FROM sync_state WHERE key = ?');
  const row = stmt.get(key);
  return row?.value;
}

/**
 * Set sync state value
 */
export async function setSyncState(key, value) {
  const db = await getDb();
  const stmt = db.prepare(`
    INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, unixepoch())
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()
  `);
  stmt.run(key, value);
}

/**
 * Get database statistics
 */
export async function getStats() {
  const db = await getDb();
  const walletCount = db.prepare('SELECT COUNT(*) as count FROM wallets').get();
  const txCount = db.prepare('SELECT COUNT(*) as count FROM transactions').get();
  const snapshotCount = db.prepare('SELECT COUNT(*) as count FROM snapshots').get();
  const lastSync = await getSyncState('last_sync');

  return {
    wallets: walletCount?.count || 0,
    transactions: txCount?.count || 0,
    snapshots: snapshotCount?.count || 0,
    lastSync: lastSync ? new Date(parseInt(lastSync) * 1000).toISOString() : null,
  };
}

export default {
  saveSnapshot,
  getSnapshots,
  getSyncState,
  setSyncState,
  getStats,
};
