/**
 * K-Metric SQLite Database
 *
 * Persistent storage for wallet histories and K snapshots.
 * Zero dependencies - uses Node.js native sqlite module (Node 22+)
 * or better-sqlite3 fallback.
 */

import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const DB_PATH = join(DATA_DIR, 'k-metric.db');

// OG configuration
const TOKEN_LAUNCH_TS = parseInt(process.env.TOKEN_LAUNCH_TS || '0');
const OG_EARLY_WINDOW = parseInt(process.env.OG_EARLY_WINDOW || '21') * 86400;
const OG_HOLD_THRESHOLD = parseInt(process.env.OG_HOLD_THRESHOLD || '55') * 86400;

// Ensure data directory exists
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

// Dynamic import for SQLite (Node 22+ has native, fallback to better-sqlite3)
let db;

async function initDb() {
  if (db) return db;

  try {
    // Try Node.js native SQLite (Node 22+)
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(DB_PATH);
    console.log('[DB] Using Node.js native SQLite');
  } catch (e) {
    try {
      // Fallback to better-sqlite3
      const Database = (await import('better-sqlite3')).default;
      db = new Database(DB_PATH);
      console.log('[DB] Using better-sqlite3');
    } catch (e2) {
      // Final fallback: in-memory JSON (not persistent but works)
      console.warn('[DB] SQLite not available, using in-memory storage');
      db = createMemoryDb();
    }
  }

  // Run migrations
  migrate();
  return db;
}

