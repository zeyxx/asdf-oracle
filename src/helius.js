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

export default {
  rpc,
  fetchHolders,
  streamMintTransactions,
  fetchTokenInfo,
  parseTransaction,
};
