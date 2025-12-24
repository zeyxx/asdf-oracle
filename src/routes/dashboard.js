/**
 * Dashboard Routes (/k-metric)
 *
 * Internal API for the K-Metric dashboard.
 * Used by index.html and wallet.html.
 */

import db from '../db.js';
import calculator from '../calculator.js';
import helius from '../helius.js';
import webhook from '../webhook.js';
import sync from '../sync.js';
import walletScore from '../wallet-score.js';
import gating from '../gating.js';
import security from '../security.js';
import { kMetricCache, getOrCompute, getAllCacheStats } from '../cache.js';
import { log } from '../utils.js';
import { sendJson } from './utils.js';
import ws from '../ws.js';

const MAINTENANCE_MODE = process.env.MAINTENANCE === '1' || process.env.MAINTENANCE === 'true';

/**
 * GET /k-metric - Get current K-metric
 * Cached for 30 seconds to handle high request volume
 */
async function handleGetKMetric(req, res) {
  try {
    // Use cache-through pattern for K-metric
    const data = await getOrCompute(
      kMetricCache,
      'k-metric-current',
      async () => {
        const calculated = await calculator.calculate();
        if (!calculated) return null;
        const tokenInfo = await helius.fetchTokenInfo();
        calculated.token = tokenInfo;
        return calculated;
      },
      30 * 1000 // 30 second TTL
    );

    if (!data) {
      return sendJson(res, 503, { error: 'No data available. Run backfill first.' });
    }

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
    const limit = parseInt(url.searchParams.get('limit') || '100');
    const excludePools = url.searchParams.get('exclude_pools') === 'true';
    const minUsd = parseFloat(url.searchParams.get('min_usd') || '1');

    const tokenInfo = await helius.fetchTokenInfo();
    const price = tokenInfo.price || 0.0000001;
    const minBalance = Math.floor((minUsd / price) * 1e6);

    const wallets = await db.getWallets(minBalance);

    const now = Math.floor(Date.now() / 1000);
    const TOKEN_LAUNCH_TS = parseInt(process.env.TOKEN_LAUNCH_TS || '0');
    const OG_EARLY_WINDOW = parseInt(process.env.OG_EARLY_WINDOW || '21') * 86400;
    const OG_HOLD_THRESHOLD = parseInt(process.env.OG_HOLD_THRESHOLD || '55') * 86400;

    const sortedWallets = wallets
      .sort((a, b) => (b.current_balance > a.current_balance ? 1 : b.current_balance < a.current_balance ? -1 : 0));

    const topAddresses = sortedWallets.slice(0, Math.min(limit + 20, sortedWallets.length)).map(w => w.address);
    const poolResults = await helius.batchCheckPools(topAddresses);

    let sorted = sortedWallets.map((w) => {
      const holdDays = w.first_buy_ts ? Math.floor((now - w.first_buy_ts) / 86400) : 0;
      const isEarlyBuyer = w.first_buy_ts && w.first_buy_ts <= TOKEN_LAUNCH_TS + OG_EARLY_WINDOW;
      const hasHeldLongEnough = w.first_buy_ts && (now - w.first_buy_ts) >= OG_HOLD_THRESHOLD;
      const retention = w.first_buy_amount > 0n
        ? Math.round(Number(w.current_balance) / Number(w.first_buy_amount) * 1000) / 1000
        : 1.0;

      const classification = retention >= 1.5 ? 'accumulator'
        : retention >= 1.0 ? 'holder'
        : retention >= 0.5 ? 'reducer'
        : 'extractor';

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
        k_wallet: w.k_wallet,
        k_wallet_tokens: w.k_wallet_tokens,
        k_wallet_slot: w.k_wallet_slot,
      };
    });

    if (excludePools) {
      sorted = sorted.filter(h => !h.isPool);
    }

    sorted = sorted.slice(0, limit);

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
 * GET /k-metric/status - Get sync status and system health
 */
async function handleGetStatus(req, res) {
  try {
    const status = await sync.getStatus();
    const kMetric = await calculator.calculate();
    const gatingStatus = gating.getGatingStatus();
    const cacheStats = getAllCacheStats();

    sendJson(res, 200, {
      sync: status,
      k: kMetric?.k || 0,
      holders: kMetric?.holders || 0,
      mode: 'hybrid',
      description: 'Webhook (real-time) + Polling (5min fallback)',
      gating: gatingStatus,
      queue: walletScore.getQueueStats(),
      cache: cacheStats,
      websocket: ws.getStats(),
      maintenance: MAINTENANCE_MODE,
      uptime: Math.floor(process.uptime()),
      memory: {
        heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
        rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
      },
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
 * GET /k-metric/wallet/:address/k-score - Wallet K for this token
 */
async function handleGetWalletKScore(req, res, params) {
  try {
    const address = params[0];

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
 * GET /k-metric/wallet/:address/k-global - Global K across all PumpFun tokens
 * GATED: Requires holding tokens
 */
async function handleGetWalletKGlobal(req, res, params) {
  try {
    const address = params[0];

    if (!security.validateAddress(address)) {
      return sendJson(res, 400, { error: 'Invalid wallet address format' });
    }

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

    const dbCached = await walletScore.getKWalletFromDB(address);
    if (dbCached) {
      const ageSeconds = Math.floor(Date.now() / 1000) - dbCached.updated_at;
      const isStale = ageSeconds > 86400;

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
        poh: {
          slot: dbCached.poh_slot,
          description: 'Solana slot at which K_wallet was calculated',
        },
      });
    }

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
 * POST /k-metric/webhook - Helius webhook handler
 */
async function handleWebhook(req, res) {
  try {
    const signature = req.headers['x-helius-signature'];

    if (!webhook.verifySignature(JSON.stringify(req.body), signature)) {
      return sendJson(res, 401, { error: 'Invalid signature' });
    }

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

// Route definitions
export const routes = {
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
};

export const dynamicRoutes = [
  { pattern: /^GET \/k-metric\/wallet\/([A-Za-z0-9]{32,44})\/k-score$/, handler: handleGetWalletKScore },
  { pattern: /^GET \/k-metric\/wallet\/([A-Za-z0-9]{32,44})\/k-global$/, handler: handleGetWalletKGlobal },
];

export default { routes, dynamicRoutes };
