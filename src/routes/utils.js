/**
 * Route Utilities
 * Shared helpers for all route handlers
 */

import gating from '../gating.js';
import { log } from '../utils.js';

/**
 * Send JSON response
 */
export function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/**
 * Check admin access
 * @returns {boolean}
 */
export function requireAdmin(req) {
  const adminKey = req.headers['x-admin-key'];
  return gating.verifyAdminKey(adminKey);
}

/**
 * Verify Oracle API key
 * @returns {boolean}
 */
export function verifyOracleKey(req) {
  const key = req.headers['x-oracle-key'] || req.headers['authorization']?.replace('Bearer ', '');
  const ORACLE_API_KEY = process.env.ORACLE_API_KEY || process.env.ADMIN_API_KEY;
  return key === ORACLE_API_KEY;
}

/**
 * Require API key for request
 * Uses the API key attached by server.js middleware
 * @returns {object|null} API key metadata or null
 */
export function requireApiKey(req) {
  return req.apiKeyMeta || null;
}

/**
 * Log and return error response
 */
export function handleError(res, context, error) {
  log('ERROR', `${context}: ${error.message}`);
  sendJson(res, 500, { error: error.message });
}
