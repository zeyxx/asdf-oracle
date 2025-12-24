/**
 * Token Database Operations
 *
 * Token K scoring registry and queue for multi-token support.
 */

import { getDb } from './connection.js';

/**
 * Get token from registry
 */
export async function getToken(mint) {
  const db = await getDb();
  const stmt = db.prepare('SELECT * FROM tokens WHERE mint = ?');
  return stmt.get(mint);
}

/**
 * Upsert token in registry
 */
export async function upsertToken(token) {
  const db = await getDb();
  const stmt = db.prepare(`
    INSERT INTO tokens (mint, symbol, tier, k, holders, accumulators, maintained, reducers, extractors, last_sync, sync_duration_ms, sync_status, error_message, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(mint) DO UPDATE SET
      symbol = COALESCE(excluded.symbol, tokens.symbol),
      tier = COALESCE(excluded.tier, tokens.tier),
      k = excluded.k,
      holders = excluded.holders,
      accumulators = excluded.accumulators,
      maintained = excluded.maintained,
      reducers = excluded.reducers,
      extractors = excluded.extractors,
      last_sync = excluded.last_sync,
      sync_duration_ms = excluded.sync_duration_ms,
      sync_status = excluded.sync_status,
      error_message = excluded.error_message
  `);
  stmt.run(
    token.mint,
    token.symbol || null,
    token.tier || 3,
    token.k,
    token.holders,
    token.accumulators,
    token.maintained,
    token.reducers,
    token.extractors,
    token.last_sync || Math.floor(Date.now() / 1000),
    token.sync_duration_ms || null,
    token.sync_status || 'ready',
    token.error_message || null
  );
}

/**
 * Enqueue token for K calculation
 */
export async function enqueueToken(mint, priority = 0) {
  const db = await getDb();

  const tokenStmt = db.prepare(`
    INSERT INTO tokens (mint, sync_status) VALUES (?, 'queued')
    ON CONFLICT(mint) DO UPDATE SET sync_status = 'queued'
  `);
  tokenStmt.run(mint);

  const stmt = db.prepare(`
    INSERT INTO token_queue (mint, priority, created_at)
    VALUES (?, ?, unixepoch())
    ON CONFLICT(mint) DO UPDATE SET
      priority = MAX(token_queue.priority, excluded.priority),
      locked_until = NULL
  `);
  stmt.run(mint, priority);
}

/**
 * Dequeue next token for processing
 */
export async function dequeueToken() {
  const db = await getDb();
  const now = Math.floor(Date.now() / 1000);
  const lockDuration = 600; // 10 min lock

  const stmt = db.prepare(`
    SELECT mint FROM token_queue
    WHERE locked_until IS NULL OR locked_until < ?
    ORDER BY priority DESC, created_at ASC
    LIMIT 1
  `);
  const row = stmt.get(now);

  if (!row) return null;

  const lockStmt = db.prepare('UPDATE token_queue SET locked_until = ? WHERE mint = ?');
  lockStmt.run(now + lockDuration, row.mint);

  const statusStmt = db.prepare("UPDATE tokens SET sync_status = 'syncing' WHERE mint = ?");
  statusStmt.run(row.mint);

  return row.mint;
}

/**
 * Complete token K calculation
 */
export async function completeToken(mint, result) {
  const db = await getDb();

  await upsertToken({
    mint,
    k: result.k,
    holders: result.holders,
    accumulators: result.accumulators,
    maintained: result.maintained,
    reducers: result.reducers,
    extractors: result.extractors,
    last_sync: Math.floor(Date.now() / 1000),
    sync_duration_ms: result.duration_ms,
    sync_status: 'ready',
    error_message: null,
  });

  const deleteStmt = db.prepare('DELETE FROM token_queue WHERE mint = ?');
  deleteStmt.run(mint);
}

/**
 * Mark token calculation as failed
 */
export async function failToken(mint, error) {
  const db = await getDb();

  const queueStmt = db.prepare(`
    UPDATE token_queue SET
      attempts = attempts + 1,
      last_error = ?,
      locked_until = NULL
    WHERE mint = ?
  `);
  queueStmt.run(error, mint);

  const tokenStmt = db.prepare(`
    UPDATE tokens SET sync_status = 'error', error_message = ? WHERE mint = ?
  `);
  tokenStmt.run(error, mint);
}

/**
 * Get token queue stats
 */
export async function getTokenQueueStats() {
  const db = await getDb();
  const now = Math.floor(Date.now() / 1000);

  const total = db.prepare('SELECT COUNT(*) as count FROM token_queue').get();
  const pending = db.prepare('SELECT COUNT(*) as count FROM token_queue WHERE locked_until IS NULL OR locked_until < ?').get(now);
  const processing = db.prepare('SELECT COUNT(*) as count FROM token_queue WHERE locked_until >= ?').get(now);
  const indexed = db.prepare('SELECT COUNT(*) as count FROM tokens WHERE k IS NOT NULL').get();

  return {
    queue_total: total?.count || 0,
    queue_pending: pending?.count || 0,
    queue_processing: processing?.count || 0,
    tokens_indexed: indexed?.count || 0,
  };
}

/**
 * Cleanup stale token queue entries
 */
export async function cleanupTokenQueue(maxAttempts = 3) {
  const db = await getDb();
  const stmt = db.prepare('DELETE FROM token_queue WHERE attempts >= ?');
  stmt.run(maxAttempts);
}

export default {
  getToken,
  upsertToken,
  enqueueToken,
  dequeueToken,
  completeToken,
  failToken,
  getTokenQueueStats,
  cleanupTokenQueue,
};
