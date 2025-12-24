/**
 * API v1 Routes (/api/v1)
 *
 * External Oracle API for consumers (ASDev, etc.)
 */

import db from '../db.js';
import calculator from '../calculator.js';
import walletScore from '../wallet-score.js';
import tokenScore from '../token-score.js';
import security from '../security.js';
import { log } from '../utils.js';
import { sendJson } from './utils.js';

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
 */
async function handleApiV1Token(req, res, params) {
  try {
    const mint = params[0];

    if (!security.validateAddress(mint)) {
      return sendJson(res, 400, { error: 'Invalid token mint address' });
    }

    if (!tokenScore.isValidToken(mint)) {
      return sendJson(res, 400, {
        error: 'Invalid token type',
        message: 'Only PumpFun (*pump), Ignition (*asdf), and dev.fun (*dev) tokens are supported',
      });
    }

    const result = await tokenScore.getTokenK(mint);

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
 */
async function handleApiV1Wallet(req, res, params) {
  try {
    const address = params[0];

    if (!security.validateAddress(address)) {
      return sendJson(res, 400, { error: 'Invalid wallet address' });
    }

    const kToken = await db.getWalletKScore(address);
    const kWalletDB = await walletScore.getKWalletFromDB(address);
    let kWalletResult = null;

    if (kWalletDB) {
      kWalletResult = {
        k_wallet: kWalletDB.k_wallet,
        tokens_analyzed: kWalletDB.tokens_analyzed,
        updated_at: kWalletDB.updated_at,
      };
    } else {
      await walletScore.enqueueWallet(address);
      kWalletResult = {
        status: 'queued',
        message: 'K_wallet calculation queued',
      };
    }

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
        hold_days: kToken.holdDays,
        is_og: kToken.isOG,
      } : null,
      k_wallet: kWalletResult,
    });
  } catch (error) {
    log('ERROR', `API v1 wallet error: ${error.message}`);
    sendJson(res, 500, { error: error.message });
  }
}

/**
 * POST /api/v1/wallets - Batch wallet K scores
 */
async function handleApiV1WalletsBatch(req, res) {
  try {
    const { addresses, filters = {} } = req.body || {};

    if (!Array.isArray(addresses) || addresses.length === 0) {
      return sendJson(res, 400, { error: 'addresses array required' });
    }

    if (addresses.length > 100) {
      return sendJson(res, 400, { error: 'Maximum 100 addresses per request' });
    }

    const validAddresses = addresses.filter(addr => security.validateAddress(addr));
    if (validAddresses.length === 0) {
      return sendJson(res, 400, { error: 'No valid addresses provided' });
    }

    const results = [];
    let ready = 0, queued = 0, calculating = 0;

    for (const address of validAddresses) {
      const kWalletDB = await walletScore.getKWalletFromDB(address);

      if (kWalletDB) {
        if (filters.k_min !== undefined && kWalletDB.k_wallet < filters.k_min) continue;

        const kToken = await db.getWalletKScore(address);
        const classification = kToken?.classification || null;

        if (filters.classification && classification !== filters.classification) continue;

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
        const status = walletScore.getWalletStatus(address);

        if (status.status === 'calculating') {
          results.push({ address, status: 'calculating', started_at: status.started_at });
          calculating++;
        } else {
          await walletScore.enqueueWallet(address);
          results.push({ address, status: 'queued' });
          queued++;
        }
      }
    }

    sendJson(res, 200, {
      results,
      summary: { total: validAddresses.length, ready, queued, calculating, filtered_out: validAddresses.length - results.length },
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
 */
async function handleApiV1TokensBatch(req, res) {
  try {
    const { mints, filters = {} } = req.body || {};

    if (!Array.isArray(mints) || mints.length === 0) {
      return sendJson(res, 400, { error: 'mints array required' });
    }

    if (mints.length > 50) {
      return sendJson(res, 400, { error: 'Maximum 50 tokens per request' });
    }

    const validMints = mints.filter(mint => security.validateAddress(mint) && tokenScore.isValidToken(mint));

    if (validMints.length === 0) {
      return sendJson(res, 400, {
        error: 'No valid token mints provided',
        hint: 'Only PumpFun (*pump), Ignition (*asdf), and dev.fun (*dev) tokens are supported',
      });
    }

    const results = [];
    let ready = 0, queued = 0, syncing = 0;

    for (const mint of validMints) {
      const result = await tokenScore.getTokenK(mint);

      if (result.k !== undefined && filters.k_min !== undefined && result.k < filters.k_min) continue;

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
      summary: { total: validMints.length, ready, queued, syncing, filtered_out: validMints.length - results.length },
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
 */
async function handleApiV1Holders(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const kMin = url.searchParams.get('k_min') ? parseInt(url.searchParams.get('k_min')) : null;
    const classification = url.searchParams.get('classification') || null;
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '100'), 500);

    const validClassifications = ['accumulator', 'holder', 'reducer', 'extractor'];
    if (classification && !validClassifications.includes(classification)) {
      return sendJson(res, 400, { error: 'Invalid classification', valid: validClassifications });
    }

    const holders = await db.getHoldersFiltered({ kMin, classification, limit });

    const breakdown = { accumulator: 0, holder: 0, reducer: 0, extractor: 0 };
    holders.forEach(h => {
      if (breakdown[h.classification] !== undefined) breakdown[h.classification]++;
    });

    sendJson(res, 200, {
      holders,
      total: holders.length,
      breakdown,
      filters_applied: { k_min: kMin, classification, limit },
    });
  } catch (error) {
    log('ERROR', `API v1 holders error: ${error.message}`);
    sendJson(res, 500, { error: error.message });
  }
}

// Route definitions
export const routes = {
  'GET /api/v1/status': handleApiV1Status,
  'GET /api/v1/holders': handleApiV1Holders,
  'POST /api/v1/wallets': handleApiV1WalletsBatch,
  'POST /api/v1/tokens': handleApiV1TokensBatch,
};

export const dynamicRoutes = [
  { pattern: /^GET \/api\/v1\/token\/([A-Za-z0-9]{32,44})$/, handler: handleApiV1Token },
  { pattern: /^GET \/api\/v1\/wallet\/([A-Za-z0-9]{32,44})$/, handler: handleApiV1Wallet },
];

export default { routes, dynamicRoutes };
