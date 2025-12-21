/**
 * K_wallet Global Score Calculator
 *
 * Calculates wallet conviction across ALL PumpFun tokens.
 * K_wallet = % of PumpFun tokens where retention >= 1
 *
 * Architecture:
 * 1. Fetch all token accounts for wallet (Helius RPC)
 * 2. Filter PumpFun tokens (ends with 'pump' or 'asdf')
 * 3. For each token, calculate retention = current / first_buy
 * 4. K_wallet = count(retention >= 1) / total_tokens
 */

import helius from './helius.js';
import db from './db.js';
import { log } from './utils.js';

const TOKEN_MINT = process.env.TOKEN_MINT;

// Cache for wallet scores (TTL: 1 hour)
const cache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

// Background queue
const queue = new Map(); // address -> { status, started_at }
const QUEUE_TIMEOUT = 5 * 60 * 1000; // 5 min max per calculation
const MAX_CONCURRENT = 3; // Max concurrent calculations
let activeCalculations = 0;

/**
 * Check if a token is a PumpFun token
 * Case insensitive: ends with 'pump' or 'asdf'
 */
export function isPumpFunToken(mint) {
  const lower = mint.toLowerCase();
  return lower.endsWith('pump') || lower.endsWith('asdf');
}

/**
 * Classify retention (same as K_token)
 */
function classifyRetention(retention) {
  if (retention >= 1.5) return 'accumulator';
  if (retention >= 1.0) return 'holder';
  if (retention >= 0.5) return 'reducer';
  return 'extractor';
}

// Note: Token retention calculation is done in helius.getCompletePumpFunHistory()
// which correctly tracks first_buy_amount by iterating backwards through tx history

/**
 * Get queue/cache status for a wallet
 */
export function getWalletStatus(address) {
  // Check cache first
  const cached = cache.get(address);
  if (cached && Date.now() - cached.calculated_at < CACHE_TTL) {
    return { status: 'ready', data: cached };
  }

  // Check if queued/calculating
  const queued = queue.get(address);
  if (queued) {
    const elapsed = Date.now() - queued.started_at;
    if (elapsed > QUEUE_TIMEOUT) {
      // Timeout, clear and allow retry
      queue.delete(address);
      return { status: 'timeout', message: 'Calculation timed out, retry' };
    }
    return { status: queued.status, started_at: queued.started_at, elapsed_ms: elapsed };
  }

  return { status: 'not_found' };
}

/**
 * Queue a wallet for background calculation
 */
export function queueWalletCalculation(address) {
  // Already cached?
  const cached = cache.get(address);
  if (cached && Date.now() - cached.calculated_at < CACHE_TTL) {
    return { status: 'ready', data: cached };
  }

  // Already in queue?
  const queued = queue.get(address);
  if (queued && Date.now() - queued.started_at < QUEUE_TIMEOUT) {
    return { status: queued.status, started_at: queued.started_at };
  }

  // Add to queue
  queue.set(address, { status: 'queued', started_at: Date.now() });
  log('INFO', `[WalletScore] Queued ${address.slice(0, 8)} for calculation`);

  // Process queue
  processQueue();

  return { status: 'queued', message: 'Calculation queued' };
}

/**
 * Process background queue
 */
async function processQueue() {
  if (activeCalculations >= MAX_CONCURRENT) return;

  // Find next queued wallet
  for (const [address, info] of queue.entries()) {
    if (info.status === 'queued') {
      activeCalculations++;
      queue.set(address, { ...info, status: 'calculating' });

      // Calculate in background
      calculateWalletKScoreInternal(address)
        .then(result => {
          cache.set(address, result);
          queue.delete(address);
          log('INFO', `[WalletScore] Completed ${address.slice(0, 8)}: K=${result.k_wallet}`);
        })
        .catch(err => {
          log('ERROR', `[WalletScore] Failed ${address.slice(0, 8)}: ${err.message}`);
          queue.set(address, { status: 'error', error: err.message, started_at: info.started_at });
        })
        .finally(() => {
          activeCalculations--;
          processQueue(); // Process next
        });

      break; // Only start one at a time
    }
  }
}

/**
 * Calculate global K_wallet score (internal)
 * Uses COMPLETE transaction history for accurate results
 * K_wallet = % of PumpFun tokens where retention >= 1
 */
