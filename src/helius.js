/**
 * Helius API Client
 *
 * Optimized for high-volume transaction fetching with rate limiting.
 */

import { loadEnv } from './utils.js';

loadEnv();

const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const TOKEN_MINT = process.env.TOKEN_MINT;

// Known DEX/AMM program IDs - VERIFIED from official sources
// Sources: Raydium docs, Orca GitHub, Meteora docs, Solscan, Bitquery
const DEX_PROGRAMS = new Set([
  // Raydium (verified: docs.raydium.io/raydium/protocol/developers/addresses)
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM v4
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
  '5quBtoiQqxF9Jv6KYKctB59NT3gtJD2Y65kdnB1Uev3h', // Raydium Stable AMM
  // Orca (verified: github.com/orca-so/whirlpools)
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // Orca Whirlpool
  // Meteora (verified: solscan.io + docs.meteora.ag)
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', // Meteora DLMM
  // OpenBook/Serum (verified: github.com/openbook-dex/resources)
  'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX', // OpenBook DEX (Serum fork)
  '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', // Serum DEX v3 (legacy)
  'opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EohpZb', // OpenBook v2
  // PumpFun (verified: solscan.io + bitquery docs)
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',  // PumpFun Program
  '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg', // PumpFun Migration
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', // PumpSwap AMM
]);

// Known pool/fee wallets (not programs, but still pools)
const KNOWN_POOL_WALLETS = new Set([
  'CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM', // PumpFun Fee Recipient
]);

// Cache for pool detection results (address -> {isPool, owner, checkedAt})
const poolCache = new Map();
const POOL_CACHE_TTL = 3600000; // 1 hour

// Rate limiting
const RATE_LIMIT = 50; // Requests per second (adjust based on Helius plan)
const REQUEST_INTERVAL = 1000 / RATE_LIMIT;
let lastRequestTime = 0;

