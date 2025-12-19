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
};

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
 */
async function handleGetHolders(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const minBalance = parseInt(url.searchParams.get('min') || process.env.MIN_BALANCE || '1000');
    const limit = parseInt(url.searchParams.get('limit') || '100');

    const wallets = await db.getWallets(minBalance);

    // Sort by balance and limit
    const sorted = wallets
      .sort((a, b) => b.current_balance - a.current_balance)
      .slice(0, limit)
      .map((w) => ({
        address: w.address,
        balance: w.current_balance,
        firstBuyTs: w.first_buy_ts,
        firstBuyAmount: w.first_buy_amount,
        totalReceived: w.total_received,
        totalSent: w.total_sent,
        retention: w.first_buy_amount > 0 ? w.current_balance / w.first_buy_amount : 1,
        neverSold: w.total_sent === 0,
        holdDays: w.first_buy_ts ? Math.floor((Date.now() / 1000 - w.first_buy_ts) / 86400) : 0,
      }));

    sendJson(res, 200, { holders: sorted, total: wallets.length });
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

    sendJson(res, 200, {
      sync: status,
      k: kMetric?.k || 0,
      holders: kMetric?.holders || 0,
      mode: 'hybrid',
      description: 'Webhook (real-time) + Polling (5min fallback)',
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
