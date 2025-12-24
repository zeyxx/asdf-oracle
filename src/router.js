/**
 * K-Metric Express Router
 *
 * Plug-and-play router for integration into any Express app.
 *
 * Usage:
 *   import kMetricRouter from './k-metric-module/src/router.js';
 *   app.use('/api', kMetricRouter);
 */

import db from './db.js';
import calculator from './calculator.js';
import helius from './helius.js';
import webhook from './webhook.js';
import sync from './sync.js';
import walletScore from './wallet-score.js';
import tokenScore from './token-score.js';
import gating from './gating.js';
import { loadEnv, log } from './utils.js';
import webhooks from './webhooks.js';

loadEnv();

import security from './security.js';

// API Key for service authentication (ASDev, etc.)
const ORACLE_API_KEY = process.env.ORACLE_API_KEY || process.env.ADMIN_API_KEY;

// Maintenance mode flag (set MAINTENANCE=1 to enable)
const MAINTENANCE_MODE = process.env.MAINTENANCE === '1' || process.env.MAINTENANCE === 'true';

// Simple router implementation (no Express dependency)
const routes = {
  'GET /k-metric': handleGetKMetric,
  'GET /k-metric/history': handleGetHistory,
  'GET /k-metric/holders': handleGetHolders,
  'GET /k-metric/stats': handleGetStats,
  'GET /k-metric/status': handleGetStatus,
  'GET /k-metric/live': handleGetLiveFeed,
  'GET /k-metric/health': handleHealth,
  'POST /k-metric/webhook': handleWebhook,
  'POST /k-metric/sync': handleSync,
  'POST /k-metric/backup': handleBackup,
  // Admin routes
  'POST /k-metric/admin/batch-k': handleAdminBatchK,
  'POST /k-metric/admin/backfill-k-wallet': handleAdminBackfillKWallet,
  'GET /k-metric/admin/k-wallet-queue': handleAdminKWalletQueue,
  // Admin - API Key Management
  'POST /k-metric/admin/api-keys': handleAdminCreateApiKey,
  'GET /k-metric/admin/api-keys': handleAdminListApiKeys,
  'GET /k-metric/admin/usage-stats': handleAdminUsageStats,
  // API v1 - Oracle endpoints for ASDev
  'GET /api/v1/status': handleApiV1Status,
  'GET /api/v1/holders': handleApiV1Holders,
  'POST /api/v1/wallets': handleApiV1WalletsBatch,
  'POST /api/v1/tokens': handleApiV1TokensBatch,
  // API v1 - Webhooks
  'GET /api/v1/webhooks': handleApiV1ListWebhooks,
  'POST /api/v1/webhooks': handleApiV1CreateWebhook,
  'GET /api/v1/webhooks/events': handleApiV1WebhookEvents,
};

// Dynamic routes (with parameters)
const dynamicRoutes = [
  { pattern: /^GET \/k-metric\/wallet\/([A-Za-z0-9]{32,44})\/k-score$/, handler: handleGetWalletKScore },
  { pattern: /^GET \/k-metric\/wallet\/([A-Za-z0-9]{32,44})\/k-global$/, handler: handleGetWalletKGlobal },
  // Admin - API Key Management (dynamic)
  { pattern: /^DELETE \/k-metric\/admin\/api-keys\/([a-f0-9-]{36})$/, handler: handleAdminRevokeApiKey },
  { pattern: /^GET \/k-metric\/admin\/api-keys\/([a-f0-9-]{36})\/usage$/, handler: handleAdminApiKeyUsage },
  // API v1 - Token K score (any PumpFun/Ignition token)
  { pattern: /^GET \/api\/v1\/token\/([A-Za-z0-9]{32,44})$/, handler: handleApiV1Token },
  // API v1 - Wallet K score
  { pattern: /^GET \/api\/v1\/wallet\/([A-Za-z0-9]{32,44})$/, handler: handleApiV1Wallet },
  // API v1 - Webhooks (dynamic)
  { pattern: /^GET \/api\/v1\/webhooks\/([a-f0-9-]{36})$/, handler: handleApiV1GetWebhook },
  { pattern: /^DELETE \/api\/v1\/webhooks\/([a-f0-9-]{36})$/, handler: handleApiV1DeleteWebhook },
  { pattern: /^GET \/api\/v1\/webhooks\/([a-f0-9-]{36})\/deliveries$/, handler: handleApiV1WebhookDeliveries },
];

/**
 * GET /k-metric - Get current K-metric
 */
async function handleGetKMetric(req, res) {
  try {
    const data = await calculator.calculate();

    if (!data) {
      return sendJson(res, 503, { error: 'No data available. Run backfill first.' });
    }

    // Add token info
    const tokenInfo = await helius.fetchTokenInfo();
    data.token = tokenInfo;

    sendJson(res, 200, data);
  } catch (error) {
    log('ERROR', `K-metric error: ${error.message}`);
    sendJson(res, 500, { error: error.message });
  }
}

/**
 * GET /k-metric/history - Get historical snapshots
 */
async function handleGetHistory(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const days = parseInt(url.searchParams.get('days') || '30');

    const history = await calculator.getHistory(days);
    sendJson(res, 200, { history, count: history.length });
  } catch (error) {
    log('ERROR', `History error: ${error.message}`);
    sendJson(res, 500, { error: error.message });
  }
}

/**
 * GET /k-metric/holders - Get holder list with stats
 * Includes pool detection for DEX liquidity pools
 * MIN_BALANCE is dynamic: $1 worth of tokens at current price
 */
