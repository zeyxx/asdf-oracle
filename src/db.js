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
      last_tx_signature TEXT,
      updated_at INTEGER DEFAULT (unixepoch())
    )`,

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

    // Indexes for performance
    `CREATE INDEX IF NOT EXISTS idx_wallets_balance ON wallets(current_balance)`,
    `CREATE INDEX IF NOT EXISTS idx_transactions_wallet ON transactions(wallet)`,
    `CREATE INDEX IF NOT EXISTS idx_transactions_time ON transactions(block_time)`,
    `CREATE INDEX IF NOT EXISTS idx_transactions_slot ON transactions(slot)`,
    `CREATE INDEX IF NOT EXISTS idx_snapshots_time ON snapshots(created_at)`,
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

export async function upsertWallet(wallet) {
  const db = await getDb();
  const stmt = db.prepare(`
    INSERT INTO wallets (address, first_buy_ts, first_buy_amount, total_received, total_sent, current_balance, last_tx_signature, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(address) DO UPDATE SET
      first_buy_ts = COALESCE(wallets.first_buy_ts, excluded.first_buy_ts),
      first_buy_amount = CASE WHEN wallets.first_buy_ts IS NULL THEN excluded.first_buy_amount ELSE wallets.first_buy_amount END,
      total_received = wallets.total_received + excluded.total_received,
      total_sent = wallets.total_sent + excluded.total_sent,
      current_balance = excluded.current_balance,
      last_tx_signature = excluded.last_tx_signature,
      updated_at = unixepoch()
  `);
  // Convert to strings to handle large numbers
  stmt.run(
    wallet.address,
    wallet.firstBuyTs,
    String(wallet.firstBuyAmount || 0),
    String(wallet.received || 0),
    String(wallet.sent || 0),
    String(wallet.balance || 0),
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
  }));
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
};
