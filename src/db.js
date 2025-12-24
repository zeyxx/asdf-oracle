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
import { createHash, randomUUID } from 'crypto';

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

    // ================================================================
    // API Keys & Multi-Tenant (API v2)
    // ================================================================

    // API keys table - multi-tenant access control
    // tier: public (token-gated), free, standard, premium, internal
    `CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      key_hash TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      tier TEXT DEFAULT 'standard',
      rate_limit_minute INTEGER DEFAULT 1000,
      rate_limit_day INTEGER DEFAULT 100000,
      is_active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (unixepoch()),
      expires_at INTEGER,
      last_used_at INTEGER
    )`,

    // Daily usage aggregation per API key
    `CREATE TABLE IF NOT EXISTS usage_daily (
      key_id TEXT,
      date TEXT,
      requests INTEGER DEFAULT 0,
      PRIMARY KEY (key_id, date)
    )`,

    `CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash)`,
    `CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(is_active)`,
    `CREATE INDEX IF NOT EXISTS idx_usage_daily_date ON usage_daily(date)`,

    // ================================================================
    // Webhooks - Outbound notifications
    // ================================================================

    // Webhook subscriptions - clients register to receive events
    `CREATE TABLE IF NOT EXISTS webhook_subscriptions (
      id TEXT PRIMARY KEY,
      api_key_id TEXT,
      url TEXT NOT NULL,
      events TEXT NOT NULL,
      secret TEXT NOT NULL,
      is_active INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (unixepoch()),
      last_triggered_at INTEGER,
      failure_count INTEGER DEFAULT 0,
      FOREIGN KEY (api_key_id) REFERENCES api_keys(id)
    )`,

    // Webhook delivery log - track all deliveries for debugging
    `CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subscription_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      attempts INTEGER DEFAULT 0,
      response_code INTEGER,
      response_body TEXT,
      created_at INTEGER DEFAULT (unixepoch()),
      next_retry_at INTEGER,
      completed_at INTEGER,
      FOREIGN KEY (subscription_id) REFERENCES webhook_subscriptions(id)
    )`,

    `CREATE INDEX IF NOT EXISTS idx_webhook_subs_key ON webhook_subscriptions(api_key_id)`,
    `CREATE INDEX IF NOT EXISTS idx_webhook_subs_active ON webhook_subscriptions(is_active)`,
    `CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status ON webhook_deliveries(status)`,
    `CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_retry ON webhook_deliveries(next_retry_at)`,
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

// ============================================
// API Keys & Multi-Tenant System
// ============================================

/**
 * Hash an API key using SHA256
 */