async function handleGetHolders(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const limit = parseInt(url.searchParams.get('limit') || '100');
    const excludePools = url.searchParams.get('exclude_pools') === 'true';
    const minUsd = parseFloat(url.searchParams.get('min_usd') || '1'); // Default $1

    // Dynamic MIN_BALANCE based on current price
    const tokenInfo = await helius.fetchTokenInfo();
    const price = tokenInfo.price || 0.0000001; // Fallback to avoid division by zero
    // tokens = $1 / price, then multiply by 1e6 for raw units (6 decimals)
    const minBalance = Math.floor((minUsd / price) * 1e6);

    const wallets = await db.getWallets(minBalance);

    const now = Math.floor(Date.now() / 1000);
    const TOKEN_LAUNCH_TS = parseInt(process.env.TOKEN_LAUNCH_TS || '0');
    const OG_EARLY_WINDOW = parseInt(process.env.OG_EARLY_WINDOW || '21') * 86400;
    const OG_HOLD_THRESHOLD = parseInt(process.env.OG_HOLD_THRESHOLD || '55') * 86400;

    // Sort by balance (BigInt comparison)
    const sortedWallets = wallets
      .sort((a, b) => (b.current_balance > a.current_balance ? 1 : b.current_balance < a.current_balance ? -1 : 0));

    // Take top N for pool detection (limit + buffer for potential pools)
    const topAddresses = sortedWallets.slice(0, Math.min(limit + 20, sortedWallets.length)).map(w => w.address);

    // Batch check for pools
    const poolResults = await helius.batchCheckPools(topAddresses);

    // Map and filter
    let sorted = sortedWallets.map((w) => {
      const holdDays = w.first_buy_ts ? Math.floor((now - w.first_buy_ts) / 86400) : 0;
      const isEarlyBuyer = w.first_buy_ts && w.first_buy_ts <= TOKEN_LAUNCH_TS + OG_EARLY_WINDOW;
      const hasHeldLongEnough = w.first_buy_ts && (now - w.first_buy_ts) >= OG_HOLD_THRESHOLD;
      const retention = w.first_buy_amount > 0n
        ? Math.round(Number(w.current_balance) / Number(w.first_buy_amount) * 1000) / 1000
        : 1.0;

      // Same classification as K_token
      const classification = retention >= 1.5 ? 'accumulator'
        : retention >= 1.0 ? 'holder'
        : retention >= 0.5 ? 'reducer'
        : 'extractor';

      // Pool detection
      const poolInfo = poolResults.get(w.address);
      const isPool = poolInfo?.isPool || false;

      return {
        address: w.address,
        balance: w.current_balance.toString(),
        firstBuyAmount: w.first_buy_amount.toString(),
        retention,
        classification,
        neverSold: w.total_sent === 0n,
        holdDays,
        isOG: Boolean(isEarlyBuyer && hasHeldLongEnough),
        isPool,
        poolProgram: poolInfo?.program || null,
        // K_wallet global (from DB, null if not yet calculated)
        k_wallet: w.k_wallet,
        k_wallet_tokens: w.k_wallet_tokens,
        k_wallet_slot: w.k_wallet_slot,
      };
    });

    // Optionally exclude pools
    if (excludePools) {
      sorted = sorted.filter(h => !h.isPool);
    }

    // Apply limit after potential filtering
    sorted = sorted.slice(0, limit);

    // Count holders with K_wallet calculated
    const withKWallet = sorted.filter(h => h.k_wallet !== null).length;
    const poolCount = sorted.filter(h => h.isPool).length;

    sendJson(res, 200, {
      holders: sorted,
      total: wallets.length,
      pools_detected: poolCount,
      filter: {
        min_usd: minUsd,
        price: price,
        min_balance_raw: minBalance,
        min_balance_tokens: minBalance / 1e6,
      },
      k_wallet_coverage: {
        calculated: withKWallet,
        pending: sorted.length - withKWallet,
      }
    });
  } catch (error) {
    log('ERROR', `Holders error: ${error.message}`);
    sendJson(res, 500, { error: error.message });
  }
}

/**
 * GET /k-metric/stats - Get database stats including PoH slot
 */
async function handleGetStats(req, res) {
  try {
    const stats = await db.getStats();
    const lastSlot = await db.getLastProcessedSlot();

    sendJson(res, 200, {
      ...stats,
      lastProcessedSlot: lastSlot,
      poh: {
        slot: lastSlot,
        description: 'Solana Proof of History slot - monotonically increasing ordering key',
      },
    });
  } catch (error) {
    log('ERROR', `Stats error: ${error.message}`);
    sendJson(res, 500, { error: error.message });
  }
}

/**
 * GET /k-metric/status - Get sync status
 */
async function handleGetStatus(req, res) {
  try {
    const status = await sync.getStatus();
    const kMetric = await calculator.calculate();
    const gatingStatus = gating.getGatingStatus();

    sendJson(res, 200, {
      sync: status,
      k: kMetric?.k || 0,
      holders: kMetric?.holders || 0,
      mode: 'hybrid',
      description: 'Webhook (real-time) + Polling (5min fallback)',
      gating: gatingStatus,
      queue: walletScore.getQueueStats(),
      maintenance: MAINTENANCE_MODE,
    });
  } catch (error) {
    log('ERROR', `Status error: ${error.message}`);
    sendJson(res, 500, { error: error.message });
  }
}

/**
 * GET /k-metric/live - Live transaction feed
 */
