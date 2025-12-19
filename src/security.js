/**
 * Security Module
 *
 * Rate limiting, input validation, and backup management.
 * Security by design, no single point of failure.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { log } from './utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

// ============================================
// Rate Limiting (in-memory, per IP)
// ============================================
const rateLimits = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 100; // requests per window

export function rateLimit(ip) {
  const now = Date.now();
  const key = ip || 'unknown';

  if (!rateLimits.has(key)) {
    rateLimits.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return { allowed: true, remaining: RATE_LIMIT_MAX - 1 };
  }

  const limit = rateLimits.get(key);

  if (now > limit.resetAt) {
    // Reset window
    limit.count = 1;
    limit.resetAt = now + RATE_LIMIT_WINDOW;
    return { allowed: true, remaining: RATE_LIMIT_MAX - 1 };
  }

  limit.count++;

  if (limit.count > RATE_LIMIT_MAX) {
    return { allowed: false, remaining: 0, retryAfter: Math.ceil((limit.resetAt - now) / 1000) };
  }

  return { allowed: true, remaining: RATE_LIMIT_MAX - limit.count };
}

// Cleanup old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, limit] of rateLimits.entries()) {
    if (now > limit.resetAt + RATE_LIMIT_WINDOW) {
      rateLimits.delete(key);
    }
  }
}, 5 * 60 * 1000);

// ============================================
// Input Validation
// ============================================
export function validateWebhookPayload(payload) {
  if (!payload) return { valid: false, error: 'Empty payload' };

  // Must be array or object
  if (typeof payload !== 'object') {
    return { valid: false, error: 'Invalid payload type' };
  }

  // Size limit (1MB)
  const size = JSON.stringify(payload).length;
  if (size > 1024 * 1024) {
    return { valid: false, error: 'Payload too large' };
  }

  return { valid: true };
}

export function validateAddress(address) {
  // Solana address: 32-44 base58 characters
  if (!address || typeof address !== 'string') return false;
  if (address.length < 32 || address.length > 44) return false;

  // Base58 characters only
  const base58Regex = /^[1-9A-HJ-NP-Za-km-z]+$/;
  return base58Regex.test(address);
}

export function sanitizeNumber(value, defaultValue = 0, max = Number.MAX_SAFE_INTEGER) {
  const num = parseInt(value);
  if (isNaN(num) || num < 0) return defaultValue;
  if (num > max) return max;
  return num;
}

// ============================================
// Database Backup
// ============================================
export async function createBackup() {
  const dbPath = path.join(DATA_DIR, 'k-metric.db');

  if (!fs.existsSync(dbPath)) {
    log('WARN', 'No database to backup');
    return null;
  }

  // Ensure backup directory exists
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }

  // Create timestamped backup
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(BACKUP_DIR, `k-metric-${timestamp}.db`);

  try {
    fs.copyFileSync(dbPath, backupPath);
    log('INFO', `Backup created: ${backupPath}`);

    // Keep only last 5 backups
    await cleanOldBackups(5);

    return backupPath;
  } catch (error) {
    log('ERROR', `Backup failed: ${error.message}`);
    return null;
  }
}

async function cleanOldBackups(keepCount) {
  if (!fs.existsSync(BACKUP_DIR)) return;

  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('k-metric-') && f.endsWith('.db'))
    .sort()
    .reverse();

  // Delete old backups
  for (let i = keepCount; i < files.length; i++) {
    const filePath = path.join(BACKUP_DIR, files[i]);
    fs.unlinkSync(filePath);
    log('DEBUG', `Deleted old backup: ${files[i]}`);
  }
}

export async function restoreFromBackup(backupPath) {
  const dbPath = path.join(DATA_DIR, 'k-metric.db');

  if (!fs.existsSync(backupPath)) {
    log('ERROR', `Backup not found: ${backupPath}`);
    return false;
  }

  try {
    // Create backup of current before restore
    if (fs.existsSync(dbPath)) {
      const preRestorePath = path.join(BACKUP_DIR, 'pre-restore.db');
      fs.copyFileSync(dbPath, preRestorePath);
    }

    fs.copyFileSync(backupPath, dbPath);
    log('INFO', `Restored from: ${backupPath}`);
    return true;
  } catch (error) {
    log('ERROR', `Restore failed: ${error.message}`);
    return false;
  }
}

export function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];

  return fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('k-metric-') && f.endsWith('.db'))
    .map(f => ({
      name: f,
      path: path.join(BACKUP_DIR, f),
      size: fs.statSync(path.join(BACKUP_DIR, f)).size,
      created: fs.statSync(path.join(BACKUP_DIR, f)).mtime,
    }))
    .sort((a, b) => b.created - a.created);
}

// ============================================
// Request Logging (security audit)
// ============================================
const requestLog = [];
const MAX_LOG_SIZE = 1000;

export function logRequest(req, status) {
  const entry = {
    timestamp: new Date().toISOString(),
    method: req.method,
    path: req.url,
    ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown',
    userAgent: req.headers['user-agent']?.substring(0, 100),
    status,
  };

  requestLog.push(entry);

  // Keep log size bounded
  if (requestLog.length > MAX_LOG_SIZE) {
    requestLog.shift();
  }

  return entry;
}

export function getRequestLog(limit = 100) {
  return requestLog.slice(-limit);
}

// ============================================
// Scheduled Backup (every 6 hours)
// ============================================
let backupInterval = null;

export function startScheduledBackups(intervalMs = 6 * 60 * 60 * 1000) {
  if (backupInterval) return;

  log('INFO', `Scheduled backups enabled (every ${intervalMs / 3600000}h)`);

  // Initial backup after 1 minute
  setTimeout(() => createBackup(), 60 * 1000);

  // Regular backups
  backupInterval = setInterval(() => createBackup(), intervalMs);
}

export function stopScheduledBackups() {
  if (backupInterval) {
    clearInterval(backupInterval);
    backupInterval = null;
  }
}

export default {
  rateLimit,
  validateWebhookPayload,
  validateAddress,
  sanitizeNumber,
  createBackup,
  restoreFromBackup,
  listBackups,
  logRequest,
  getRequestLog,
  startScheduledBackups,
  stopScheduledBackups,
};