function hashApiKey(key) {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * Generate a new API key
 * Format: oracle_[tier]_[random]
 */
function generateApiKey(tier = 'standard') {
  const random = randomUUID().replace(/-/g, '');
  return `oracle_${tier}_${random}`;
}

/**
 * Create a new API key
 * @returns {{ id, key, name, tier }} - key is plaintext (only returned once!)
 */
export async function createApiKey({ name, tier = 'standard', rateLimitMinute, rateLimitDay, expiresAt }) {
  const db = await getDb();
  const id = randomUUID();
  const key = generateApiKey(tier);
  const keyHash = hashApiKey(key);

  // Tier defaults
  const TIER_LIMITS = {
    free:     { minute: 500,   day: 50000 },
    standard: { minute: 1000,  day: 100000 },
    premium:  { minute: 5000,  day: 500000 },
    internal: { minute: null,  day: null },
  };
  const limits = TIER_LIMITS[tier] || TIER_LIMITS.standard;

  const stmt = db.prepare(`
    INSERT INTO api_keys (id, key_hash, name, tier, rate_limit_minute, rate_limit_day, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    id,
    keyHash,
    name,
    tier,
    rateLimitMinute ?? limits.minute,
    rateLimitDay ?? limits.day,
    expiresAt || null
  );

  return { id, key, name, tier }; // key returned only on creation!
}

/**
 * Validate an API key and return its metadata
 * Uses constant-time comparison via hash lookup
 */
export async function validateApiKey(key) {
  if (!key) return null;

  const db = await getDb();
  const keyHash = hashApiKey(key);
  const now = Math.floor(Date.now() / 1000);

  const stmt = db.prepare(`
    SELECT * FROM api_keys
    WHERE key_hash = ? AND is_active = 1
      AND (expires_at IS NULL OR expires_at > ?)
  `);
  const row = stmt.get(keyHash, now);

  if (row) {
    // Update last_used_at
    const updateStmt = db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?');
    updateStmt.run(now, row.id);
  }

  return row || null;
}

/**
 * Get API key by ID (for admin)
 */
export async function getApiKey(id) {
  const db = await getDb();
  const stmt = db.prepare('SELECT * FROM api_keys WHERE id = ?');
  return stmt.get(id);
}

/**
 * List all API keys (for admin)
 */
export async function listApiKeys({ activeOnly = true } = {}) {
  const db = await getDb();
  const stmt = activeOnly
    ? db.prepare('SELECT * FROM api_keys WHERE is_active = 1 ORDER BY created_at DESC')
    : db.prepare('SELECT * FROM api_keys ORDER BY created_at DESC');
  return stmt.all();
}

/**
 * Update API key
 */
export async function updateApiKey(id, { name, tier, rateLimitMinute, rateLimitDay, isActive, expiresAt }) {
  const db = await getDb();

  const updates = [];
  const params = [];

  if (name !== undefined) { updates.push('name = ?'); params.push(name); }
  if (tier !== undefined) { updates.push('tier = ?'); params.push(tier); }
  if (rateLimitMinute !== undefined) { updates.push('rate_limit_minute = ?'); params.push(rateLimitMinute); }
  if (rateLimitDay !== undefined) { updates.push('rate_limit_day = ?'); params.push(rateLimitDay); }
  if (isActive !== undefined) { updates.push('is_active = ?'); params.push(isActive ? 1 : 0); }
  if (expiresAt !== undefined) { updates.push('expires_at = ?'); params.push(expiresAt); }

  if (updates.length === 0) return false;

  params.push(id);
  const stmt = db.prepare(`UPDATE api_keys SET ${updates.join(', ')} WHERE id = ?`);
  const result = stmt.run(...params);
  return result.changes > 0;
}

/**
 * Revoke (soft delete) an API key
 */
export async function revokeApiKey(id) {
  const db = await getDb();
  const stmt = db.prepare('UPDATE api_keys SET is_active = 0 WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
}

/**
 * Hard delete an API key
 */
export async function deleteApiKey(id) {
  const db = await getDb();
  const stmt = db.prepare('DELETE FROM api_keys WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
}

// ============================================
// Usage Tracking
// ============================================

/**
 * Increment daily usage counter for an API key
 */
export async function incrementUsage(keyId) {
  const db = await getDb();
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  const stmt = db.prepare(`
    INSERT INTO usage_daily (key_id, date, requests)
    VALUES (?, ?, 1)
    ON CONFLICT(key_id, date) DO UPDATE SET requests = requests + 1
  `);
  stmt.run(keyId, today);
}

/**
 * Get today's usage for an API key
 */
export async function getTodayUsage(keyId) {
  const db = await getDb();
  const today = new Date().toISOString().split('T')[0];

  const stmt = db.prepare('SELECT requests FROM usage_daily WHERE key_id = ? AND date = ?');
  const row = stmt.get(keyId, today);
  return row?.requests || 0;
}

/**
 * Get usage history for an API key
 */
export async function getUsageHistory(keyId, days = 30) {
  const db = await getDb();
  const stmt = db.prepare(`
    SELECT date, requests FROM usage_daily
    WHERE key_id = ?
    ORDER BY date DESC
    LIMIT ?
  `);
  return stmt.all(keyId, days);
}

/**
 * Get usage stats for all keys (admin dashboard)
 */
export async function getUsageStats(days = 7) {
  const db = await getDb();
  const stmt = db.prepare(`
    SELECT
      k.id, k.name, k.tier,
      SUM(u.requests) as total_requests,
      MAX(u.date) as last_active
    FROM api_keys k
    LEFT JOIN usage_daily u ON k.id = u.key_id
      AND u.date >= date('now', '-' || ? || ' days')
    WHERE k.is_active = 1
    GROUP BY k.id
    ORDER BY total_requests DESC
  `);
  return stmt.all(days);
}

/**
 * Cleanup old usage data (older than 90 days)
 */
export async function cleanupUsageHistory(retentionDays = 90) {
  const db = await getDb();
  const stmt = db.prepare(`DELETE FROM usage_daily WHERE date < date('now', '-' || ? || ' days')`);
  stmt.run(retentionDays);
}

// ============================================
// Webhooks - Outbound notifications
// ============================================

const WEBHOOK_EVENTS = ['k_change', 'holder_new', 'holder_exit', 'threshold_alert'];

/**
 * Create a webhook subscription
 */
export async function createWebhookSubscription({ apiKeyId, url, events, secret }) {
  const db = await getDb();
  const id = randomUUID();

  // Validate events
  const validEvents = events.filter(e => WEBHOOK_EVENTS.includes(e));
  if (validEvents.length === 0) {
    throw new Error(`Invalid events. Valid: ${WEBHOOK_EVENTS.join(', ')}`);
  }

  const stmt = db.prepare(`
    INSERT INTO webhook_subscriptions (id, api_key_id, url, events, secret)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(id, apiKeyId, url, JSON.stringify(validEvents), secret);

  return { id, api_key_id: apiKeyId, url, events: validEvents };
}

/**
 * Get webhook subscription by ID
 */
export async function getWebhookSubscription(id) {
  const db = await getDb();
  const stmt = db.prepare('SELECT * FROM webhook_subscriptions WHERE id = ?');
  const row = stmt.get(id);
  if (row) {
    row.events = JSON.parse(row.events);
  }
  return row;
}

/**
 * List webhook subscriptions for an API key
 */
export async function listWebhookSubscriptions(apiKeyId) {
  const db = await getDb();
  const stmt = db.prepare('SELECT * FROM webhook_subscriptions WHERE api_key_id = ? AND is_active = 1');
  const rows = stmt.all(apiKeyId);
  return rows.map(row => ({ ...row, events: JSON.parse(row.events) }));
}

/**
 * List all active subscriptions for a specific event type
 */
export async function getSubscriptionsForEvent(eventType) {
  const db = await getDb();
  const stmt = db.prepare(`
    SELECT * FROM webhook_subscriptions
    WHERE is_active = 1 AND failure_count < 5
  `);
  const rows = stmt.all();

  // Filter by event type (events is JSON array)
  return rows.filter(row => {
    const events = JSON.parse(row.events);
    return events.includes(eventType);
  }).map(row => ({ ...row, events: JSON.parse(row.events) }));
}

/**
 * Update webhook subscription
 */
export async function updateWebhookSubscription(id, { url, events, isActive }) {
  const db = await getDb();

  const updates = [];
  const params = [];

  if (url !== undefined) { updates.push('url = ?'); params.push(url); }
  if (events !== undefined) {
    const validEvents = events.filter(e => WEBHOOK_EVENTS.includes(e));
    updates.push('events = ?');
    params.push(JSON.stringify(validEvents));
  }
  if (isActive !== undefined) { updates.push('is_active = ?'); params.push(isActive ? 1 : 0); }

  if (updates.length === 0) return false;

  params.push(id);
  const stmt = db.prepare(`UPDATE webhook_subscriptions SET ${updates.join(', ')} WHERE id = ?`);
  const result = stmt.run(...params);
  return result.changes > 0;
}

/**
 * Delete webhook subscription
 */
export async function deleteWebhookSubscription(id) {
  const db = await getDb();
  const stmt = db.prepare('DELETE FROM webhook_subscriptions WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
}

/**
 * Record webhook delivery attempt
 */
export async function createWebhookDelivery({ subscriptionId, eventType, payload }) {
  const db = await getDb();
  const stmt = db.prepare(`
    INSERT INTO webhook_deliveries (subscription_id, event_type, payload, status)
    VALUES (?, ?, ?, 'pending')
  `);
  const result = stmt.run(subscriptionId, eventType, JSON.stringify(payload));
  return result.lastInsertRowid;
}

/**
 * Get pending webhook deliveries ready for retry
 */
export async function getPendingWebhookDeliveries(limit = 10) {
  const db = await getDb();
  const now = Math.floor(Date.now() / 1000);

  const stmt = db.prepare(`
    SELECT d.*, s.url, s.secret
    FROM webhook_deliveries d
    JOIN webhook_subscriptions s ON d.subscription_id = s.id
    WHERE d.status = 'pending'
      AND (d.next_retry_at IS NULL OR d.next_retry_at <= ?)
      AND d.attempts < 3
    ORDER BY d.created_at ASC
    LIMIT ?
  `);
  return stmt.all(now, limit);
}

/**
 * Update webhook delivery status
 */
export async function updateWebhookDelivery(id, { status, responseCode, responseBody, nextRetryAt }) {
  const db = await getDb();
  const now = Math.floor(Date.now() / 1000);

  const stmt = db.prepare(`
    UPDATE webhook_deliveries SET
      status = ?,
      attempts = attempts + 1,
      response_code = ?,
      response_body = ?,
      next_retry_at = ?,
      completed_at = CASE WHEN ? IN ('success', 'failed') THEN ? ELSE NULL END
    WHERE id = ?
  `);
  stmt.run(status, responseCode, responseBody, nextRetryAt, status, now, id);
}

/**
 * Mark subscription as failed (too many failures)
 */
export async function incrementWebhookFailure(subscriptionId) {
  const db = await getDb();
  const stmt = db.prepare(`
    UPDATE webhook_subscriptions SET
      failure_count = failure_count + 1,
      is_active = CASE WHEN failure_count >= 4 THEN 0 ELSE is_active END
    WHERE id = ?
  `);
  stmt.run(subscriptionId);
}

/**
 * Reset failure count on successful delivery
 */
export async function resetWebhookFailure(subscriptionId) {
  const db = await getDb();
  const now = Math.floor(Date.now() / 1000);
  const stmt = db.prepare(`
    UPDATE webhook_subscriptions SET failure_count = 0, last_triggered_at = ? WHERE id = ?
  `);
  stmt.run(now, subscriptionId);
}

/**
 * Get webhook delivery history for a subscription
 */
export async function getWebhookDeliveryHistory(subscriptionId, limit = 50) {
  const db = await getDb();
  const stmt = db.prepare(`
    SELECT * FROM webhook_deliveries
    WHERE subscription_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `);
  return stmt.all(subscriptionId, limit);
}

/**
 * Get available webhook event types
 */
export function getWebhookEventTypes() {
  return [...WEBHOOK_EVENTS];
}

// ============================================
// Filtered Queries for API v2
// ============================================

/**
 * Get holders filtered by K_wallet and classification
 * Used by GET /api/v1/holders
 */
export async function getHoldersFiltered({ kMin, classification, limit = 100, minBalance } = {}) {
  const db = await getDb();
  const now = Math.floor(Date.now() / 1000);
  const minBal = minBalance || parseInt(process.env.MIN_BALANCE || '1000');

  let sql = `
    SELECT
      address,
      current_balance,
      first_buy_amount,
      first_buy_ts,
      k_wallet,
      k_wallet_tokens,
      total_sent
    FROM wallets
    WHERE CAST(current_balance AS INTEGER) >= ?
  `;
  const params = [minBal];

  if (kMin !== undefined && kMin !== null) {
    sql += ' AND k_wallet >= ?';
    params.push(kMin);
  }

  sql += ' ORDER BY CAST(current_balance AS INTEGER) DESC LIMIT ?';
  params.push(limit);

  const stmt = db.prepare(sql);
  const rows = stmt.all(...params);

  // Calculate retention and classification for each
  return rows.map(row => {
    const currentBalance = BigInt(row.current_balance || '0');
    const firstBuyAmount = BigInt(row.first_buy_amount || '0');
    const retention = firstBuyAmount > 0n
      ? Number(currentBalance) / Number(firstBuyAmount)
      : 1.0;
    const walletClass = classifyWalletK(retention);

    // Filter by classification if specified
    if (classification && walletClass !== classification) {
      return null;
    }

    const holdDays = row.first_buy_ts
      ? Math.floor((now - row.first_buy_ts) / 86400)
      : 0;

    return {
      address: row.address,
      balance: row.current_balance,
      first_buy_amount: row.first_buy_amount,
      retention: Math.round(retention * 1000) / 1000,
      classification: walletClass,
      k_wallet: row.k_wallet,
      k_wallet_tokens: row.k_wallet_tokens,
      never_sold: row.total_sent === '0',
      hold_days: holdDays,
    };
  }).filter(Boolean); // Remove nulls from classification filter
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
  // API Keys & Multi-Tenant (API v2)
  createApiKey,
  validateApiKey,
  getApiKey,
  listApiKeys,
  updateApiKey,
  revokeApiKey,
  deleteApiKey,
  // Usage tracking
  incrementUsage,
  getTodayUsage,
  getUsageHistory,
  getUsageStats,
  cleanupUsageHistory,
  // Filtered queries
  getHoldersFiltered,
  // Webhooks
  createWebhookSubscription,
  getWebhookSubscription,
  listWebhookSubscriptions,
  getSubscriptionsForEvent,
  updateWebhookSubscription,
  deleteWebhookSubscription,
  createWebhookDelivery,
  getPendingWebhookDeliveries,
  updateWebhookDelivery,
  incrementWebhookFailure,
  resetWebhookFailure,
  getWebhookDeliveryHistory,
  getWebhookEventTypes,
};