async function handleGetLiveFeed(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '10'), 50);

    const transactions = db.getRecentTransactions(limit);
    const decimals = parseInt(process.env.TOKEN_DECIMALS || '6');

    const formatted = transactions.map(tx => ({
      signature: tx.signature,
      slot: tx.slot,
      wallet: tx.wallet,
      amount: tx.amount_change ? (parseInt(tx.amount_change) / Math.pow(10, decimals)).toFixed(2) : '0',
      type: tx.amount_change && parseInt(tx.amount_change) > 0 ? 'buy' : 'sell',
      time: tx.block_time,
      ago: tx.block_time ? Math.floor(Date.now() / 1000) - tx.block_time : null,
    }));

    sendJson(res, 200, { transactions: formatted });
  } catch (error) {
    log('ERROR', `Live feed error: ${error.message}`);
    sendJson(res, 500, { error: error.message });
  }
}

/**
 * GET /k-metric/health - Health check endpoint
 */
async function handleHealth(req, res) {
  try {
    const stats = await db.getStats();
    const lastSlot = await db.getLastProcessedSlot();
    const backups = security.listBackups();

    const healthy = stats.wallets > 0 && lastSlot > 0;

    sendJson(res, healthy ? 200 : 503, {
      status: healthy ? 'healthy' : 'degraded',
      checks: {
        database: stats.wallets > 0 ? 'ok' : 'empty',
        sync: lastSlot > 0 ? 'ok' : 'not_synced',
        backups: backups.length > 0 ? 'ok' : 'no_backups',
      },
      lastSlot,
      wallets: stats.wallets,
      lastBackup: backups[0]?.created || null,
      uptime: process.uptime(),
    });
  } catch (error) {
    sendJson(res, 503, { status: 'error', error: error.message });
  }
}

/**
 * GET /wallet/:address/k-score - Get K-score for a specific wallet (this token only)
 */
async function handleGetWalletKScore(req, res, params) {
  try {
    const address = params[0];

    // Validate Solana address format
    if (!security.validateAddress(address)) {
      return sendJson(res, 400, { error: 'Invalid wallet address format' });
    }

    const kScore = await db.getWalletKScore(address);

    if (!kScore) {
      return sendJson(res, 404, {
        error: 'Wallet not found',
        address,
        message: 'This wallet has no recorded history for this token',
      });
    }

    sendJson(res, 200, kScore);
  } catch (error) {
    log('ERROR', `Wallet K-score error: ${error.message}`);
    sendJson(res, 500, { error: error.message });
  }
}

/**
 * GET /wallet/:address/k-global - Get global K-score across all PumpFun tokens
 * Uses background queue + cache for performance
 * GATED: Requires holding $asdfasdfa tokens (configurable)
 */
async function handleGetWalletKGlobal(req, res, params) {
  try {
    const address = params[0];

    // Validate Solana address format
    if (!security.validateAddress(address)) {
      return sendJson(res, 400, { error: 'Invalid wallet address format' });
    }

    // Check holder gating (with admin bypass option)
    const adminKey = req.headers['x-admin-key'];
    const accessCheck = await gating.checkKGlobalAccess(address, { adminKey });
    if (!accessCheck.allowed) {
      return sendJson(res, 403, {
        error: 'Access denied',
        reason: accessCheck.reason,
        message: accessCheck.message,
        gated: true,
        required_balance: accessCheck.required,
        current_balance: accessCheck.current || '0',
        hint: 'Hold $asdfasdfa tokens to unlock K_wallet global scoring'
      });
    }

    // 1. Check DB for persisted K_wallet (preferred source)
    const dbCached = await walletScore.getKWalletFromDB(address);
    if (dbCached) {
      const ageSeconds = Math.floor(Date.now() / 1000) - dbCached.updated_at;
      const isStale = ageSeconds > 86400; // 24h

      // If stale, queue for refresh but still return cached value
      if (isStale) {
        await walletScore.enqueueWallet(address);
      }

      return sendJson(res, 200, {
        address,
        k_wallet: dbCached.k_wallet,
        tokens_analyzed: dbCached.tokens_analyzed,
        updated_at: dbCached.updated_at,
        age_seconds: ageSeconds,
        stale: isStale,
        source: 'db',
        // PoH (Proof of History) - Solana ordering guarantee
        poh: {
          slot: dbCached.poh_slot,
          description: 'Solana slot at which K_wallet was calculated - monotonically increasing ordering key',
        },
      });
    }

    // 2. Check memory cache (for recent calculations not yet in DB)
    const status = walletScore.getWalletStatus(address);

    if (status.status === 'ready') {
      sendJson(res, 200, { ...status.data, source: 'memory' });
      return;
    }

    if (status.status === 'calculating') {
      sendJson(res, 202, {
        status: 'calculating',
        message: 'K_wallet calculation in progress',
        started_at: status.started_at,
        elapsed_ms: status.elapsed_ms,
        retry_after: 5,
      });
      return;
    }

    // 3. Not found - queue for calculation
    await walletScore.enqueueWallet(address);

    sendJson(res, 202, {
      status: 'queued',
      message: 'K_wallet calculation queued',
      address,
      retry_after: 10,
      queue_stats: await db.getKWalletQueueStats(),
    });
  } catch (error) {
    log('ERROR', `Wallet K-global error: ${error.message}`);
    sendJson(res, 500, { error: error.message });
  }
}

/**
 * POST /k-metric/backup - Create manual backup
 */
async function handleBackup(req, res) {
  try {
    const backupPath = await security.createBackup();

    if (backupPath) {
      const backups = security.listBackups();
      sendJson(res, 200, {
        success: true,
        backup: backupPath,
        totalBackups: backups.length,
      });
    } else {
      sendJson(res, 500, { success: false, error: 'Backup failed' });
    }
  } catch (error) {
    log('ERROR', `Backup error: ${error.message}`);
    sendJson(res, 500, { error: error.message });
  }
}

/**
 * Admin middleware - verifies admin API key
 */
