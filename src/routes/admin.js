/**
 * Admin Routes (/k-metric/admin)
 *
 * Administrative endpoints for API key management,
 * batch operations, and queue monitoring.
 */

import db from '../db.js';
import walletScore from '../wallet-score.js';
import security from '../security.js';
import { log } from '../utils.js';
import { sendJson, requireAdmin } from './utils.js';

/**
 * POST /k-metric/admin/batch-k - Batch K_wallet calculation for multiple wallets
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

    wallets = wallets.filter(w => security.validateAddress(w.address));

    if (wallets.length === 0) {
      return sendJson(res, 400, { error: 'No valid wallet addresses' });
    }

    log('INFO', `[Admin] Batch K calculation for ${wallets.length} wallets`);

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
      summary: { total: results.length, cached, queued },
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

// Route definitions
export const routes = {
  'POST /k-metric/admin/batch-k': handleAdminBatchK,
  'POST /k-metric/admin/backfill-k-wallet': handleAdminBackfillKWallet,
  'GET /k-metric/admin/k-wallet-queue': handleAdminKWalletQueue,
  'POST /k-metric/admin/api-keys': handleAdminCreateApiKey,
  'GET /k-metric/admin/api-keys': handleAdminListApiKeys,
  'GET /k-metric/admin/usage-stats': handleAdminUsageStats,
};

export const dynamicRoutes = [
  { pattern: /^DELETE \/k-metric\/admin\/api-keys\/([a-f0-9-]{36})$/, handler: handleAdminRevokeApiKey },
  { pattern: /^GET \/k-metric\/admin\/api-keys\/([a-f0-9-]{36})\/usage$/, handler: handleAdminApiKeyUsage },
];

export default { routes, dynamicRoutes };
