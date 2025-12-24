/**
 * Database Connection & Migrations
 *
 * Handles SQLite initialization (Node.js 22+ native or better-sqlite3 fallback).
 * Exports shared database instance for all db modules.
 */

import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');
const DB_PATH = join(DATA_DIR, 'k-metric.db');

// Ensure data directory exists
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

// Shared database instance
let db = null;

/**
 * Initialize database connection with performance optimizations
 */
export async function initDb() {
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

  // Apply performance optimizations
  applyOptimizations();

  // Run migrations
  migrate();
  return db;
}

/**
 * Apply SQLite performance optimizations for high concurrency
 */
function applyOptimizations() {
  const optimizations = [
    // WAL mode: allows concurrent reads during writes
    'PRAGMA journal_mode = WAL',
    // Busy timeout: wait up to 5 seconds for locks
    'PRAGMA busy_timeout = 5000',
    // Synchronous NORMAL: good balance of safety and speed
    'PRAGMA synchronous = NORMAL',
    // Memory-mapped I/O: faster reads (256MB)
    'PRAGMA mmap_size = 268435456',
    // Cache size: 64MB in memory
    'PRAGMA cache_size = -64000',
    // Temp store in memory
    'PRAGMA temp_store = MEMORY',
    // Enable foreign keys
    'PRAGMA foreign_keys = ON',
  ];

  for (const pragma of optimizations) {
    try {
      if (db.exec) {
        db.exec(pragma);
      } else if (db.run) {
        db.run(pragma);
      }
    } catch (e) {
      console.warn(`[DB] Pragma failed: ${pragma} - ${e.message}`);
    }
  }

  console.log('[DB] Performance optimizations applied (WAL mode, 64MB cache)');
}

/**
 * Run database migrations
 */
function migrate() {
  const migrations = [
    // Wallets table - stores per-wallet token history
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

    // Migration: Add peak_balance column
    `ALTER TABLE wallets ADD COLUMN peak_balance TEXT DEFAULT '0'`,

    // Migration: Backfill peak_balance
    `UPDATE wallets SET peak_balance =
      CASE
        WHEN CAST(current_balance AS INTEGER) > CAST(COALESCE(first_buy_amount, '0') AS INTEGER)
        THEN current_balance
        ELSE COALESCE(first_buy_amount, current_balance)
      END
    WHERE peak_balance = '0' OR peak_balance IS NULL`,

    // Transactions table
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

    // Sync state
    `CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at INTEGER DEFAULT (unixepoch())
    )`,

    // K_wallet columns
    `ALTER TABLE wallets ADD COLUMN k_wallet INTEGER DEFAULT NULL`,
    `ALTER TABLE wallets ADD COLUMN k_wallet_tokens INTEGER DEFAULT NULL`,
    `ALTER TABLE wallets ADD COLUMN k_wallet_updated_at INTEGER DEFAULT NULL`,
    `ALTER TABLE wallets ADD COLUMN k_wallet_slot INTEGER DEFAULT NULL`,

    // K_wallet job queue
    `CREATE TABLE IF NOT EXISTS k_wallet_queue (
      address TEXT PRIMARY KEY,
      priority INTEGER DEFAULT 0,
      attempts INTEGER DEFAULT 0,
      last_error TEXT,
      created_at INTEGER DEFAULT (unixepoch()),
      locked_until INTEGER DEFAULT NULL
    )`,

    // Tokens registry
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

    // Token K calculation queue
    `CREATE TABLE IF NOT EXISTS token_queue (
      mint TEXT PRIMARY KEY,
      priority INTEGER DEFAULT 0,
      attempts INTEGER DEFAULT 0,
      last_error TEXT,
      created_at INTEGER DEFAULT (unixepoch()),
      locked_until INTEGER DEFAULT NULL
    )`,

    // API keys table
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

    // Daily usage aggregation
    `CREATE TABLE IF NOT EXISTS usage_daily (
      key_id TEXT,
      date TEXT,
      requests INTEGER DEFAULT 0,
      PRIMARY KEY (key_id, date)
    )`,

    // Webhook subscriptions
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

    // Webhook delivery log
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

    // Indexes
    `CREATE INDEX IF NOT EXISTS idx_wallets_balance ON wallets(current_balance)`,
    `CREATE INDEX IF NOT EXISTS idx_wallets_peak ON wallets(peak_balance)`,
    `CREATE INDEX IF NOT EXISTS idx_wallets_k_wallet ON wallets(k_wallet)`,
    `CREATE INDEX IF NOT EXISTS idx_transactions_wallet ON transactions(wallet)`,
    `CREATE INDEX IF NOT EXISTS idx_transactions_time ON transactions(block_time)`,
    `CREATE INDEX IF NOT EXISTS idx_transactions_slot ON transactions(slot)`,
    `CREATE INDEX IF NOT EXISTS idx_snapshots_time ON snapshots(created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_k_wallet_queue_next ON k_wallet_queue(locked_until, priority DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_tokens_tier ON tokens(tier)`,
    `CREATE INDEX IF NOT EXISTS idx_tokens_sync ON tokens(last_sync)`,
    `CREATE INDEX IF NOT EXISTS idx_token_queue_next ON token_queue(locked_until, priority DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash)`,
    `CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(is_active)`,
    `CREATE INDEX IF NOT EXISTS idx_usage_daily_date ON usage_daily(date)`,
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
      // Migration might already be applied, ignore
    }
  }

  console.log('[DB] Migrations complete');
}

/**
 * In-memory fallback database
 */
function createMemoryDb() {
  return {
    prepare: (sql) => ({
      run: (...params) => {
        console.log('[MemDB] Run:', sql.substring(0, 50));
      },
      get: (...params) => null,
      all: (...params) => [],
    }),
    exec: (sql) => console.log('[MemDB] Exec:', sql.substring(0, 50)),
  };
}

/**
 * Get database instance (async)
 */
export async function getDb() {
  return await initDb();
}

/**
 * Get database instance (sync - for already initialized db)
 */
export function getDbSync() {
  return db;
}

export default { initDb, getDb, getDbSync };