function requireAdmin(req) {
  const adminKey = req.headers['x-admin-key'];
  return gating.verifyAdminKey(adminKey);
}

/**
 * POST /k-metric/admin/batch-k - Batch K_wallet calculation for multiple wallets (admin only)
 * Body: { wallets: ["addr1", "addr2", ...] }
 */
async function handleAdminBatchK(req, res) {
  try {
    if (!requireAdmin(req)) {
      return sendJson(res, 401, { error: 'Admin access required', hint: 'Set X-Admin-Key header' });
    }

    let wallets = [];

    if (Array.isArray(req.body.wallets)) {
      wallets = req.body.wallets.map(addr => ({
        address: typeof addr === 'string' ? addr : addr.address,
        name: typeof addr === 'string' ? null : addr.name
      }));
    } else {
      return sendJson(res, 400, { error: 'Provide wallets array' });
    }

    // Validate addresses
    wallets = wallets.filter(w => security.validateAddress(w.address));

    if (wallets.length === 0) {
      return sendJson(res, 400, { error: 'No valid wallet addresses' });
    }

    log('INFO', `[Admin] Batch K calculation for ${wallets.length} wallets`);

    // Queue all wallets for calculation
    const results = [];
    for (const wallet of wallets) {
      const status = walletScore.getWalletStatus(wallet.address);

      if (status.status === 'ready') {
        results.push({
          ...wallet,
          k_wallet: status.data.k_wallet,
          tokens: status.data.tokens_analyzed,
          status: 'cached'
        });
      } else {
        walletScore.queueWalletCalculation(wallet.address);
        results.push({
          ...wallet,
          status: 'queued'
        });
      }
    }

    const cached = results.filter(r => r.status === 'cached').length;
    const queued = results.filter(r => r.status === 'queued').length;

    sendJson(res, 200, {
      results,
      summary: {
        total: results.length,
        cached,
        queued
      },
      queue_stats: walletScore.getQueueStats()
    });
  } catch (error) {
    log('ERROR', `Admin batch K error: ${error.message}`);
    sendJson(res, 500, { error: error.message });
  }
}

/**
 * POST /k-metric/admin/backfill-k-wallet - Backfill K_wallet for all holders
 */
async function handleAdminBackfillKWallet(req, res) {
  try {
    if (!requireAdmin(req)) {
      return sendJson(res, 401, { error: 'Admin access required', hint: 'Set X-Admin-Key header' });
    }

    log('INFO', '[Admin] Starting K_wallet backfill');
    const result = await walletScore.backfillAllHolders();
    const queueStats = await db.getKWalletQueueStats();

    sendJson(res, 200, {
      ...result,
      queue_stats: queueStats,
      message: result.queued > 0
        ? `Queued ${result.queued} wallets for K_wallet calculation`
        : 'All wallets already have K_wallet calculated'
    });
  } catch (error) {
    log('ERROR', `Admin backfill error: ${error.message}`);
    sendJson(res, 500, { error: error.message });
  }
}

/**
 * GET /k-metric/admin/k-wallet-queue - Get K_wallet queue status
 */
async function handleAdminKWalletQueue(req, res) {
  try {
    const queueStats = await db.getKWalletQueueStats();
    const memoryStats = walletScore.getQueueStats();

    sendJson(res, 200, {
      db_queue: queueStats,
      memory_queue: memoryStats,
    });
  } catch (error) {
    log('ERROR', `Admin queue status error: ${error.message}`);
    sendJson(res, 500, { error: error.message });
  }
}

// ============================================
// Admin - API Key Management
// ============================================

/**
 * POST /k-metric/admin/api-keys - Create new API key
 * Body: { name, tier?, rate_limit_minute?, rate_limit_day?, expires_at? }
 */
async function handleAdminCreateApiKey(req, res) {
  try {
    if (!requireAdmin(req)) {
      return sendJson(res, 401, { error: 'Admin access required', hint: 'Set X-Admin-Key header' });
    }

    const { name, tier, rate_limit_minute, rate_limit_day, expires_at } = req.body || {};

    if (!name || typeof name !== 'string') {
      return sendJson(res, 400, { error: 'name is required' });
    }

    // Validate tier
    const validTiers = ['free', 'standard', 'premium', 'internal'];
    if (tier && !validTiers.includes(tier)) {
      return sendJson(res, 400, { error: 'Invalid tier', valid: validTiers });
    }

    const result = await db.createApiKey({
      name,
      tier: tier || 'standard',
      rateLimitMinute: rate_limit_minute,
      rateLimitDay: rate_limit_day,
      expiresAt: expires_at,
    });

    log('INFO', `[Admin] Created API key: ${result.id} (${name}, tier: ${result.tier})`);

    sendJson(res, 201, {
      ...result,
      message: 'API key created. Save the key now - it cannot be retrieved later!',
      warning: 'This is the only time the full key will be shown.',
    });
  } catch (error) {
    log('ERROR', `Admin create API key error: ${error.message}`);
    sendJson(res, 500, { error: error.message });
  }
}

/**
 * GET /k-metric/admin/api-keys - List all API keys
 */
