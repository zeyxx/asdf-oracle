/**
 * Wallet Database Operations
 *
 * CRUD operations for wallet data and K-score calculations.
 */

import { getDb, getDbSync } from './connection.js';

// OG configuration
const TOKEN_LAUNCH_TS = parseInt(process.env.TOKEN_LAUNCH_TS || '0');
const OG_EARLY_WINDOW = parseInt(process.env.OG_EARLY_WINDOW || '21') * 86400;
const OG_HOLD_THRESHOLD = parseInt(process.env.OG_HOLD_THRESHOLD || '55') * 86400;

/**
 * K_wallet Classification
 * Based on retention (current / first_buy)
 */
export function classifyWalletK(retention) {
  if (retention >= 1.5) return 'accumulator';
  if (retention >= 1.0) return 'holder';
  if (retention >= 0.5) return 'reducer';
  return 'extractor';
}

/**
 * Upsert wallet data
 */
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
  const balance = String(wallet.balance || 0);
  stmt.run(
    wallet.address,
    wallet.firstBuyTs,
    String(wallet.firstBuyAmount || 0),
    String(wallet.received || 0),
    String(wallet.sent || 0),
    balance,
    balance,
    wallet.lastTxSig
  );
}

/**
 * Get all wallets above minimum balance
 */
export async function getWallets(minBalance = 0) {
  const db = await getDb();
  const stmt = db.prepare('SELECT * FROM wallets WHERE CAST(current_balance AS INTEGER) >= ?');
  const rows = stmt.all(minBalance);
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
 * Get K-score for a specific wallet
 */
export async function getWalletKScore(address) {
  const db = await getDb();
  const stmt = db.prepare('SELECT * FROM wallets WHERE address = ?');
  const row = stmt.get(address);

  if (!row) return null;

  const currentBalance = BigInt(row.current_balance || '0');
  const firstBuyAmount = BigInt(row.first_buy_amount || '0');
  const totalSent = BigInt(row.total_sent || '0');

  let retention = 1.0;
  if (firstBuyAmount > 0n) {
    retention = Number(currentBalance) / Number(firstBuyAmount);
  }

  const now = Math.floor(Date.now() / 1000);
  const holdDays = row.first_buy_ts
    ? Math.floor((now - row.first_buy_ts) / 86400)
    : 0;

  const isEarlyBuyer = row.first_buy_ts && row.first_buy_ts <= TOKEN_LAUNCH_TS + OG_EARLY_WINDOW;
  const hasHeldLongEnough = row.first_buy_ts && (now - row.first_buy_ts) >= OG_HOLD_THRESHOLD;
  const isOG = Boolean(isEarlyBuyer && hasHeldLongEnough);

  return {
    address: row.address,
    current_balance: currentBalance.toString(),
    first_buy_amount: firstBuyAmount.toString(),
    retention: Math.round(retention * 1000) / 1000,
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

/**
 * Get wallets that need K_wallet calculation
 */
export async function getWalletsNeedingKWallet(limit = 100, maxAgeSeconds = 86400) {
  const db = await getDb();
  const minBalance = parseInt(process.env.MIN_BALANCE || '1000');

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
 * Get holders filtered by K_wallet and classification
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

  return rows.map(row => {
    const currentBalance = BigInt(row.current_balance || '0');
    const firstBuyAmount = BigInt(row.first_buy_amount || '0');
    const retention = firstBuyAmount > 0n
      ? Number(currentBalance) / Number(firstBuyAmount)
      : 1.0;
    const walletClass = classifyWalletK(retention);

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
  }).filter(Boolean);
}

export default {
  classifyWalletK,
  upsertWallet,
  getWallets,
  getWalletKScore,
  updateWalletBalance,
  getWalletsNeedingKWallet,
  getHoldersFiltered,
};
