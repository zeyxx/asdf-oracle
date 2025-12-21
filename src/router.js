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
import gating from './gating.js';
import kolscan from './kolscan.js';
import { loadEnv, log } from './utils.js';

loadEnv();

import security from './security.js';

// Simple router implementation (no Express dependency)
const routes = {
  'GET /k-metric': handleGetKMetric,
  'GET /k-metric/history': handleGetHistory,
  'GET /k-metric/holders': handleGetHolders,
  'GET /k-metric/stats': handleGetStats,
  'GET /k-metric/status': handleGetStatus,
  'GET /k-metric/health': handleHealth,
  'POST /k-metric/webhook': handleWebhook,
  'POST /k-metric/sync': handleSync,
  'POST /k-metric/backup': handleBackup,
  // Admin routes
  'GET /k-metric/admin/kols': handleAdminKOLs,
  'POST /k-metric/admin/batch-k': handleAdminBatchK,
  'POST /k-metric/admin/backfill-k-wallet': handleAdminBackfillKWallet,
  'GET /k-metric/admin/k-wallet-queue': handleAdminKWalletQueue,
};

// Dynamic routes (with parameters)
const dynamicRoutes = [
  { pattern: /^GET \/k-metric\/wallet\/([A-Za-z0-9]{32,44})\/k-score$/, handler: handleGetWalletKScore },
  { pattern: /^GET \/k-metric\/wallet\/([A-Za-z0-9]{32,44})\/k-global$/, handler: handleGetWalletKGlobal },
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
    });
  } catch (error) {
    log('ERROR', `Status error: ${error.message}`);
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
 * GET /k-metric/admin/kols - Get KOL wallets from KOLscan (admin only)
 */
async function handleAdminKOLs(req, res) {
  try {
    if (!requireAdmin(req)) {
      return sendJson(res, 401, { error: 'Admin access required', hint: 'Set X-Admin-Key header' });
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const limit = parseInt(url.searchParams.get('limit') || '50');
    const category = url.searchParams.get('category') || null;

    // Check KOLscan availability
    if (!kolscan.isAvailable()) {
      return sendJson(res, 503, {
        error: 'KOLscan not configured',
        hint: 'Set KOLSCAN_API_KEY in environment',
        status: kolscan.getStatus()
      });
    }

    const kols = await kolscan.fetchKOLWallets({ limit, category });

    sendJson(res, 200, {
      kols,
      count: kols.length,
      source: 'kolscan',
      kolscan_status: kolscan.getStatus()
    });
  } catch (error) {
    log('ERROR', `Admin KOLs error: ${error.message}`);
    sendJson(res, 500, { error: error.message });
  }
}

/**
 * POST /k-metric/admin/batch-k - Batch K_wallet calculation for multiple wallets (admin only)
 * Body: { wallets: ["addr1", "addr2", ...] } or { source: "kolscan", limit: 50 }
 */
async function handleAdminBatchK(req, res) {
  try {
    if (!requireAdmin(req)) {
      return sendJson(res, 401, { error: 'Admin access required', hint: 'Set X-Admin-Key header' });
    }

    let wallets = [];

    // Get wallets from body or KOLscan
    if (req.body.source === 'kolscan') {
      if (!kolscan.isAvailable()) {
        return sendJson(res, 503, { error: 'KOLscan not configured' });
      }
      const kols = await kolscan.fetchKOLWallets({ limit: req.body.limit || 50 });
      wallets = kols.map(k => ({ address: k.address, name: k.name, source: 'kolscan' }));
    } else if (Array.isArray(req.body.wallets)) {
      wallets = req.body.wallets.map(addr => ({
        address: typeof addr === 'string' ? addr : addr.address,
        name: typeof addr === 'string' ? null : addr.name,
        source: 'manual'
      }));
    } else {
      return sendJson(res, 400, { error: 'Provide wallets array or source: "kolscan"' });
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

  // Remove /api prefix if present
  const path = pathname.replace(/^\/api/, '');

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
  } else {
    // Try dynamic routes
    for (const route of dynamicRoutes) {
      const match = `${method} ${path}`.match(route.pattern);
      if (match) {
        const params = match.slice(1); // Extract captured groups
        await route.handler(req, res, params);
        return;
      }
    }

    sendJson(res, 404, { error: 'Not found' });
  }
}

/**
 * Express router middleware (if using Express)
 */
export function expressRouter() {
  return async (req, res, next) => {
    const path = req.path;

    if (path.startsWith('/k-metric')) {
      await handleRequest(req, res);
    } else {
      next();
    }
  };
}

export default { handleRequest, expressRouter, routes };