async function handleAdminListApiKeys(req, res) {
  try {
    if (!requireAdmin(req)) {
      return sendJson(res, 401, { error: 'Admin access required', hint: 'Set X-Admin-Key header' });
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const includeInactive = url.searchParams.get('include_inactive') === 'true';

    const keys = await db.listApiKeys({ activeOnly: !includeInactive });

    // Get usage stats for each key
    const keysWithUsage = await Promise.all(keys.map(async (key) => {
      const todayUsage = await db.getTodayUsage(key.id);
      return {
        id: key.id,
        name: key.name,
        tier: key.tier,
        rate_limit_minute: key.rate_limit_minute,
        rate_limit_day: key.rate_limit_day,
        is_active: !!key.is_active,
        created_at: key.created_at,
        expires_at: key.expires_at,
        last_used_at: key.last_used_at,
        today_requests: todayUsage,
      };
    }));

    sendJson(res, 200, {
      keys: keysWithUsage,
      total: keysWithUsage.length,
    });
  } catch (error) {
    log('ERROR', `Admin list API keys error: ${error.message}`);
    sendJson(res, 500, { error: error.message });
  }
}

/**
 * DELETE /k-metric/admin/api-keys/:id - Revoke API key
 */
async function handleAdminRevokeApiKey(req, res, params) {
  try {
    if (!requireAdmin(req)) {
      return sendJson(res, 401, { error: 'Admin access required', hint: 'Set X-Admin-Key header' });
    }

    const keyId = params[0];

    // Check if key exists
    const key = await db.getApiKey(keyId);
    if (!key) {
      return sendJson(res, 404, { error: 'API key not found' });
    }

    const revoked = await db.revokeApiKey(keyId);

    if (revoked) {
      log('INFO', `[Admin] Revoked API key: ${keyId} (${key.name})`);
      sendJson(res, 200, { success: true, message: 'API key revoked' });
    } else {
      sendJson(res, 500, { error: 'Failed to revoke key' });
    }
  } catch (error) {
    log('ERROR', `Admin revoke API key error: ${error.message}`);
    sendJson(res, 500, { error: error.message });
  }
}

/**
 * GET /k-metric/admin/api-keys/:id/usage - Get usage history for API key
 */
async function handleAdminApiKeyUsage(req, res, params) {
  try {
    if (!requireAdmin(req)) {
      return sendJson(res, 401, { error: 'Admin access required', hint: 'Set X-Admin-Key header' });
    }

    const keyId = params[0];
    const url = new URL(req.url, `http://${req.headers.host}`);
    const days = parseInt(url.searchParams.get('days') || '30');

    // Check if key exists
    const key = await db.getApiKey(keyId);
    if (!key) {
      return sendJson(res, 404, { error: 'API key not found' });
    }

    const history = await db.getUsageHistory(keyId, days);
    const todayUsage = await db.getTodayUsage(keyId);

    sendJson(res, 200, {
      key: {
        id: key.id,
        name: key.name,
        tier: key.tier,
      },
      today: todayUsage,
      history,
      period_days: days,
    });
  } catch (error) {
    log('ERROR', `Admin API key usage error: ${error.message}`);
    sendJson(res, 500, { error: error.message });
  }
}

/**
 * GET /k-metric/admin/usage-stats - Get usage stats for all keys
 */
async function handleAdminUsageStats(req, res) {
  try {
    if (!requireAdmin(req)) {
      return sendJson(res, 401, { error: 'Admin access required', hint: 'Set X-Admin-Key header' });
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const days = parseInt(url.searchParams.get('days') || '7');

    const stats = await db.getUsageStats(days);

    sendJson(res, 200, {
      stats,
      period_days: days,
      tier_limits: security.getTierLimits(),
    });
  } catch (error) {
    log('ERROR', `Admin usage stats error: ${error.message}`);
    sendJson(res, 500, { error: error.message });
  }
}

/**
 * POST /k-metric/webhook - Helius webhook handler
 */
async function handleWebhook(req, res) {
  try {
    const signature = req.headers['x-helius-signature'];

    // Verify signature
    if (!webhook.verifySignature(JSON.stringify(req.body), signature)) {
      return sendJson(res, 401, { error: 'Invalid signature' });
    }

    // Process events async
    webhook.processEvents(req.body).catch((err) => {
      log('ERROR', `Webhook error: ${err.message}`);
    });

    sendJson(res, 200, { received: true });
  } catch (error) {
    log('ERROR', `Webhook error: ${error.message}`);
    sendJson(res, 500, { error: error.message });
  }
}

/**
 * POST /k-metric/sync - Force resync
 */
async function handleSync(req, res) {
  try {
    log('INFO', 'Manual sync triggered');

    // Fetch current holders and update balances
    const holders = await helius.fetchHolders();

    for (const holder of holders) {
      await db.upsertWallet({
        address: holder.address,
        balance: holder.balance,
        firstBuyTs: null,
        firstBuyAmount: 0,
        received: 0,
        sent: 0,
        lastTxSig: null,
      });
    }

    // Recalculate K
    const kMetric = await calculator.calculateAndSave();

    sendJson(res, 200, {
      success: true,
      holdersUpdated: holders.length,
      k: kMetric.k,
    });
  } catch (error) {
    log('ERROR', `Sync error: ${error.message}`);
    sendJson(res, 500, { error: error.message });
  }
}

// ============================================
// API v1 - Oracle Endpoints for ASDev
// ============================================

/**
 * Verify Oracle API key
 */
function verifyOracleKey(req) {
  const apiKey = req.headers['x-oracle-key'];
  if (!ORACLE_API_KEY) return true; // No key configured = open access
  return apiKey === ORACLE_API_KEY;
}

/**
 * GET /api/v1/status - API status and queue info
 */
async function handleApiV1Status(req, res) {
  try {
    const tokenQueueStats = await tokenScore.getQueueStats();
    const walletQueueStats = walletScore.getQueueStats();
    const kMetric = await calculator.calculate();

    sendJson(res, 200, {
      version: 'v1',
      status: 'operational',
      primary_token: {
        mint: process.env.TOKEN_MINT,
        k: kMetric?.k || 0,
        holders: kMetric?.holders || 0,
      },
      queues: {
        token: tokenQueueStats,
        wallet: walletQueueStats,
      },
    });
  } catch (error) {
    log('ERROR', `API v1 status error: ${error.message}`);
    sendJson(res, 500, { error: error.message });
  }
}

/**
 * GET /api/v1/token/:mint - Get K score for any token
 * Authenticated via X-Oracle-Key header
 */
async function handleApiV1Token(req, res, params) {
  try {
    const mint = params[0];

    // Validate token format
    if (!security.validateAddress(mint)) {
      return sendJson(res, 400, { error: 'Invalid token mint address' });
    }

    // Validate token type (PumpFun, Ignition, or dev.fun)
    if (!tokenScore.isValidToken(mint)) {
      return sendJson(res, 400, {
        error: 'Invalid token type',
        message: 'Only PumpFun (*pump), Ignition (*asdf), and dev.fun (*dev) tokens are supported',
      });
    }

    // Get or calculate K
    const result = await tokenScore.getTokenK(mint);

    // If queued/syncing, return 202 Accepted
    if (result.status === 'queued' || result.status === 'syncing') {
      return sendJson(res, 202, result);
    }

    sendJson(res, 200, result);
  } catch (error) {
    log('ERROR', `API v1 token error: ${error.message}`);
    sendJson(res, 500, { error: error.message });
  }
}

/**
 * GET /api/v1/wallet/:address - Get wallet K scores
 * Returns K_wallet (global) + K for primary token
 */
async function handleApiV1Wallet(req, res, params) {
  try {
    const address = params[0];

    // Validate address
    if (!security.validateAddress(address)) {
      return sendJson(res, 400, { error: 'Invalid wallet address' });
    }

    // Get K for primary token ($ASDFASDFA)
    const kToken = await db.getWalletKScore(address);

    // Get K_wallet (global across all PumpFun)
    const kWalletDB = await walletScore.getKWalletFromDB(address);
    let kWalletResult = null;

    if (kWalletDB) {
      kWalletResult = {
        k_wallet: kWalletDB.k_wallet,
        tokens_analyzed: kWalletDB.tokens_analyzed,
        updated_at: kWalletDB.updated_at,
      };
    } else {
      // Queue for calculation
      await walletScore.enqueueWallet(address);
      kWalletResult = {
        status: 'queued',
        message: 'K_wallet calculation queued',
      };
    }

    // Check if holder of primary token
    const isHolder = kToken && BigInt(kToken.balance || '0') > 0n;

    sendJson(res, 200, {
      address,
      is_holder: isHolder,
      primary_token: kToken ? {
        mint: process.env.TOKEN_MINT,
        balance: kToken.balance,
        first_buy_amount: kToken.first_buy_amount,
        retention: kToken.retention,
        classification: kToken.classification,
        hold_days: kToken.hold_days,
        is_og: kToken.is_og,
      } : null,
      k_wallet: kWalletResult,
    });
  } catch (error) {
    log('ERROR', `API v1 wallet error: ${error.message}`);
    sendJson(res, 500, { error: error.message });
  }
}

// ============================================
// API v1 - Batch Endpoints
// ============================================

/**
 * POST /api/v1/wallets - Batch wallet K scores
 * Body: { addresses: [...], filters: { k_min, classification } }
 * Max 100 addresses per request
 */
async function handleApiV1WalletsBatch(req, res) {
  try {
    const { addresses, filters = {} } = req.body || {};

    // Validate input
    if (!Array.isArray(addresses) || addresses.length === 0) {
      return sendJson(res, 400, { error: 'addresses array required' });
    }

    if (addresses.length > 100) {
      return sendJson(res, 400, { error: 'Maximum 100 addresses per request' });
    }

    // Validate and filter addresses
    const validAddresses = addresses.filter(addr => security.validateAddress(addr));
    if (validAddresses.length === 0) {
      return sendJson(res, 400, { error: 'No valid addresses provided' });
    }

    const results = [];
    let ready = 0;
    let queued = 0;
    let calculating = 0;

    for (const address of validAddresses) {
      // Get K_wallet from DB
      const kWalletDB = await walletScore.getKWalletFromDB(address);

      if (kWalletDB) {
        // Apply filters
        if (filters.k_min !== undefined && kWalletDB.k_wallet < filters.k_min) {
          continue; // Skip wallets below k_min
        }

        // Get classification from primary token
        const kToken = await db.getWalletKScore(address);
        const classification = kToken?.classification || null;

        if (filters.classification && classification !== filters.classification) {
          continue; // Skip wallets with different classification
        }

        results.push({
          address,
          k_wallet: kWalletDB.k_wallet,
          tokens_analyzed: kWalletDB.tokens_analyzed,
          classification,
          status: 'ready',
          updated_at: kWalletDB.updated_at,
        });
        ready++;
      } else {
        // Check if calculating
        const status = walletScore.getWalletStatus(address);

        if (status.status === 'calculating') {
          results.push({
            address,
            status: 'calculating',
            started_at: status.started_at,
          });
          calculating++;
        } else {
          // Queue for calculation
          await walletScore.enqueueWallet(address);
          results.push({
            address,
            status: 'queued',
          });
          queued++;
        }
      }
    }

    sendJson(res, 200, {
      results,
      summary: {
        total: validAddresses.length,
        ready,
        queued,
        calculating,
        filtered_out: validAddresses.length - results.length,
      },
      filters_applied: filters,
      queue_stats: walletScore.getQueueStats(),
    });
  } catch (error) {
    log('ERROR', `API v1 wallets batch error: ${error.message}`);
    sendJson(res, 500, { error: error.message });
  }
}

/**
 * POST /api/v1/tokens - Batch token K scores
 * Body: { mints: [...], filters: { k_min } }
 * Max 50 tokens per request
 */
async function handleApiV1TokensBatch(req, res) {
  try {
    const { mints, filters = {} } = req.body || {};

    // Validate input
    if (!Array.isArray(mints) || mints.length === 0) {
      return sendJson(res, 400, { error: 'mints array required' });
    }

    if (mints.length > 50) {
      return sendJson(res, 400, { error: 'Maximum 50 tokens per request' });
    }

    // Validate addresses and token types
    const validMints = mints.filter(mint =>
      security.validateAddress(mint) && tokenScore.isValidToken(mint)
    );

    if (validMints.length === 0) {
      return sendJson(res, 400, {
        error: 'No valid token mints provided',
        hint: 'Only PumpFun (*pump), Ignition (*asdf), and dev.fun (*dev) tokens are supported',
      });
    }

    const results = [];
    let ready = 0;
    let queued = 0;
    let syncing = 0;

    for (const mint of validMints) {
      const result = await tokenScore.getTokenK(mint);

      // Apply filters
      if (result.k !== undefined && filters.k_min !== undefined) {
        if (result.k < filters.k_min) {
          continue; // Skip tokens below k_min
        }
      }

      results.push({
        mint,
        k: result.k,
        holders: result.holders,
        quality: result.quality,
        status: result.status || 'ready',
      });

      if (result.status === 'queued') queued++;
      else if (result.status === 'syncing') syncing++;
      else ready++;
    }

    sendJson(res, 200, {
      results,
      summary: {
        total: validMints.length,
        ready,
        queued,
        syncing,
        filtered_out: validMints.length - results.length,
      },
      filters_applied: filters,
      queue_stats: await tokenScore.getQueueStats(),
    });
  } catch (error) {
    log('ERROR', `API v1 tokens batch error: ${error.message}`);
    sendJson(res, 500, { error: error.message });
  }
}

/**
 * GET /api/v1/holders - Get filtered holders list
 * Query params: k_min, classification, limit
 */
async function handleApiV1Holders(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const kMin = url.searchParams.get('k_min') ? parseInt(url.searchParams.get('k_min')) : null;
    const classification = url.searchParams.get('classification') || null;
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '100'), 500);

    // Validate classification if provided
    const validClassifications = ['accumulator', 'holder', 'reducer', 'extractor'];
    if (classification && !validClassifications.includes(classification)) {
      return sendJson(res, 400, {
        error: 'Invalid classification',
        valid: validClassifications,
      });
    }

    // Get filtered holders from DB
    const holders = await db.getHoldersFiltered({
      kMin,
      classification,
      limit,
    });

    // Count by classification
    const breakdown = {
      accumulator: 0,
      holder: 0,
      reducer: 0,
      extractor: 0,
    };
    holders.forEach(h => {
      if (breakdown[h.classification] !== undefined) {
        breakdown[h.classification]++;
      }
    });

    sendJson(res, 200, {
      holders,
      total: holders.length,
      breakdown,
      filters_applied: {
        k_min: kMin,
        classification,
        limit,
      },
    });
  } catch (error) {
    log('ERROR', `API v1 holders error: ${error.message}`);
    sendJson(res, 500, { error: error.message });
  }
}

