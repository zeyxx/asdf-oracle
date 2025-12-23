/**
 * Token K Score Calculator
 *
 * Calculates K-Metric for ANY PumpFun/Ignition token.
 * Same precision as $ASDFASDFA but computed on-demand.
 *
 * K = (maintained + accumulators) / total_holders
 *
 * Where:
 *   - Accumulator: retention >= 1.5 (bought more)
 *   - Maintained:  retention >= 1.0 (never sold)
 *   - Reducer:     retention >= 0.5 (sold some)
 *   - Extractor:   retention < 0.5  (paper hands)
 *
 *   retention = current_balance / first_buy_amount
 */

import db from './db.js';
import helius from './helius.js';
import calculator from './calculator.js';
import { log } from './utils.js';

const TOKEN_MINT = process.env.TOKEN_MINT; // Primary token ($ASDFASDFA)
const TOKEN_K_TTL = 3600; // 1 hour cache
const MAX_HOLDERS_TO_ANALYZE = 50; // Sample top 50 holders for speed
const PARALLEL_CONCURRENCY = 5; // Process 5 holders in parallel

/**
 * Check if token is PumpFun or Ignition (dev.fun)
 */
export function isValidToken(mint) {
  const lower = mint.toLowerCase();
  return lower.endsWith('pump') || lower.endsWith('asdf') || lower.endsWith('dev');
}

/**
 * Classify retention (same as K_wallet)
 */
function classifyRetention(retention) {
  if (retention >= 1.5) return 'accumulator';
  if (retention >= 1.0) return 'holder';
  if (retention >= 0.5) return 'reducer';
  return 'extractor';
}

/**
 * Get token K score (cached or calculate)
 * Returns cached result if fresh, otherwise queues for calculation
 */
export async function getTokenK(mint) {
  // Primary token uses existing calculator with full precision
  if (mint === TOKEN_MINT) {
    const result = await calculator.calculate();
    return {
      mint,
      k: result.k,
      holders: result.holders,
      accumulators: result.accumulators,
      maintained: result.neverSold, // never_sold = maintained in original schema
      reducers: result.holders - result.accumulators - result.neverSold,
      extractors: 0, // Not tracked in original
      tier: 1,
      quality: 'realtime',
      source: 'primary',
      cached: false,
    };
  }

  // Check cache
  const cached = await db.getToken(mint);

  if (cached && cached.k !== null) {
    const age = Math.floor(Date.now() / 1000) - cached.last_sync;
    const isFresh = age < TOKEN_K_TTL;

    if (isFresh || cached.sync_status === 'syncing') {
      return {
        mint,
        k: cached.k,
        holders: cached.holders,
        accumulators: cached.accumulators,
        maintained: cached.maintained,
        reducers: cached.reducers,
        extractors: cached.extractors,
        tier: cached.tier,
        quality: cached.tier === 2 ? 'tracked' : 'on-demand',
        source: 'cache',
        cached: true,
        age_seconds: age,
        stale: !isFresh,
        sync_status: cached.sync_status,
      };
    }

    // Stale - queue refresh but return cached
    await db.enqueueToken(mint, 5);
    return {
      mint,
      k: cached.k,
      holders: cached.holders,
      accumulators: cached.accumulators,
      maintained: cached.maintained,
      reducers: cached.reducers,
      extractors: cached.extractors,
      tier: cached.tier,
      quality: 'stale',
      source: 'cache',
      cached: true,
      age_seconds: age,
      stale: true,
      refreshing: true,
    };
  }

  // Not cached or sync in progress - check status
  if (cached?.sync_status === 'syncing') {
    return {
      mint,
      status: 'syncing',
      message: 'K calculation in progress',
      retry_after: 30,
    };
  }

  if (cached?.sync_status === 'queued') {
    return {
      mint,
      status: 'queued',
      message: 'K calculation queued',
      retry_after: 60,
    };
  }

  // Not found - queue for calculation
  await db.enqueueToken(mint, 10); // High priority for first request
  return {
    mint,
    status: 'queued',
    message: 'K calculation queued (first request)',
    retry_after: 60,
  };
}

/**
 * Calculate K for a token (internal - called by worker)
 * Fetches all holders and their history to compute accurate K
 */
