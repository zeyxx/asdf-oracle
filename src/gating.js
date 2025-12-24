/**
 * Holder Gating Module
 *
 * Controls access to privileged features based on $asdfasdfa holder status.
 *
 * Design Principles:
 * - Security by design: fail closed on errors, verify before granting access
 * - Modular: extensible for different access tiers and features
 * - No single point of failure: fallback to Helius RPC if local DB unavailable
 *
 * Features:
 * - K_wallet global: requires holding $asdfasdfa tokens
 * - Configurable minimum balance
 * - Can be disabled via env flag
 * - Fallback verification via Helius RPC
 */

import { timingSafeEqual } from 'crypto';
import db from './db.js';
import helius from './helius.js';
import { log } from './utils.js';

const TOKEN_MINT = process.env.TOKEN_MINT;

/**
 * Get gating config (read dynamically to support runtime changes)
 */
function getConfig() {
  return {
    enabled: process.env.K_GLOBAL_GATED !== 'false', // Default: enabled
    minBalance: BigInt(process.env.K_GLOBAL_MIN_BALANCE || '1'),
    failClosed: process.env.K_GLOBAL_FAIL_CLOSED !== 'false', // Default: fail closed (secure)
    adminKey: process.env.ADMIN_API_KEY || null // Admin bypass key
  };
}

/**
 * Verify admin API key for bypass mode
 * Uses crypto.timingSafeEqual to prevent timing attacks
 * @param {string} apiKey - The API key from request header
 * @returns {boolean}
 */
export function verifyAdminKey(apiKey) {
  const config = getConfig();
  if (!config.adminKey) return false;
  if (!apiKey) return false;

  // Constant-time comparison using Node.js crypto (standard pattern)
  const keyBuffer = Buffer.from(config.adminKey, 'utf8');
  const inputBuffer = Buffer.from(apiKey, 'utf8');

  // Length check must be done, but pad to same length to avoid timing leak
  if (keyBuffer.length !== inputBuffer.length) {
    // Compare with dummy to maintain constant time
    timingSafeEqual(keyBuffer, keyBuffer);
    return false;
  }

  return timingSafeEqual(keyBuffer, inputBuffer);
}

/**
 * Fallback: verify holder via Helius RPC (no single point of failure)
 * Used when local DB is unavailable
 */
async function verifyHolderViaRPC(address) {
  try {
    log('DEBUG', `[Gating] Fallback RPC verification for ${address.slice(0, 8)}`);

    const result = await helius.rpc('getTokenAccountsByOwner', [
      address,
      { mint: TOKEN_MINT },
      { encoding: 'jsonParsed' }
    ]);

    if (!result?.value || result.value.length === 0) {
      return { holds: false, balance: 0n };
    }

    const account = result.value[0];
    const balance = BigInt(account.account?.data?.parsed?.info?.tokenAmount?.amount || '0');

    return { holds: balance > 0n, balance };
  } catch (error) {
    log('ERROR', `[Gating] RPC fallback failed: ${error.message}`);
    return null; // Fallback also failed
  }
}

/**
 * Check if wallet has access to K_wallet global feature
 * @param {string} address - Wallet address to check
 * @param {object} options - Options { adminKey: string }
 * @returns {Promise<{allowed: boolean, reason: string, ...}>}
 */
export async function checkKGlobalAccess(address, options = {}) {
  const config = getConfig();

  // Admin bypass - allows fetching any wallet's K_wallet
  if (options.adminKey && verifyAdminKey(options.adminKey)) {
    log('INFO', `[Gating] Admin bypass for ${address.slice(0, 8)}`);
    return {
      allowed: true,
      reason: 'admin_bypass',
      message: 'Admin access granted'
    };
  }

  // Gating disabled = allow all
  if (!config.enabled) {
    return {
      allowed: true,
      reason: 'gating_disabled',
      message: 'Gating is disabled, all wallets have access'
    };
  }

  try {
    // Check if wallet holds $asdfasdfa
    const kScore = await db.getWalletKScore(address);

    if (!kScore) {
      log('DEBUG', `[Gating] Access denied for ${address.slice(0, 8)}: not a holder`);
      return {
        allowed: false,
        reason: 'not_holder',
        message: 'Must hold $asdfasdfa to access K_wallet global',
        required: config.minBalance.toString()
      };
    }

    const balance = BigInt(kScore.current_balance);

    if (balance < config.minBalance) {
      log('DEBUG', `[Gating] Access denied for ${address.slice(0, 8)}: insufficient balance (${balance})`);
      return {
        allowed: false,
        reason: 'insufficient_balance',
        message: `Must hold at least ${config.minBalance} tokens`,
        current: balance.toString(),
        required: config.minBalance.toString()
      };
    }

    log('DEBUG', `[Gating] Access granted for ${address.slice(0, 8)} (balance: ${balance})`);
    return {
      allowed: true,
      reason: 'holder_verified',
      balance: balance.toString(),
      classification: kScore.classification,
      isOG: kScore.isOG
    };
  } catch (error) {
    log('WARN', `[Gating] DB check failed: ${error.message}, trying RPC fallback`);

    // Fallback to Helius RPC (no single point of failure)
    const rpcResult = await verifyHolderViaRPC(address);

    if (rpcResult !== null) {
      if (!rpcResult.holds || rpcResult.balance < config.minBalance) {
        return {
          allowed: false,
          reason: 'not_holder',
          message: 'Must hold $asdfasdfa to access K_wallet global',
          required: config.minBalance.toString(),
          source: 'rpc_fallback'
        };
      }
      return {
        allowed: true,
        reason: 'holder_verified',
        balance: rpcResult.balance.toString(),
        source: 'rpc_fallback'
      };
    }

    // Both DB and RPC failed - security by design: fail closed
    if (config.failClosed) {
      log('ERROR', `[Gating] All verification failed, failing closed`);
      return {
        allowed: false,
        reason: 'verification_unavailable',
        message: 'Unable to verify holder status. Please try again.',
        source: 'fail_closed'
      };
    }

    // Fail open only if explicitly configured (not recommended)
    log('WARN', `[Gating] All verification failed, failing open (not recommended)`);
    return {
      allowed: true,
      reason: 'error_fallback',
      message: 'Verification unavailable, access granted (fail_open mode)',
      source: 'fail_open'
    };
  }
}

/**
 * Get gating configuration status
 */
export function getGatingStatus() {
  const config = getConfig();
  return {
    k_global: {
      enabled: config.enabled,
      min_balance: config.minBalance.toString(),
      fail_closed: config.failClosed,
      fallback: 'helius_rpc',
      admin_bypass: config.adminKey !== null
    }
  };
}

/**
 * Check if gating is enabled
 */
export function isGatingEnabled() {
  return getConfig().enabled;
}

export default {
  checkKGlobalAccess,
  getGatingStatus,
  isGatingEnabled,
  verifyAdminKey
};
