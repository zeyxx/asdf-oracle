/**
 * KOLscan Integration Module
 *
 * Fetches KOL (Key Opinion Leader) wallet data from KOLscan API.
 * Used with admin bypass to analyze KOL conviction patterns.
 *
 * Design: Modular, can be disabled, rate-limited
 */

import { log } from './utils.js';

const KOLSCAN_API = process.env.KOLSCAN_API_URL || 'https://api.kolscan.io';
const KOLSCAN_API_KEY = process.env.KOLSCAN_API_KEY || null;
const KOLSCAN_ENABLED = process.env.KOLSCAN_ENABLED !== 'false';

// Cache for KOL data (TTL: 1 hour)
const kolCache = new Map();
const CACHE_TTL = 60 * 60 * 1000;

/**
 * Check if KOLscan integration is available
 */
export function isAvailable() {
  return KOLSCAN_ENABLED && KOLSCAN_API_KEY !== null;
}

/**
 * Fetch KOL wallets from KOLscan
 * @param {object} options - { limit, category, minFollowers }
 * @returns {Promise<Array<{address: string, name: string, followers: number, category: string}>>}
 */
export async function fetchKOLWallets(options = {}) {
  if (!isAvailable()) {
    log('WARN', '[KOLscan] Integration not configured');
    return [];
  }

  const { limit = 100, category = null, minFollowers = 0 } = options;

  // Check cache
  const cacheKey = `kols:${limit}:${category}:${minFollowers}`;
  const cached = kolCache.get(cacheKey);
  if (cached && Date.now() - cached.fetched_at < CACHE_TTL) {
    log('DEBUG', `[KOLscan] Cache hit for ${cacheKey}`);
    return cached.data;
  }

  try {
    log('INFO', `[KOLscan] Fetching KOL wallets (limit=${limit})`);

    const params = new URLSearchParams({
      limit: limit.toString(),
      chain: 'solana'
    });
    if (category) params.append('category', category);
    if (minFollowers > 0) params.append('min_followers', minFollowers.toString());

    const response = await fetch(`${KOLSCAN_API}/v1/kols?${params}`, {
      headers: {
        'Authorization': `Bearer ${KOLSCAN_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`KOLscan API error: ${response.status}`);
    }

    const data = await response.json();
    const kols = (data.kols || data.data || []).map(k => ({
      address: k.wallet_address || k.address,
      name: k.name || k.username || 'Unknown',
      followers: k.followers || k.follower_count || 0,
      category: k.category || 'general',
      twitter: k.twitter_handle || k.twitter || null,
      verified: k.verified || false
    }));

    // Cache result
    kolCache.set(cacheKey, { data: kols, fetched_at: Date.now() });
    log('INFO', `[KOLscan] Fetched ${kols.length} KOL wallets`);

    return kols;
  } catch (error) {
    log('ERROR', `[KOLscan] Fetch error: ${error.message}`);
    return [];
  }
}

/**
 * Get KOL info by wallet address
 * @param {string} address - Solana wallet address
 * @returns {Promise<object|null>}
 */
export async function getKOLByAddress(address) {
  if (!isAvailable()) return null;

  // Check cache
  const cacheKey = `kol:${address}`;
  const cached = kolCache.get(cacheKey);
  if (cached && Date.now() - cached.fetched_at < CACHE_TTL) {
    return cached.data;
  }

  try {
    const response = await fetch(`${KOLSCAN_API}/v1/kol/${address}`, {
      headers: {
        'Authorization': `Bearer ${KOLSCAN_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      if (response.status === 404) return null;
      throw new Error(`KOLscan API error: ${response.status}`);
    }

    const data = await response.json();
    const kol = {
      address: data.wallet_address || address,
      name: data.name || data.username || 'Unknown',
      followers: data.followers || 0,
      category: data.category || 'general',
      twitter: data.twitter_handle || null,
      verified: data.verified || false
    };

    kolCache.set(cacheKey, { data: kol, fetched_at: Date.now() });
    return kol;
  } catch (error) {
    log('ERROR', `[KOLscan] Error fetching KOL ${address.slice(0, 8)}: ${error.message}`);
    return null;
  }
}

/**
 * Clear KOL cache
 */
export function clearCache() {
  kolCache.clear();
}

/**
 * Get integration status
 */
export function getStatus() {
  return {
    enabled: KOLSCAN_ENABLED,
    configured: KOLSCAN_API_KEY !== null,
    api_url: KOLSCAN_API,
    cache_size: kolCache.size
  };
}

export default {
  isAvailable,
  fetchKOLWallets,
  getKOLByAddress,
  clearCache,
  getStatus
};
