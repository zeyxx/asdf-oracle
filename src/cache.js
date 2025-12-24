/**
 * In-Memory Cache Layer
 *
 * Simple LRU cache implementation for high-performance caching.
 * Zero dependencies - native Node.js implementation.
 *
 * Features:
 * - LRU eviction when max size reached
 * - TTL-based expiration
 * - Namespace support for different cache types
 * - Stats tracking for monitoring
 */

/**
 * LRU Cache implementation using Map (maintains insertion order)
 */
class LRUCache {
  constructor(options = {}) {
    this.maxSize = options.maxSize || 1000;
    this.defaultTTL = options.ttl || 5 * 60 * 1000; // 5 minutes default
    this.cache = new Map();
    this.stats = { hits: 0, misses: 0, evictions: 0 };
  }

  /**
   * Get value from cache
   * @param {string} key
   * @returns {*} Value or undefined if not found/expired
   */
  get(key) {
    const entry = this.cache.get(key);

    if (!entry) {
      this.stats.misses++;
      return undefined;
    }

    // Check expiration
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.stats.misses++;
      return undefined;
    }

    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);

    this.stats.hits++;
    return entry.value;
  }

  /**
   * Set value in cache
   * @param {string} key
   * @param {*} value
   * @param {number} ttl - TTL in milliseconds (optional)
   */
  set(key, value, ttl = this.defaultTTL) {
    // Delete existing to update order
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    // Evict oldest entries if at capacity
    while (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
      this.stats.evictions++;
    }

    const entry = {
      value,
      expiresAt: ttl > 0 ? Date.now() + ttl : null,
      createdAt: Date.now(),
    };

    this.cache.set(key, entry);
    return this;
  }

  /**
   * Check if key exists and is not expired
   */
  has(key) {
    const entry = this.cache.get(key);
    if (!entry) return false;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Delete key from cache
   */
  delete(key) {
    return this.cache.delete(key);
  }

  /**
   * Clear all entries
   */
  clear() {
    this.cache.clear();
  }

  /**
   * Get cache size
   */
  get size() {
    return this.cache.size;
  }

  /**
   * Get cache stats
   */
  getStats() {
    const total = this.stats.hits + this.stats.misses;
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hits: this.stats.hits,
      misses: this.stats.misses,
      hitRate: total > 0 ? (this.stats.hits / total * 100).toFixed(1) + '%' : '0%',
      evictions: this.stats.evictions,
    };
  }

  /**
   * Cleanup expired entries (call periodically)
   */
  cleanup() {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, entry] of this.cache.entries()) {
      if (entry.expiresAt && now > entry.expiresAt) {
        this.cache.delete(key);
        cleaned++;
      }
    }
    return cleaned;
  }
}

// ============================================================
// Global Cache Instances
// ============================================================

// K-Metric cache (30 second TTL - frequently updated)
export const kMetricCache = new LRUCache({
  maxSize: 10,
  ttl: 30 * 1000,
});

// API Key cache (5 minute TTL - reduce DB lookups)
export const apiKeyCache = new LRUCache({
  maxSize: 1000,
  ttl: 5 * 60 * 1000,
});

// Wallet K-score cache (1 hour TTL)
export const walletCache = new LRUCache({
  maxSize: 10000,
  ttl: 60 * 60 * 1000,
});

// Token K-score cache (5 minute TTL)
export const tokenCache = new LRUCache({
  maxSize: 1000,
  ttl: 5 * 60 * 1000,
});

// Holder list cache (2 minute TTL)
export const holderCache = new LRUCache({
  maxSize: 100,
  ttl: 2 * 60 * 1000,
});

// Rate limit cache (1 minute window)
export const rateLimitCache = new LRUCache({
  maxSize: 50000, // Support 50k unique IPs
  ttl: 60 * 1000,
});

// ============================================================
// Cache Utilities
// ============================================================

/**
 * Get all cache stats for monitoring
 */
export function getAllCacheStats() {
  return {
    kMetric: kMetricCache.getStats(),
    apiKey: apiKeyCache.getStats(),
    wallet: walletCache.getStats(),
    token: tokenCache.getStats(),
    holder: holderCache.getStats(),
    rateLimit: rateLimitCache.getStats(),
  };
}

/**
 * Cleanup all caches (call periodically)
 */
export function cleanupAllCaches() {
  let total = 0;
  total += kMetricCache.cleanup();
  total += apiKeyCache.cleanup();
  total += walletCache.cleanup();
  total += tokenCache.cleanup();
  total += holderCache.cleanup();
  total += rateLimitCache.cleanup();
  return total;
}

// Periodic cleanup every 5 minutes
setInterval(() => {
  const cleaned = cleanupAllCaches();
  if (cleaned > 0) {
    console.log(`[Cache] Cleanup: removed ${cleaned} expired entries`);
  }
}, 5 * 60 * 1000);

// ============================================================
// Cache-through helpers
// ============================================================

/**
 * Get or compute value (cache-aside pattern)
 * @param {LRUCache} cache - Cache instance
 * @param {string} key - Cache key
 * @param {Function} compute - Async function to compute value if not cached
 * @param {number} ttl - Optional TTL override
 */
export async function getOrCompute(cache, key, compute, ttl) {
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const value = await compute();
  if (value !== undefined && value !== null) {
    cache.set(key, value, ttl);
  }
  return value;
}

/**
 * Invalidate cache entries by prefix
 * @param {LRUCache} cache - Cache instance
 * @param {string} prefix - Key prefix to invalidate
 */
export function invalidateByPrefix(cache, prefix) {
  let count = 0;
  for (const key of cache.cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
      count++;
    }
  }
  return count;
}

export { LRUCache };

export default {
  LRUCache,
  kMetricCache,
  apiKeyCache,
  walletCache,
  tokenCache,
  holderCache,
  rateLimitCache,
  getAllCacheStats,
  cleanupAllCaches,
  getOrCompute,
  invalidateByPrefix,
};