// ============================================
// API v1 - Webhook Endpoints
// ============================================

/**
 * Require valid API key for webhook endpoints
 */
function requireApiKey(req) {
  return req.apiKeyMeta && req.apiKeyMeta.is_active;
}

/**
 * GET /api/v1/webhooks/events - List available event types
 */
async function handleApiV1WebhookEvents(req, res) {
  try {
    const events = db.getWebhookEventTypes();
    sendJson(res, 200, {
      events,
      description: {
        k_change: 'Triggered when K metric changes by more than 1%',
        holder_new: 'Triggered when a new holder is detected',
        holder_exit: 'Triggered when a holder exits (balance = 0)',
        threshold_alert: 'Triggered when K crosses a configured threshold',
      },
    });
  } catch (error) {
    log('ERROR', `Webhook events error: ${error.message}`);
    sendJson(res, 500, { error: error.message });
  }
}

/**
 * GET /api/v1/webhooks - List webhooks for current API key
 */
async function handleApiV1ListWebhooks(req, res) {
  try {
    if (!requireApiKey(req)) {
      return sendJson(res, 401, { error: 'API key required', hint: 'Set X-Oracle-Key header' });
    }

    const webhooksList = await db.listWebhookSubscriptions(req.apiKeyMeta.id);

    sendJson(res, 200, {
      webhooks: webhooksList.map(w => ({
        id: w.id,
        url: w.url,
        events: w.events,
        is_active: !!w.is_active,
        failure_count: w.failure_count,
        last_triggered_at: w.last_triggered_at,
        created_at: w.created_at,
      })),
      total: webhooksList.length,
    });
  } catch (error) {
    log('ERROR', `List webhooks error: ${error.message}`);
    sendJson(res, 500, { error: error.message });
  }
}