export async function calculateTokenK(mint) {
  const startTime = Date.now();
  log('INFO', `[TokenScore] Calculating K for ${mint.slice(0, 8)}...`);

  try {
    // 1. Fetch all holders
    const holders = await fetchTokenHolders(mint);

    if (holders.length === 0) {
      return {
        mint,
        k: null,
        holders: 0,
        message: 'No holders found',
        duration_ms: Date.now() - startTime,
      };
    }

    log('INFO', `[TokenScore] Found ${holders.length} holders for ${mint.slice(0, 8)}`);

    // 2. For each holder, get their history and calculate retention
    // Use parallel processing with concurrency limit for speed
    const holdersToAnalyze = holders.slice(0, MAX_HOLDERS_TO_ANALYZE);
    const analyzed = [];

    // Process in batches of PARALLEL_CONCURRENCY
    for (let i = 0; i < holdersToAnalyze.length; i += PARALLEL_CONCURRENCY) {
      const batch = holdersToAnalyze.slice(i, i + PARALLEL_CONCURRENCY);

      const results = await Promise.allSettled(
        batch.map(async (holder) => {
          const history = await getHolderTokenHistory(holder.address, mint);

          if (history.first_buy_amount > 0) {
            const retention = history.current_balance / history.first_buy_amount;
            return {
              address: holder.address,
              current_balance: history.current_balance,
              first_buy_amount: history.first_buy_amount,
              retention,
              classification: classifyRetention(retention),
            };
          }
          return null;
        })
      );

      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          analyzed.push(result.value);
        }
      }

      // Progress log every batch
      log('INFO', `[TokenScore] Processed ${Math.min(i + PARALLEL_CONCURRENCY, holdersToAnalyze.length)}/${holdersToAnalyze.length} holders for ${mint.slice(0, 8)}`);
    }

    // 3. Calculate K
    const accumulators = analyzed.filter(h => h.classification === 'accumulator').length;
    const maintained = analyzed.filter(h => h.classification === 'holder').length;
    const reducers = analyzed.filter(h => h.classification === 'reducer').length;
    const extractors = analyzed.filter(h => h.classification === 'extractor').length;

    const k = analyzed.length > 0
      ? Math.round(((accumulators + maintained) / analyzed.length) * 100)
      : 0;

    const duration = Date.now() - startTime;
    log('INFO', `[TokenScore] K=${k}% for ${mint.slice(0, 8)} (${duration}ms, ${analyzed.length} analyzed)`);

    return {
      mint,
      k,
      holders: holders.length,
      analyzed: analyzed.length,
      accumulators,
      maintained,
      reducers,
      extractors,
      duration_ms: duration,
    };
  } catch (error) {
    log('ERROR', `[TokenScore] Failed to calculate K for ${mint}: ${error.message}`);
    throw error;
  }
}

/**
 * Fetch token holders using Helius RPC
 */
async function fetchTokenHolders(mint) {
  const holders = [];
  let cursor = null;

  while (true) {
    const params = { mint, limit: 1000 };
    if (cursor) params.cursor = cursor;

    const result = await helius.rpc('getTokenAccounts', params);
    if (!result?.token_accounts) break;

    for (const acc of result.token_accounts) {
      if (acc.amount > 0) {
        holders.push({
          address: acc.owner,
          balance: acc.amount,
        });
      }
    }

    cursor = result.cursor;
    if (!cursor) break;
  }

  // Sort by balance descending
  holders.sort((a, b) => b.balance - a.balance);

  return holders;
}

/**
 * Get holder's history for a specific token
 * Returns first_buy_amount and current_balance
 */
async function getHolderTokenHistory(walletAddress, mint) {
  let firstBuyAmount = 0;
  let firstBuyTs = null;
  let currentBalance = 0;
  let totalBought = 0;
  let totalSold = 0;

  // Fetch transaction history
  let before = null;
  const maxPages = 10; // Limit API calls per holder

  for (let page = 0; page < maxPages; page++) {
    const txs = await helius.getEnhancedTransactions(walletAddress, {
      limit: 100,
      before,
    });

    if (!txs || txs.length === 0) break;

    for (const tx of txs) {
      if (!tx.tokenTransfers) continue;

      for (const transfer of tx.tokenTransfers) {
        if (transfer.mint !== mint) continue;

        const amount = transfer.tokenAmount || 0;
        const isReceive = transfer.toUserAccount === walletAddress;
        const isSend = transfer.fromUserAccount === walletAddress;

        if (isReceive) {
          totalBought += amount;
          currentBalance += amount;
          // Track first buy (going backwards, so update each time)
          firstBuyTs = tx.timestamp;
          firstBuyAmount = amount;
        }

        if (isSend) {
          totalSold += amount;
          currentBalance -= amount;
        }
      }
    }

    before = txs[txs.length - 1].signature;
    if (txs.length < 100) break;
  }

  // Normalize
  if (currentBalance < 0) currentBalance = 0;

  return {
    first_buy_ts: firstBuyTs,
    first_buy_amount: firstBuyAmount,
    current_balance: currentBalance,
    total_bought: totalBought,
    total_sold: totalSold,
  };
}

// ============================================
// Background Worker
// ============================================

let workerRunning = false;
const WORKER_INTERVAL = 30 * 1000; // 30 seconds between jobs

/**
 * Start token K calculation worker
 */
export function startWorker() {
  if (workerRunning) {
    log('WARN', '[TokenScore] Worker already running');
    return;
  }

  workerRunning = true;
  log('INFO', '[TokenScore] Starting token K queue worker');

  processWorkerLoop();
}

/**
 * Stop the worker
 */
export function stopWorker() {
  workerRunning = false;
  log('INFO', '[TokenScore] Stopping token K queue worker');
}

/**
 * Worker loop
 */
async function processWorkerLoop() {
  while (workerRunning) {
    try {
      // Get next token from queue
      const mint = await db.dequeueToken();

      if (mint) {
        log('INFO', `[TokenScore] Processing ${mint.slice(0, 8)} from queue...`);

        try {
          const result = await calculateTokenK(mint);
          await db.completeToken(mint, result);
          log('INFO', `[TokenScore] Completed ${mint.slice(0, 8)}: K=${result.k}%`);
        } catch (error) {
          log('ERROR', `[TokenScore] Failed ${mint.slice(0, 8)}: ${error.message}`);
          await db.failToken(mint, error.message);
        }
      }

      // Cleanup stale entries
      await db.cleanupTokenQueue(3);

    } catch (error) {
      log('ERROR', `[TokenScore] Worker error: ${error.message}`);
    }

    await new Promise(resolve => setTimeout(resolve, WORKER_INTERVAL));
  }
}

/**
 * Get queue stats
 */
export async function getQueueStats() {
  return db.getTokenQueueStats();
}

export default {
  isValidToken,
  getTokenK,
  calculateTokenK,
  startWorker,
  stopWorker,
  getQueueStats,
};