function migrate() {
  const migrations = [
    // Wallets table - stores per-wallet token history
    // Note: amounts stored as TEXT to handle large Solana token values (> MAX_SAFE_INTEGER)
    `CREATE TABLE IF NOT EXISTS wallets (
      address TEXT PRIMARY KEY,
      first_buy_ts INTEGER,
      first_buy_amount TEXT DEFAULT '0',
      total_received TEXT DEFAULT '0',
      total_sent TEXT DEFAULT '0',
      current_balance TEXT DEFAULT '0',
      peak_balance TEXT DEFAULT '0',
      last_tx_signature TEXT,
      updated_at INTEGER DEFAULT (unixepoch())
    )`,

    // Migration: Add peak_balance column to existing wallets table
    `ALTER TABLE wallets ADD COLUMN peak_balance TEXT DEFAULT '0'`,

    // Migration: Backfill peak_balance for existing wallets
    // peak_balance = MAX(current_balance, first_buy_amount)
    // This is a lower-bound estimate; actual peak may have been higher
    `UPDATE wallets SET peak_balance =
      CASE
        WHEN CAST(current_balance AS INTEGER) > CAST(COALESCE(first_buy_amount, '0') AS INTEGER)
        THEN current_balance
        ELSE COALESCE(first_buy_amount, current_balance)
      END
    WHERE peak_balance = '0' OR peak_balance IS NULL`,

    // Transactions table - stores processed transactions
    // slot = Solana PoH slot number (monotonically increasing, used as ordering key)
    `CREATE TABLE IF NOT EXISTS transactions (
      signature TEXT PRIMARY KEY,
      slot INTEGER,
      block_time INTEGER,
      wallet TEXT,
      amount_change TEXT,
      processed_at INTEGER DEFAULT (unixepoch())
    )`,

    // Snapshots table - K-metric history
    `CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      k INTEGER,
      holders INTEGER,
      never_sold INTEGER,
      never_sold_pct INTEGER,
      accumulators INTEGER,
      accumulators_pct INTEGER,
      maintained INTEGER,
      maintained_pct INTEGER,
      created_at INTEGER DEFAULT (unixepoch())
    )`,

    // Sync state - tracks backfill progress
    `CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at INTEGER DEFAULT (unixepoch())
    )`,

    // Migration: Add k_wallet columns (global K across all PumpFun tokens)
    `ALTER TABLE wallets ADD COLUMN k_wallet INTEGER DEFAULT NULL`,
    `ALTER TABLE wallets ADD COLUMN k_wallet_tokens INTEGER DEFAULT NULL`,
    `ALTER TABLE wallets ADD COLUMN k_wallet_updated_at INTEGER DEFAULT NULL`,
    `ALTER TABLE wallets ADD COLUMN k_wallet_slot INTEGER DEFAULT NULL`,

    // K_wallet job queue (scale-ready, can migrate to Redis/SQS later)
    `CREATE TABLE IF NOT EXISTS k_wallet_queue (
      address TEXT PRIMARY KEY,
      priority INTEGER DEFAULT 0,
      attempts INTEGER DEFAULT 0,
      last_error TEXT,
      created_at INTEGER DEFAULT (unixepoch()),
      locked_until INTEGER DEFAULT NULL
    )`,

    // Indexes for performance
    `CREATE INDEX IF NOT EXISTS idx_wallets_balance ON wallets(current_balance)`,
    `CREATE INDEX IF NOT EXISTS idx_wallets_peak ON wallets(peak_balance)`,
    `CREATE INDEX IF NOT EXISTS idx_wallets_k_wallet ON wallets(k_wallet)`,
    `CREATE INDEX IF NOT EXISTS idx_transactions_wallet ON transactions(wallet)`,
    `CREATE INDEX IF NOT EXISTS idx_transactions_time ON transactions(block_time)`,
    `CREATE INDEX IF NOT EXISTS idx_transactions_slot ON transactions(slot)`,
    `CREATE INDEX IF NOT EXISTS idx_snapshots_time ON snapshots(created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_k_wallet_queue_next ON k_wallet_queue(locked_until, priority DESC)`,

    // ================================================================
    // Multi-token K scoring (API v1)
    // ================================================================

    // Tokens registry - cached K scores for any PumpFun/Ignition token
    // tier: 1=primary ($ASDFASDFA), 2=tracked (ASDev launches), 3=on-demand
    `CREATE TABLE IF NOT EXISTS tokens (
      mint TEXT PRIMARY KEY,
      symbol TEXT,
      tier INTEGER DEFAULT 3,
      k INTEGER,
      holders INTEGER,
      accumulators INTEGER,
      maintained INTEGER,
      reducers INTEGER,
      extractors INTEGER,
      last_sync INTEGER,
      sync_duration_ms INTEGER,
      sync_status TEXT DEFAULT 'pending',
      error_message TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    )`,

    // Token K calculation queue (same pattern as k_wallet_queue)
    `CREATE TABLE IF NOT EXISTS token_queue (
      mint TEXT PRIMARY KEY,
      priority INTEGER DEFAULT 0,
      attempts INTEGER DEFAULT 0,
      last_error TEXT,
      created_at INTEGER DEFAULT (unixepoch()),
      locked_until INTEGER DEFAULT NULL
    )`,

    `CREATE INDEX IF NOT EXISTS idx_tokens_tier ON tokens(tier)`,
    `CREATE INDEX IF NOT EXISTS idx_tokens_sync ON tokens(last_sync)`,
    `CREATE INDEX IF NOT EXISTS idx_token_queue_next ON token_queue(locked_until, priority DESC)`,
  ];

  for (const sql of migrations) {
    try {
      if (db.exec) {
        db.exec(sql);
      } else if (db.run) {
        db.run(sql);
      }
    } catch (e) {
      // Index might already exist, ignore
    }
  }

  console.log('[DB] Migrations complete');
}

// In-memory fallback database
function createMemoryDb() {
  const tables = {
    wallets: new Map(),
    transactions: new Map(),
    snapshots: [],
    sync_state: new Map(),
  };

  return {
    prepare: (sql) => ({
      run: (...params) => {
        // Simplified in-memory operations
        console.log('[MemDB] Run:', sql.substring(0, 50));
      },
      get: (...params) => null,
      all: (...params) => [],
    }),
    exec: (sql) => console.log('[MemDB] Exec:', sql.substring(0, 50)),
    _tables: tables,
  };
}