async function calculateWalletKScoreInternal(address) {
  log('INFO', `[WalletScore] Calculating K for ${address.slice(0, 8)}...`);
  const startTime = Date.now();

  // Fetch COMPLETE PumpFun history (up to 5000 txs)
  const { positions, stats } = await helius.getCompletePumpFunHistory(address, {
    maxPages: 50,
    onProgress: ({ pages, positions }) => {
      if (pages % 10 === 0) {
        log('DEBUG', `[WalletScore] ${address.slice(0, 8)}: ${pages} pages, ${positions} tokens found`);
      }
    }
  });

  if (positions.size === 0) {
    return {
      address,
      k_wallet: null,
      tokens_analyzed: 0,
      tokens_total: 0,
      message: 'No PumpFun tokens found',
      calculated_at: Date.now(),
    };
  }

  // Convert positions Map to array for analysis
  const positionsList = Array.from(positions.values());

  // Override with local DB data for our tracked token
  const localData = await db.getWalletKScore(address);
  if (localData) {
    const ourToken = positionsList.find(p => p.mint === TOKEN_MINT);
    if (ourToken) {
      ourToken.retention = localData.retention;
      ourToken.classification = localData.classification;
      ourToken.data_quality = 'local_db';
    }
  }

  // Calculate K_wallet = % tokens with retention >= 1 (maintained or accumulated)
  const maintained = positionsList.filter(p => p.retention >= 1.0).length;
  const kWallet = Math.round((maintained / positionsList.length) * 1000) / 1000;

  // Breakdown by classification
  const accumulators = positionsList.filter(p => p.classification === 'accumulator').length;
  const holders = positionsList.filter(p => p.classification === 'holder').length;
  const reducers = positionsList.filter(p => p.classification === 'reducer').length;
  const extractors = positionsList.filter(p => p.classification === 'extractor').length;

  const elapsed = Date.now() - startTime;
  log('INFO', `[WalletScore] K=${Math.round(kWallet * 100)}% for ${address.slice(0, 8)} (${elapsed}ms, ${positionsList.length} tokens, ${stats.totalTxs} txs)`);

  const result = {
    address,
    k_wallet: kWallet,
    tokens_analyzed: positionsList.length,
    tokens_total: positionsList.length,
    maintained_count: maintained,
    breakdown: {
      accumulators,
      holders,
      reducers,
      extractors,
    },
    stats: {
      pages_fetched: stats.pages,
      total_transactions: stats.totalTxs,
      pump_transfers: stats.pumpTxs,
    },
    tokens: positionsList.map(p => ({
      mint: p.mint,
      retention: Math.round(p.retention * 1000) / 1000,
      classification: p.classification,
      total_bought: p.total_bought,
      total_sold: p.total_sold,
      current: p.current,
      tx_count: p.tx_count,
    })),
    calculated_at: Date.now(),
    calculation_time_ms: elapsed,
  };

  // Cache result
  cache.set(address, result);

  return result;
}

/**
 * Clear cache for a wallet (used after new transactions)
 */
export function clearWalletCache(address) {
  cache.delete(address);
}

/**
 * Clear all cache
 */
export function clearAllCache() {
  cache.clear();
}

/**
 * Get queue stats
 */
export function getQueueStats() {
  return {
    queue_size: queue.size,
    active_calculations: activeCalculations,
    cache_size: cache.size,
  };
}

// ============================================
// DB Queue Worker (scale-ready)
// ============================================

let workerRunning = false;
const WORKER_INTERVAL = 10 * 1000; // 10 seconds between jobs
const WORKER_BATCH_SIZE = 1; // Process 1 at a time (rate limit protection)
const STALE_CHECK_INTERVAL = 60 * 60 * 1000; // Check for stale wallets every hour
const K_WALLET_TTL = 24 * 60 * 60; // 24 hours before K_wallet is considered stale
let lastStaleCheck = 0;

/**
 * Start the K_wallet queue worker
 * Runs in background, processes queue from DB
 * Auto-backfills all holders on first run
 */
export async function startWorker() {
  if (workerRunning) {
    log('WARN', '[WalletScore] Worker already running');
    return;
  }

  workerRunning = true;
  log('INFO', '[WalletScore] Starting K_wallet queue worker');

  // Clear existing queue on startup to ensure clean state relative to current PoH
  try {
    await db.clearKWalletQueue();
    log('INFO', '[WalletScore] Cleared pending queue for fresh start');
  } catch (e) {
    log('ERROR', `[WalletScore] Failed to clear queue: ${e.message}`);
  }

  // Auto-backfill: Queue all holders without K_wallet on startup
  setTimeout(async () => {
    try {
      const result = await backfillAllHolders();
      if (result.queued > 0) {
        log('INFO', `[WalletScore] Auto-backfill: queued ${result.queued} holders for K_wallet calculation`);
      }
    } catch (error) {
      log('ERROR', `[WalletScore] Auto-backfill failed: ${error.message}`);
    }
  }, 5000); // Wait 5 seconds after server start

  processWorkerLoop();
}