/**
 * POST /api/v1/webhooks - Create webhook subscription
 * Body: { url, events: [...], secret? }
 */
async function handleApiV1CreateWebhook(req, res) {
  try {
    if (!requireApiKey(req)) {
      return sendJson(res, 401, { error: 'API key required', hint: 'Set X-Oracle-Key header' });
    }

    const { url, events, secret } = req.body || {};

    if (!url || typeof url !== 'string') {
      return sendJson(res, 400, { error: 'url is required' });
    }

    if (!events || !Array.isArray(events) || events.length === 0) {
      return sendJson(res, 400, {
        error: 'events array is required',
        valid_events: db.getWebhookEventTypes(),
      });
    }

    // Validate URL format
    try {
      new URL(url);
    } catch {
      return sendJson(res, 400, { error: 'Invalid URL format' });
    }

    // Generate secret if not provided
    const { randomBytes } = await import('crypto');
    const webhookSecret = secret || randomBytes(32).toString('hex');

    const webhook = await db.createWebhookSubscription({
      apiKeyId: req.apiKeyMeta.id,
      url,
      events,
      secret: webhookSecret,
    });

    log('INFO', `[Webhook] Created subscription ${webhook.id} for ${req.apiKeyMeta.name}`);

    sendJson(res, 201, {
      ...webhook,
      secret: webhookSecret,
      message: 'Webhook created. Save the secret for signature verification.',
      signature_header: 'X-Oracle-Signature',
    });
  } catch (error) {
    log('ERROR', `Create webhook error: ${error.message}`);
    sendJson(res, 500, { error: error.message });
  }
}

