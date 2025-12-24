/**
 * API Keys & Usage Tracking Database Operations
 *
 * Multi-tenant API key management with rate limiting.
 * Uses LRU cache to reduce DB lookups.
 */

import { createHash, randomUUID } from 'crypto';
import { getDb } from './connection.js';
import { apiKeyCache } from '../cache.js';

/**
 * Hash an API key using SHA256
 */
function hashApiKey(key) {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * Generate a new API key
 */
function generateApiKey(tier = 'standard') {
  const random = randomUUID().replace(/-/g, '');
  return `oracle_${tier}_${random}`;
}

// Tier defaults
const TIER_LIMITS = {
  free:     { minute: 500,   day: 50000 },
  standard: { minute: 1000,  day: 100000 },
  premium:  { minute: 5000,  day: 500000 },
  internal: { minute: null,  day: null },
};

/**
 * Create a new API key
 */
export async function createApiKey({ name, tier = 'standard', rateLimitMinute, rateLimitDay, expiresAt }) {
  const db = await getDb();
  const id = randomUUID();
  const key = generateApiKey(tier);
  const keyHash = hashApiKey(key);
  const limits = TIER_LIMITS[tier] || TIER_LIMITS.standard;

  const stmt = db.prepare(`
    INSERT INTO api_keys (id, key_hash, name, tier, rate_limit_minute, rate_limit_day, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    id,
    keyHash,
    name,
    tier,
    rateLimitMinute ?? limits.minute,
    rateLimitDay ?? limits.day,
    expiresAt || null
  );

  return { id, key, name, tier };
}

/**
 * Validate an API key and return its metadata
 * Uses LRU cache to reduce DB lookups (5 min TTL)
 */
export async function validateApiKey(key) {
  if (!key) return null;

  const keyHash = hashApiKey(key);

  // Check cache first
  const cached = apiKeyCache.get(keyHash);
  if (cached !== undefined) {
    return cached; // Returns null for invalid keys too
  }

  const db = await getDb();
  const now = Math.floor(Date.now() / 1000);

  const stmt = db.prepare(`
    SELECT * FROM api_keys
    WHERE key_hash = ? AND is_active = 1
      AND (expires_at IS NULL OR expires_at > ?)
  `);
  const row = stmt.get(keyHash, now);

  // Cache the result (including null for invalid keys)
  apiKeyCache.set(keyHash, row || null);

  // Update last_used_at asynchronously (don't block response)
  if (row) {
    setImmediate(async () => {
      try {
        const updateStmt = db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?');
        updateStmt.run(now, row.id);
      } catch (e) {
        // Ignore update errors
      }
    });
  }

  return row || null;
}

/**
 * Invalidate API key cache (call after updates)
 */
export function invalidateApiKeyCache(key) {
  if (key) {
    const keyHash = hashApiKey(key);
    apiKeyCache.delete(keyHash);
  }
}

/**
 * Get API key by ID
 */
export async function getApiKey(id) {
  const db = await getDb();
  const stmt = db.prepare('SELECT * FROM api_keys WHERE id = ?');
  return stmt.get(id);
}

/**
 * List all API keys
 */
export async function listApiKeys({ activeOnly = true } = {}) {
  const db = await getDb();
  const stmt = activeOnly
    ? db.prepare('SELECT * FROM api_keys WHERE is_active = 1 ORDER BY created_at DESC')
    : db.prepare('SELECT * FROM api_keys ORDER BY created_at DESC');
  return stmt.all();
}

/**
 * Update API key
 */
export async function updateApiKey(id, { name, tier, rateLimitMinute, rateLimitDay, isActive, expiresAt }) {
  const db = await getDb();

  const updates = [];
  const params = [];

  if (name !== undefined) { updates.push('name = ?'); params.push(name); }
  if (tier !== undefined) { updates.push('tier = ?'); params.push(tier); }
  if (rateLimitMinute !== undefined) { updates.push('rate_limit_minute = ?'); params.push(rateLimitMinute); }
  if (rateLimitDay !== undefined) { updates.push('rate_limit_day = ?'); params.push(rateLimitDay); }
  if (isActive !== undefined) { updates.push('is_active = ?'); params.push(isActive ? 1 : 0); }
  if (expiresAt !== undefined) { updates.push('expires_at = ?'); params.push(expiresAt); }

  if (updates.length === 0) return false;

  params.push(id);
  const stmt = db.prepare(`UPDATE api_keys SET ${updates.join(', ')} WHERE id = ?`);
  const result = stmt.run(...params);
  return result.changes > 0;
}

/**
 * Revoke (soft delete) an API key
 */
export async function revokeApiKey(id) {
  const db = await getDb();
  const stmt = db.prepare('UPDATE api_keys SET is_active = 0 WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
}

/**
 * Hard delete an API key
 */
export async function deleteApiKey(id) {
  const db = await getDb();
  const stmt = db.prepare('DELETE FROM api_keys WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
}

// ============================================
// Usage Tracking
// ============================================

/**
 * Increment daily usage counter for an API key
 */
export async function incrementUsage(keyId) {
  const db = await getDb();
  const today = new Date().toISOString().split('T')[0];

  const stmt = db.prepare(`
    INSERT INTO usage_daily (key_id, date, requests)
    VALUES (?, ?, 1)
    ON CONFLICT(key_id, date) DO UPDATE SET requests = requests + 1
  `);
  stmt.run(keyId, today);
}

/**
 * Get today's usage for an API key
 */
export async function getTodayUsage(keyId) {
  const db = await getDb();
  const today = new Date().toISOString().split('T')[0];

  const stmt = db.prepare('SELECT requests FROM usage_daily WHERE key_id = ? AND date = ?');
  const row = stmt.get(keyId, today);
  return row?.requests || 0;
}

/**
 * Get usage history for an API key
 */
export async function getUsageHistory(keyId, days = 30) {
  const db = await getDb();
  const stmt = db.prepare(`
    SELECT date, requests FROM usage_daily
    WHERE key_id = ?
    ORDER BY date DESC
    LIMIT ?
  `);
  return stmt.all(keyId, days);
}

/**
 * Get usage stats for all keys
 */
export async function getUsageStats(days = 7) {
  const db = await getDb();
  const stmt = db.prepare(`
    SELECT
      k.id, k.name, k.tier,
      SUM(u.requests) as total_requests,
      MAX(u.date) as last_active
    FROM api_keys k
    LEFT JOIN usage_daily u ON k.id = u.key_id
      AND u.date >= date('now', '-' || ? || ' days')
    WHERE k.is_active = 1
    GROUP BY k.id
    ORDER BY total_requests DESC
  `);
  return stmt.all(days);
}

/**
 * Cleanup old usage data
 */
export async function cleanupUsageHistory(retentionDays = 90) {
  const db = await getDb();
  const stmt = db.prepare(`DELETE FROM usage_daily WHERE date < date('now', '-' || ? || ' days')`);
  stmt.run(retentionDays);
}

export default {
  createApiKey,
  validateApiKey,
  getApiKey,
  listApiKeys,
  updateApiKey,
  revokeApiKey,
  deleteApiKey,
  incrementUsage,
  getTodayUsage,
  getUsageHistory,
  getUsageStats,
  cleanupUsageHistory,
};