// Helper functions
export async function getDb() {
  return await initDb();
}

export function getDbSync() {
  return db;
}

export async function upsertWallet(wallet) {
  const db = await getDb();
  const stmt = db.prepare(`
    INSERT INTO wallets (address, first_buy_ts, first_buy_amount, total_received, total_sent, current_balance, peak_balance, last_tx_signature, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(address) DO UPDATE SET
      first_buy_ts = COALESCE(wallets.first_buy_ts, excluded.first_buy_ts),
      first_buy_amount = CASE WHEN wallets.first_buy_ts IS NULL THEN excluded.first_buy_amount ELSE wallets.first_buy_amount END,
      total_received = wallets.total_received + excluded.total_received,
      total_sent = wallets.total_sent + excluded.total_sent,
      current_balance = excluded.current_balance,
      peak_balance = CASE
        WHEN CAST(excluded.current_balance AS INTEGER) > CAST(COALESCE(wallets.peak_balance, '0') AS INTEGER)
        THEN excluded.current_balance
        ELSE wallets.peak_balance
      END,
      last_tx_signature = excluded.last_tx_signature,
      updated_at = unixepoch()
  `);
  // Convert to strings to handle large numbers
  const balance = String(wallet.balance || 0);
  stmt.run(
    wallet.address,
    wallet.firstBuyTs,
    String(wallet.firstBuyAmount || 0),
    String(wallet.received || 0),
    String(wallet.sent || 0),
    balance,
    balance, // peak_balance = current on insert
    wallet.lastTxSig
  );
}

export async function getWallets(minBalance = 0) {
  const db = await getDb();
  // Use CAST to compare as integer, but return TEXT values
  const stmt = db.prepare('SELECT * FROM wallets WHERE CAST(current_balance AS INTEGER) >= ?');
  const rows = stmt.all(minBalance);
  // Parse string amounts back to BigInt for calculations
  return rows.map(row => ({
    ...row,
    first_buy_amount: BigInt(row.first_buy_amount || '0'),
    total_received: BigInt(row.total_received || '0'),
    total_sent: BigInt(row.total_sent || '0'),
    current_balance: BigInt(row.current_balance || '0'),
    peak_balance: BigInt(row.peak_balance || '0'),
  }));
}

/**
 * K_wallet Classification (same as K_token)
 * Based on retention (current / first_buy)
 * @param {number} retention - retention ratio
 * @returns {string} - accumulator | holder | reducer | extractor
 */
export function classifyWalletK(retention) {
  if (retention >= 1.5) return 'accumulator';  // Grew position 50%+
  if (retention >= 1.0) return 'holder';       // Maintained position
  if (retention >= 0.5) return 'reducer';      // Partial exit
  return 'extractor';                           // Major exit
}

/**
 * Get K-score for a specific wallet
 * K_wallet uses same retention as K_token: current / first_buy (uncapped)
 */
export async function getWalletKScore(address) {
  const db = await getDb();
  const stmt = db.prepare('SELECT * FROM wallets WHERE address = ?');
  const row = stmt.get(address);

  if (!row) {
    return null;
  }

  const currentBalance = BigInt(row.current_balance || '0');
  const firstBuyAmount = BigInt(row.first_buy_amount || '0');
  const totalSent = BigInt(row.total_sent || '0');

  // Calculate retention: current / first_buy (same as K_token, uncapped)
  let retention = 1.0;
  if (firstBuyAmount > 0n) {
    retention = Number(currentBalance) / Number(firstBuyAmount);
  }

  // Calculate hold days
  const now = Math.floor(Date.now() / 1000);
  const holdDays = row.first_buy_ts
    ? Math.floor((now - row.first_buy_ts) / 86400)
    : 0;

  // OG = early buyer (within first 21 days) AND held for 55+ days
  const isEarlyBuyer = row.first_buy_ts && row.first_buy_ts <= TOKEN_LAUNCH_TS + OG_EARLY_WINDOW;
  const hasHeldLongEnough = row.first_buy_ts && (now - row.first_buy_ts) >= OG_HOLD_THRESHOLD;
  const isOG = Boolean(isEarlyBuyer && hasHeldLongEnough);

  return {
    address: row.address,
    current_balance: currentBalance.toString(),
    first_buy_amount: firstBuyAmount.toString(),
    retention: Math.round(retention * 1000) / 1000, // 3 decimal precision
    classification: classifyWalletK(retention),
    neverSold: totalSent === 0n,
    holdDays,
    isOG,
    first_seen_at: row.first_buy_ts || row.updated_at,
    last_updated_at: row.updated_at,
  };
}