/**
 * GET /api/v1/webhooks/:id - Get webhook details
 */
async function handleApiV1GetWebhook(req, res, params) {
  try {
    if (!requireApiKey(req)) {
      return sendJson(res, 401, { error: 'API key required' });
    }

    const webhookId = params[0];
    const webhook = await db.getWebhookSubscription(webhookId);

    if (!webhook) {
      return sendJson(res, 404, { error: 'Webhook not found' });
    }

    // Verify ownership
    if (webhook.api_key_id !== req.apiKeyMeta.id) {
      return sendJson(res, 403, { error: 'Access denied' });
    }

    sendJson(res, 200, {
      id: webhook.id,
      url: webhook.url,
      events: webhook.events,
      is_active: !!webhook.is_active,
      failure_count: webhook.failure_count,
      last_triggered_at: webhook.last_triggered_at,
      created_at: webhook.created_at,
    });
  } catch (error) {
    log('ERROR', `Get webhook error: ${error.message}`);
    sendJson(res, 500, { error: error.message });
  }
}

/**
 * DELETE /api/v1/webhooks/:id - Delete webhook
 */
async function handleApiV1DeleteWebhook(req, res, params) {
  try {
    if (!requireApiKey(req)) {
      return sendJson(res, 401, { error: 'API key required' });
    }

    const webhookId = params[0];
    const webhook = await db.getWebhookSubscription(webhookId);

    if (!webhook) {
      return sendJson(res, 404, { error: 'Webhook not found' });
    }

    // Verify ownership
    if (webhook.api_key_id !== req.apiKeyMeta.id) {
      return sendJson(res, 403, { error: 'Access denied' });
    }

    await db.deleteWebhookSubscription(webhookId);

    log('INFO', `[Webhook] Deleted subscription ${webhookId}`);
    sendJson(res, 200, { success: true, message: 'Webhook deleted' });
  } catch (error) {
    log('ERROR', `Delete webhook error: ${error.message}`);
    sendJson(res, 500, { error: error.message });
  }
}

/**
 * GET /api/v1/webhooks/:id/deliveries - Get delivery history
 */
async function handleApiV1WebhookDeliveries(req, res, params) {
  try {
    if (!requireApiKey(req)) {
      return sendJson(res, 401, { error: 'API key required' });
    }

    const webhookId = params[0];
    const webhook = await db.getWebhookSubscription(webhookId);

    if (!webhook) {
      return sendJson(res, 404, { error: 'Webhook not found' });
    }

    // Verify ownership
    if (webhook.api_key_id !== req.apiKeyMeta.id) {
      return sendJson(res, 403, { error: 'Access denied' });
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);

    const deliveries = await db.getWebhookDeliveryHistory(webhookId, limit);

    sendJson(res, 200, {
      deliveries: deliveries.map(d => ({
        id: d.id,
        event_type: d.event_type,
        status: d.status,
        attempts: d.attempts,
        response_code: d.response_code,
        created_at: d.created_at,
        completed_at: d.completed_at,
      })),
      total: deliveries.length,
    });
  } catch (error) {
    log('ERROR', `Webhook deliveries error: ${error.message}`);
    sendJson(res, 500, { error: error.message });
  }
}

// Helper to send JSON response
function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/**
 * Handle incoming request
 */
export async function handleRequest(req, res) {
  const method = req.method;
  const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;

  // For /k-metric routes, also try with /api prefix stripped (backwards compat)
  // For /api/v1 routes, use the full path
  const paths = [pathname];
  if (pathname.startsWith('/api/') && !pathname.startsWith('/api/v1')) {
    paths.push(pathname.replace(/^\/api/, ''));
  }

  // Try each path variant
  for (const path of paths) {
    const routeKey = `${method} ${path}`;
    const handler = routes[routeKey];

    if (handler) {
      // Parse JSON body for POST requests
      if (method === 'POST' && !req.body) {
        let body = '';
        for await (const chunk of req) {
          body += chunk;
        }
        try {
          req.body = JSON.parse(body);
        } catch {
          req.body = {};
        }
      }

      await handler(req, res);
      return;
    }

    // Try dynamic routes
    for (const route of dynamicRoutes) {
      const match = `${method} ${path}`.match(route.pattern);
      if (match) {
        const params = match.slice(1); // Extract captured groups
        await route.handler(req, res, params);
        return;
      }
    }
  }

  sendJson(res, 404, { error: 'Not found' });
}

/**
 * Express router middleware (if using Express)
 */
export function expressRouter() {
  return async (req, res, next) => {
    const path = req.path;

    if (path.startsWith('/k-metric') || path.startsWith('/api/v1')) {
      await handleRequest(req, res);
    } else {
      next();
    }
  };
}

export default { handleRequest, expressRouter, routes };