/**
 * Stop the worker
 */
export function stopWorker() {
  workerRunning = false;
  log('INFO', '[WalletScore] Stopping K_wallet queue worker');
}

/**
 * Worker loop - processes DB queue
 * Also periodically checks for stale K_wallet entries and re-queues them
 */
async function processWorkerLoop() {
  while (workerRunning) {
    try {
      // Periodically check for stale wallets and re-queue them
      const now = Date.now();
      if (now - lastStaleCheck > STALE_CHECK_INTERVAL) {
        lastStaleCheck = now;
        await refreshStaleWallets();
      }

      // Get next wallet from queue
      const address = await db.dequeueKWallet();

      if (address) {
        log('INFO', `[WalletScore] Processing ${address.slice(0, 8)} from queue...`);

        try {
          // Get current PoH slot for ordering
          const currentSlot = await db.getLastProcessedSlot();

          // Calculate K_wallet
          const result = await calculateWalletKScoreInternal(address);

          if (result.k_wallet !== null) {
            // Save to DB with PoH slot
            const kWalletPct = Math.round(result.k_wallet * 100);
            await db.completeKWallet(address, kWalletPct, result.tokens_analyzed, currentSlot);
            log('INFO', `[WalletScore] Saved ${address.slice(0, 8)}: K=${kWalletPct}% (${result.tokens_analyzed} tokens)`);
          } else {
            // No tokens found - mark as complete with NULL
            await db.completeKWallet(address, null, 0, currentSlot);
            log('INFO', `[WalletScore] ${address.slice(0, 8)}: No PumpFun tokens`);
          }
        } catch (error) {
          log('ERROR', `[WalletScore] Failed ${address.slice(0, 8)}: ${error.message}`);
          await db.failKWallet(address, error.message);
        }
      }

      // Cleanup stale entries periodically
      await db.cleanupKWalletQueue(5);

    } catch (error) {
      log('ERROR', `[WalletScore] Worker error: ${error.message}`);
    }

    // Wait before next iteration
    await new Promise(resolve => setTimeout(resolve, WORKER_INTERVAL));
  }
}

/**
 * Refresh stale K_wallet entries
 * Called periodically to keep all holders' K_wallet up to date
 */
async function refreshStaleWallets() {
  try {
    const staleWallets = await db.getWalletsNeedingKWallet(50, K_WALLET_TTL);
    if (staleWallets.length > 0) {
      await db.enqueueKWalletBatch(staleWallets, 1); // Low priority for refresh
      log('INFO', `[WalletScore] Refresh: queued ${staleWallets.length} stale wallets`);
    }
  } catch (error) {
    log('ERROR', `[WalletScore] Refresh error: ${error.message}`);
  }
}

/**
 * Enqueue all holders for K_wallet backfill
 * Called via admin endpoint
 */
export async function backfillAllHolders() {
  // Use -1 to only get wallets that have NEVER been calculated (IS NULL)
  const wallets = await db.getWalletsNeedingKWallet(1000, -1);
  if (wallets.length === 0) {
    return { queued: 0, message: 'All wallets already have K_wallet calculated' };
  }

  await db.enqueueKWalletBatch(wallets, 0); // Low priority for backfill
  log('INFO', `[WalletScore] Backfill queued ${wallets.length} wallets`);

  return { queued: wallets.length };
}

/**
 * Enqueue a single wallet (high priority - triggered by tx)
 */
export async function enqueueWallet(address) {
  await db.enqueueKWallet(address, 10); // High priority for tx-triggered
  log('DEBUG', `[WalletScore] Enqueued ${address.slice(0, 8)} for K_wallet update`);
}

/**
 * Get K_wallet from DB (cached value)
 * Includes PoH slot for ordering verification
 */
export async function getKWalletFromDB(address) {
  const dbInstance = await db.getDb();
  const stmt = dbInstance.prepare('SELECT k_wallet, k_wallet_tokens, k_wallet_updated_at, k_wallet_slot FROM wallets WHERE address = ?');
  const row = stmt.get(address);

  if (!row || row.k_wallet === null) {
    return null;
  }

  return {
    k_wallet: row.k_wallet,
    tokens_analyzed: row.k_wallet_tokens,
    updated_at: row.k_wallet_updated_at,
    poh_slot: row.k_wallet_slot,
  };
}

export default {
  isPumpFunToken,
  getWalletStatus,
  queueWalletCalculation,
  clearWalletCache,
  clearAllCache,
  getQueueStats,
  // DB queue functions
  startWorker,
  stopWorker,
  backfillAllHolders,
  enqueueWallet,
  getKWalletFromDB,
};