async function rateLimitedFetch(url, options) {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;

  if (timeSinceLastRequest < REQUEST_INTERVAL) {
    await delay(REQUEST_INTERVAL - timeSinceLastRequest);
  }

  lastRequestTime = Date.now();
  return fetch(url, options);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function rpc(method, params) {
  const response = await rateLimitedFetch(HELIUS_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.result;
}

/**
 * Fetch all current token holders
 */
export async function fetchHolders() {
  console.log('[Helius] Fetching holders...');
  const holders = [];
  let cursor = null;

  while (true) {
    const params = { mint: TOKEN_MINT, limit: 1000 };
    if (cursor) params.cursor = cursor;

    const result = await rpc('getTokenAccounts', params);
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

  console.log(`[Helius] Found ${holders.length} holders`);
  return holders;
}

/**
 * Fetch all transactions for the token mint (streaming)
 * @param {Function} onBatch - Callback for each batch of transactions
 * @param {string} afterSignature - Resume from this signature (optional)
 */
export async function streamMintTransactions(onBatch, afterSignature = null) {
  console.log('[Helius] Streaming mint transactions...');
  let paginationToken = null;
  let totalProcessed = 0;
  let page = 0;

  while (true) {
    page++;
    const params = [TOKEN_MINT, {
      transactionDetails: 'full',
      encoding: 'jsonParsed',
      maxSupportedTransactionVersion: 0,
      sortOrder: 'asc',
      limit: 100,
    }];

    if (paginationToken) params[1].paginationToken = paginationToken;

    try {
      const result = await rpc('getTransactionsForAddress', params);
      if (!result?.data || result.data.length === 0) break;

      // Process batch
      const processed = await onBatch(result.data);
      totalProcessed += result.data.length;

      if (page % 100 === 0) {
        console.log(`[Helius] Processed ${totalProcessed} transactions...`);
      }

      paginationToken = result.paginationToken;
      if (!paginationToken) break;
    } catch (error) {
      console.error(`[Helius] Error fetching transactions: ${error.message}`);
      // Wait and retry
      await delay(5000);
    }
  }

  console.log(`[Helius] Finished: ${totalProcessed} total transactions`);
  return totalProcessed;
}

/**
 * Fetch token info (price, supply, etc.)
 * Uses DexScreener for on-chain price and CoinGecko for SOL/USD
 */
export async function fetchTokenInfo() {
  try {
    // Get supply from chain
    const supply = await rpc('getTokenSupply', [TOKEN_MINT]);
    const totalSupply = parseInt(supply?.value?.amount || '0');

    // Get SOL price from CoinGecko (free, reliable)
    let solPrice = 0;
    try {
      const solRes = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
      const solData = await solRes.json();
      solPrice = solData?.solana?.usd || 0;
    } catch (e) {
      console.error('[Helius] CoinGecko error:', e.message);
    }

    // Get token price from DexScreener (on-chain data)
    let priceUsd = 0;
    let priceNative = 0;
    let liquidity = 0;
    let fdv = 0;
    try {
      const dexRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${TOKEN_MINT}`);
      const dexData = await dexRes.json();
      const pair = dexData?.pairs?.[0];
      if (pair) {
        priceUsd = parseFloat(pair.priceUsd) || 0;
        priceNative = parseFloat(pair.priceNative) || 0;
        liquidity = pair.liquidity?.usd || 0;
        fdv = pair.fdv || 0;
      }
    } catch (e) {
      console.error('[Helius] DexScreener error:', e.message);
    }

    // Fallback: calculate USD price from native price * SOL price
    if (priceUsd === 0 && priceNative > 0 && solPrice > 0) {
      priceUsd = priceNative * solPrice;
    }

    return {
      mint: TOKEN_MINT,
      symbol: process.env.TOKEN_SYMBOL || 'TOKEN',
      price: priceUsd,
      priceNative,
      solPrice,
      supply: totalSupply,
      liquidity,
      fdv,
      mcap: fdv || (priceUsd * (totalSupply / 1e6)),
    };
  } catch (error) {
    console.error('[Helius] Error fetching token info:', error.message);
    return { mint: TOKEN_MINT, symbol: process.env.TOKEN_SYMBOL, price: 0, supply: 0, mcap: 0 };
  }
}

/**
 * Parse transaction to extract token balance changes
 * Includes Solana PoH slot for ordering
 */
export function parseTransaction(tx) {
  if (!tx.meta || tx.meta.err) return [];

  const changes = [];
  const preBalances = new Map();
  const postBalances = new Map();

  // Get PoH slot - this is the Solana Proof of History ordering key
  const slot = tx.slot || 0;

  // Collect pre-balances
  for (const bal of tx.meta.preTokenBalances || []) {
    if (bal.mint === TOKEN_MINT && bal.owner) {
      preBalances.set(bal.owner, parseInt(bal.uiTokenAmount?.amount || '0'));
    }
  }

  // Collect post-balances
  for (const bal of tx.meta.postTokenBalances || []) {
    if (bal.mint === TOKEN_MINT && bal.owner) {
      postBalances.set(bal.owner, parseInt(bal.uiTokenAmount?.amount || '0'));
    }
  }

  // Calculate changes
  const allWallets = new Set([...preBalances.keys(), ...postBalances.keys()]);
  for (const wallet of allWallets) {
    const pre = preBalances.get(wallet) || 0;
    const post = postBalances.get(wallet) || 0;
    const diff = post - pre;

    if (diff !== 0) {
      changes.push({
        signature: tx.transaction?.signatures?.[0],
        slot, // PoH slot for ordering
        blockTime: tx.blockTime,
        wallet,
        amountChange: diff,
        preBalance: pre,
        postBalance: post,
      });
    }
  }

  return changes;
}

/**
 * Enhanced Transactions API - get parsed transaction history
 * Much faster than manual RPC parsing
 * @param {string} address - Wallet address
 * @param {object} options - { type, limit, before }
 */
export async function getEnhancedTransactions(address, options = {}) {
  const params = new URLSearchParams({
    'api-key': HELIUS_API_KEY,
  });

  if (options.type) params.append('type', options.type);
  if (options.limit) params.append('limit', options.limit.toString());
  if (options.before) params.append('before', options.before);

  const url = `https://api-mainnet.helius-rpc.com/v0/addresses/${address}/transactions?${params}`;

  const response = await rateLimitedFetch(url, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`Enhanced API error: ${response.status}`);
  }

  return response.json();
}

/**
 * Get token transfer history for a wallet
 * Returns parsed transfers with token info
 */
export async function getTokenTransfers(address, options = {}) {
  const limit = options.limit || 100;
  let allTransfers = [];
  let before = null;
  let pages = 0;
  const maxPages = options.maxPages || 3;

  while (pages < maxPages) {
    const txs = await getEnhancedTransactions(address, {
      limit: Math.min(limit, 100),
      before,
    });

    if (!txs || txs.length === 0) break;

    // Extract token transfers from parsed transactions
    for (const tx of txs) {
      if (tx.tokenTransfers && tx.tokenTransfers.length > 0) {
        for (const transfer of tx.tokenTransfers) {
          allTransfers.push({
            signature: tx.signature,
            timestamp: tx.timestamp,
            mint: transfer.mint,
            fromUser: transfer.fromUserAccount,
            toUser: transfer.toUserAccount,
            amount: transfer.tokenAmount,
          });
        }
      }
    }

    before = txs[txs.length - 1].signature;
    pages++;

    if (txs.length < 100) break; // No more pages
  }

  return allTransfers;
}

/**
 * Get COMPLETE PumpFun trading history for a wallet
 * Fetches ALL transactions, builds position map for each token
 *
 * @param {string} address - Wallet address
 * @param {object} options - { maxPages: 50, onProgress: fn }
 * @returns {object} { positions: Map<mint, Position>, stats }
 */
export async function getCompletePumpFunHistory(address, options = {}) {
  const maxPages = options.maxPages || 50; // Up to 5000 transactions
  const onProgress = options.onProgress || (() => {});

  // Position map: mint -> { first_buy_ts, first_buy_amount, total_bought, total_sold, current, txs }
  const positions = new Map();
  let before = null;
  let pages = 0;
  let totalTxs = 0;
  let pumpTxs = 0;

  console.log(`[Helius] Fetching complete history for ${address.slice(0, 8)}...`);

  while (pages < maxPages) {
    const txs = await getEnhancedTransactions(address, {
      limit: 100,
      before,
    });

    if (!txs || txs.length === 0) break;
    totalTxs += txs.length;

    // Process each transaction
    for (const tx of txs) {
      if (!tx.tokenTransfers || tx.tokenTransfers.length === 0) continue;

      for (const transfer of tx.tokenTransfers) {
        const mint = transfer.mint;
        if (!mint) continue;

        // Check if PumpFun or dev.fun token
        const lowerMint = mint.toLowerCase();
        const isPumpToken = lowerMint.endsWith('pump') || lowerMint.endsWith('asdf');
        const isDevToken = lowerMint.endsWith('dev');
        if (!isPumpToken && !isDevToken) continue;

        pumpTxs++;
        const amount = transfer.tokenAmount || 0;
        const isReceive = transfer.toUserAccount === address;
        const isSend = transfer.fromUserAccount === address;

        // Get or create position
        if (!positions.has(mint)) {
          positions.set(mint, {
            mint,
            first_buy_ts: null,
            first_buy_amount: 0,
            total_bought: 0,
            total_sold: 0,
            current: 0,
            last_tx_ts: null,
            tx_count: 0,
          });
        }

        const pos = positions.get(mint);
        pos.tx_count++;
        pos.last_tx_ts = tx.timestamp;

        if (isReceive) {
          pos.total_bought += amount;
          pos.current += amount;
          // Track first buy (we're going backwards in time, so update on each receive)
          pos.first_buy_ts = tx.timestamp;
          pos.first_buy_amount = amount; // Will be overwritten by earlier buys
        }

        if (isSend) {
          pos.total_sold += amount;
          pos.current -= amount;
        }
      }
    }

    before = txs[txs.length - 1].signature;
    pages++;
    onProgress({ pages, totalTxs, pumpTxs, positions: positions.size });

    // Continue if we got any results (Helius can return < 100 even if more exist)
    if (txs.length === 0) break;
  }

  // Fix first_buy_amount: since we went backwards, we need to find the actual first buy
  // The last "first_buy" we saw is actually the earliest
  // But current balance might be negative due to airdrops received before buys
  // Normalize: if current < 0, set to 0
  for (const [mint, pos] of positions) {
    if (pos.current < 0) pos.current = 0;

    // Calculate retention
    if (pos.first_buy_amount > 0) {
      pos.retention = pos.current / pos.first_buy_amount;
    } else if (pos.total_bought > 0) {
      pos.retention = pos.current / pos.total_bought;
    } else {
      pos.retention = 0;
    }

    // Classify
    if (pos.retention >= 1.5) pos.classification = 'accumulator';
    else if (pos.retention >= 1.0) pos.classification = 'holder';
    else if (pos.retention >= 0.5) pos.classification = 'reducer';
    else if (pos.current > 0) pos.classification = 'reducer';
    else pos.classification = 'extractor';
  }

  console.log(`[Helius] Complete: ${pages} pages, ${totalTxs} txs, ${pumpTxs} pump transfers, ${positions.size} unique tokens`);

  return {
    positions,
    stats: {
      pages,
      totalTxs,
      pumpTxs,
      uniqueTokens: positions.size,
    }
  };
}

/**
 * Check if an address is a DEX liquidity pool
 * Checks account owner against known DEX program IDs
 * @param {string} address - Wallet address to check
 * @returns {Promise<{isPool: boolean, owner: string|null, program: string|null}>}
 */
export async function checkIfPool(address) {
  // Check known pool wallets first (instant)
  if (KNOWN_POOL_WALLETS.has(address)) {
    return { isPool: true, owner: null, program: 'known_pool_wallet' };
  }

  // Check cache
  const cached = poolCache.get(address);
  if (cached && Date.now() - cached.checkedAt < POOL_CACHE_TTL) {
    return { isPool: cached.isPool, owner: cached.owner, program: cached.program };
  }

  try {
    // Get account info to check owner
    const accountInfo = await rpc('getAccountInfo', [address, { encoding: 'base64' }]);

    if (!accountInfo?.value) {
      // Account doesn't exist or is a system account (wallet)
      const result = { isPool: false, owner: null, program: null };
      poolCache.set(address, { ...result, checkedAt: Date.now() });
      return result;
    }

    const owner = accountInfo.value.owner;
    const isPool = DEX_PROGRAMS.has(owner);
    const program = isPool ? owner : null;

    const result = { isPool, owner, program };
    poolCache.set(address, { ...result, checkedAt: Date.now() });
    return result;
  } catch (error) {
    console.error(`[Helius] Pool check error for ${address.slice(0, 8)}:`, error.message);
    return { isPool: false, owner: null, program: null, error: error.message };
  }
}

/**
 * Batch check multiple addresses for pool status
 * @param {string[]} addresses - Array of addresses to check
 * @returns {Promise<Map<string, {isPool: boolean, owner: string|null}>>}
 */
export async function batchCheckPools(addresses) {
  const results = new Map();

  // Filter out cached results
  const uncached = [];
  for (const addr of addresses) {
    if (KNOWN_POOL_WALLETS.has(addr)) {
      results.set(addr, { isPool: true, owner: null, program: 'known_pool_wallet' });
      continue;
    }

    const cached = poolCache.get(addr);
    if (cached && Date.now() - cached.checkedAt < POOL_CACHE_TTL) {
      results.set(addr, { isPool: cached.isPool, owner: cached.owner, program: cached.program });
    } else {
      uncached.push(addr);
    }
  }

  // Batch RPC call for uncached addresses
  if (uncached.length > 0) {
    try {
      const accountInfos = await rpc('getMultipleAccounts', [uncached, { encoding: 'base64' }]);

      for (let i = 0; i < uncached.length; i++) {
        const addr = uncached[i];
        const info = accountInfos?.value?.[i];

        if (!info) {
          results.set(addr, { isPool: false, owner: null, program: null });
          poolCache.set(addr, { isPool: false, owner: null, program: null, checkedAt: Date.now() });
          continue;
        }

        const owner = info.owner;
        const isPool = DEX_PROGRAMS.has(owner);
        const program = isPool ? owner : null;

        results.set(addr, { isPool, owner, program });
        poolCache.set(addr, { isPool, owner, program, checkedAt: Date.now() });
      }
    } catch (error) {
      console.error('[Helius] Batch pool check error:', error.message);
      // Mark all as unknown
      for (const addr of uncached) {
        results.set(addr, { isPool: false, owner: null, program: null, error: error.message });
      }
    }
  }

  return results;
}

export default {
  rpc,
  fetchHolders,
  streamMintTransactions,
  fetchTokenInfo,
  parseTransaction,
  getEnhancedTransactions,
  getTokenTransfers,
  getCompletePumpFunHistory,
  checkIfPool,
  batchCheckPools,
};