/**
 * Update wallet balance and track peak
 * Called by webhook and polling handlers
 */
export async function updateWalletBalance(address, newBalance) {
  const db = await getDb();
  const balanceStr = String(newBalance);

  const stmt = db.prepare(`
    INSERT INTO wallets (address, current_balance, peak_balance, updated_at)
    VALUES (?, ?, ?, unixepoch())
    ON CONFLICT(address) DO UPDATE SET
      current_balance = ?,
      peak_balance = CASE
        WHEN CAST(? AS INTEGER) > CAST(COALESCE(wallets.peak_balance, '0') AS INTEGER)
        THEN ?
        ELSE wallets.peak_balance
      END,
      updated_at = unixepoch()
  `);
  stmt.run(address, balanceStr, balanceStr, balanceStr, balanceStr, balanceStr);
}

export async function saveSnapshot(data) {
  const db = await getDb();
  const stmt = db.prepare(`
    INSERT INTO snapshots (k, holders, never_sold, never_sold_pct, accumulators, accumulators_pct, maintained, maintained_pct)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(data.k, data.holders, data.neverSold, data.neverSoldPct, data.accumulators, data.accumulatorsPct, data.maintained, data.maintainedPct);
}

export async function getSnapshots(limit = 30) {
  const db = await getDb();
  const stmt = db.prepare('SELECT * FROM snapshots ORDER BY created_at DESC LIMIT ?');
  return stmt.all(limit);
}

export async function getSyncState(key) {
  const db = await getDb();
  const stmt = db.prepare('SELECT value FROM sync_state WHERE key = ?');
  const row = stmt.get(key);
  return row?.value;
}

export async function setSyncState(key, value) {
  const db = await getDb();
  const stmt = db.prepare(`
    INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, unixepoch())
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()
  `);
  stmt.run(key, value);
}

export async function recordTransaction(tx) {
  const db = await getDb();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO transactions (signature, slot, block_time, wallet, amount_change)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(tx.signature, tx.slot || 0, tx.blockTime, tx.wallet, String(tx.amountChange || 0));
}

export async function getLastProcessedSlot() {
  const db = await getDb();
  const stmt = db.prepare('SELECT MAX(slot) as last_slot FROM transactions');
  const row = stmt.get();
  return row?.last_slot || 0;
}

export async function getLastProcessedSignature() {
  const db = await getDb();
  const stmt = db.prepare('SELECT signature FROM transactions ORDER BY block_time DESC LIMIT 1');
  const row = stmt.get();
  return row?.signature;
}

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

// ============================================
// K_wallet Queue System (scale-ready)
// ============================================

/**
 * Enqueue a wallet for K_wallet calculation
 * Uses UPSERT - if already queued, just updates priority
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
 * Returns null if queue is empty
 */
export async function dequeueKWallet() {
  const db = await getDb();
  const now = Math.floor(Date.now() / 1000);
  const lockDuration = 300; // 5 min lock

  // Get next unlocked item (highest priority first)
  const stmt = db.prepare(`
    SELECT address FROM k_wallet_queue
    WHERE locked_until IS NULL OR locked_until < ?
    ORDER BY priority DESC, created_at ASC
    LIMIT 1
  `);
  const row = stmt.get(now);

  if (!row) return null;

  // Lock it
  const lockStmt = db.prepare(`
    UPDATE k_wallet_queue SET locked_until = ? WHERE address = ?
  `);
  lockStmt.run(now + lockDuration, row.address);

  return row.address;
}

/**
 * Mark K_wallet calculation as complete
 * Removes from queue and updates wallets table
 * @param {string} address - Wallet address
 * @param {number|null} kWallet - K_wallet percentage (0-100)
 * @param {number} tokensAnalyzed - Number of tokens analyzed
 * @param {number} slot - PoH slot at time of calculation (for ordering)
 */
export async function completeKWallet(address, kWallet, tokensAnalyzed, slot = null) {
  const db = await getDb();

  // Update wallets table with PoH slot
  const updateStmt = db.prepare(`
    UPDATE wallets SET
      k_wallet = ?,
      k_wallet_tokens = ?,
      k_wallet_updated_at = unixepoch(),
      k_wallet_slot = ?
    WHERE address = ?
  `);
  updateStmt.run(kWallet, tokensAnalyzed, slot, address);

  // Remove from queue
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
 * Used on startup to reset pending tasks
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

/**
 * Get wallets that need K_wallet calculation (not yet calculated or stale)
 * Respects MIN_BALANCE filter - only process significant holders
 */
export async function getWalletsNeedingKWallet(limit = 100, maxAgeSeconds = 86400) {
  const db = await getDb();
  const minBalance = parseInt(process.env.MIN_BALANCE || '1000');

  // If maxAgeSeconds is -1, we only want wallets with NULL k_wallet_updated_at (never calculated)
  if (maxAgeSeconds === -1) {
    const stmt = db.prepare(`
      SELECT address FROM wallets
      WHERE CAST(current_balance AS INTEGER) >= ?
        AND k_wallet_updated_at IS NULL
      LIMIT ?
    `);
    return stmt.all(minBalance, limit).map(r => r.address);
  }

  const cutoff = Math.floor(Date.now() / 1000) - maxAgeSeconds;

  const stmt = db.prepare(`
    SELECT address FROM wallets
    WHERE CAST(current_balance AS INTEGER) >= ?
      AND (k_wallet_updated_at IS NULL OR k_wallet_updated_at < ?)
    ORDER BY k_wallet_updated_at ASC NULLS FIRST
    LIMIT ?
  `);
  return stmt.all(minBalance, cutoff, limit).map(r => r.address);
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

// ============================================
// Token K Score System (API v1)
// ============================================

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

  // Also create entry in tokens table if not exists
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
  const lockDuration = 600; // 10 min lock (token calc takes longer)

  const stmt = db.prepare(`
    SELECT mint FROM token_queue
    WHERE locked_until IS NULL OR locked_until < ?
    ORDER BY priority DESC, created_at ASC
    LIMIT 1
  `);
  const row = stmt.get(now);

  if (!row) return null;

  // Lock it and update tokens table
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

  // Update tokens table
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

  // Remove from queue
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
  getDb,
  upsertWallet,
  getWallets,
  saveSnapshot,
  getSnapshots,
  getSyncState,
  setSyncState,
  recordTransaction,
  getLastProcessedSlot,
  getLastProcessedSignature,
  getStats,
  // K_wallet functions
  classifyWalletK,
  getWalletKScore,
  updateWalletBalance,
  // K_wallet queue
  enqueueKWallet,
  enqueueKWalletBatch,
  dequeueKWallet,
  completeKWallet,
  failKWallet,
  cleanupKWalletQueue,
  clearKWalletQueue,
  getKWalletQueueStats,
  getWalletsNeedingKWallet,
  // Live feed
  getRecentTransactions,
  getDbSync,
  // Token K scoring (API v1)
  getToken,
  upsertToken,
  enqueueToken,
  dequeueToken,
  completeToken,
  failToken,
  getTokenQueueStats,
  cleanupTokenQueue,
};
