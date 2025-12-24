#!/usr/bin/env node
/**
 * K-Metric Server
 *
 * Serves both API and frontend dashboard.
 *
 * Usage:
 *   node src/server.js
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { loadEnv, log } from './utils.js';
import router from './router.js';
import db from './db.js';
import calculator from './calculator.js';
import sync from './sync.js';
import walletScore from './wallet-score.js';
import tokenScore from './token-score.js';
import security from './security.js';
import webhooks from './webhooks.js';
import ws from './ws.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..');

loadEnv();

const PORT = process.env.PORT || 3001;

// CORS allowed origins (from env or defaults for dev)
const ALLOWED_ORIGINS = (() => {
  const envOrigins = process.env.CORS_ORIGINS?.split(',').map(s => s.trim()).filter(Boolean);
  if (envOrigins?.length) return new Set(envOrigins);
  // Default: localhost + GitHub Codespaces pattern
  return new Set([
    'http://localhost:3001',
    'http://127.0.0.1:3001',
  ]);
})();

// Check if origin is allowed
function isOriginAllowed(origin) {
  if (!origin) return true; // Same-origin requests have no Origin header
  if (ALLOWED_ORIGINS.has(origin)) return true;
  // Allow GitHub Codespaces URLs
  if (origin.match(/^https:\/\/.*\.app\.github\.dev$/)) return true;
  // Allow Render URLs (*.onrender.com)
  if (origin.match(/^https:\/\/.*\.onrender\.com$/)) return true;
  // Allow alonisthe.dev
  if (origin.match(/^https:\/\/(.*\.)?alonisthe\.dev$/)) return true;
  return false;
}

// MIME types for static files
const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Static file cache (LRU with 50 files max, 5 min TTL)
const staticFileCache = new Map();
const STATIC_CACHE_MAX_SIZE = 50;
const STATIC_CACHE_TTL = 5 * 60 * 1000;

/**
 * Serve static files with caching and async I/O
 */
async function serveStatic(req, res) {
  let filePath = req.url === '/' ? '/index.html' : req.url;

  // Clean routes (remove query params)
  filePath = filePath.split('?')[0];

  // Route /wallet to /wallet.html
  if (filePath === '/wallet') {
    filePath = '/wallet.html';
  }

  // Security: prevent directory traversal
  filePath = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, '');

  const fullPath = path.join(ROOT_DIR, filePath);
  const ext = path.extname(fullPath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  // Check cache first
  const cached = staticFileCache.get(fullPath);
  if (cached && Date.now() < cached.expiresAt) {
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=300',
      'X-Cache': 'HIT',
    });
    res.end(cached.content);
    return true;
  }

  // Async file read
  try {
    const stat = await fs.promises.stat(fullPath);
    if (stat.isDirectory()) {
      return false;
    }

    const content = await fs.promises.readFile(fullPath);

    // Cache the file (LRU eviction)
    if (staticFileCache.size >= STATIC_CACHE_MAX_SIZE) {
      const oldestKey = staticFileCache.keys().next().value;
      staticFileCache.delete(oldestKey);
    }
    staticFileCache.set(fullPath, {
      content,
      expiresAt: Date.now() + STATIC_CACHE_TTL,
    });

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=300',
      'X-Cache': 'MISS',
    });
    res.end(content);
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Start daily snapshot scheduler
 * Takes a snapshot every 24 hours, and immediately if none today
 */
async function startDailySnapshots() {
  const SNAPSHOT_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

  // Check if we need a snapshot today
  const snapshots = await db.getSnapshots(1);
  const today = new Date().toISOString().split('T')[0];
  const hasToday = snapshots.some(s => {
    const ts = s.created_at;
    const dateStr = typeof ts === 'string' ? ts : new Date(ts).toISOString();
    return dateStr.startsWith(today);
  });

  if (!hasToday) {
    log('INFO', 'Taking daily snapshot...');
    try {
      await calculator.calculateAndSave();
      log('INFO', 'Daily snapshot saved');
    } catch (error) {
      log('ERROR', `Daily snapshot failed: ${error.message}`);
    }
  }

  // Schedule next snapshots
  setInterval(async () => {
    log('INFO', 'Taking scheduled daily snapshot...');
    try {
      await calculator.calculateAndSave();
      log('INFO', 'Daily snapshot saved');
    } catch (error) {
      log('ERROR', `Daily snapshot failed: ${error.message}`);
    }
  }, SNAPSHOT_INTERVAL);

  log('INFO', 'Daily snapshots enabled (every 24h)');
}

async function main() {
  // Initialize database
  await db.getDb();
  log('INFO', 'Database initialized');

  // Check if we have data
  const stats = await db.getStats();
  if (stats.wallets === 0) {
    log('WARN', 'No wallet data found. Run: node scripts/backfill.js');
  } else {
    const kMetric = await calculator.calculate();
    if (kMetric) {
      log('INFO', `Current K: ${kMetric.k}% (${kMetric.holders} holders)`);
    }
  }

  // Create server
  const server = http.createServer(async (req, res) => {
    // Request correlation ID (for tracing/debugging)
    const requestId = req.headers['x-request-id'] || randomUUID();
    req.requestId = requestId;
    res.setHeader('X-Request-ID', requestId);

    // Security headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');

    // HTTPS enforcement in production (behind reverse proxy)
    const isProduction = process.env.NODE_ENV === 'production';
    const proto = req.headers['x-forwarded-proto'];
    if (isProduction && proto && proto !== 'https') {
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      res.writeHead(301, { Location: `https://${host}${req.url}` });
      res.end();
      return;
    }

    // HSTS header in production (1 year)
    if (isProduction) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }

    // CORS headers - restrict to allowed origins
    const origin = req.headers.origin;
    if (origin && isOriginAllowed(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Helius-Signature, X-Oracle-Key, X-Admin-Key');
    }

    if (req.method === 'OPTIONS') {
      if (!isOriginAllowed(origin)) {
        res.writeHead(403);
        res.end('CORS not allowed');
        return;
      }
      res.writeHead(204);
      res.end();
      return;
    }

    // API Key extraction and validation
    const apiKey = req.headers['x-oracle-key'];
    let apiKeyMeta = null;

    if (apiKey) {
      apiKeyMeta = await db.validateApiKey(apiKey);
      // Attach to request for downstream handlers
      req.apiKeyMeta = apiKeyMeta;
    }

    // Rate limiting (V2 with tier support)
    const clientIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress;
    const rateLimitId = apiKeyMeta ? apiKeyMeta.id : clientIp; // Use API key ID if available
    const rateCheck = security.rateLimitV2(rateLimitId, apiKeyMeta);

    // Add rate limit headers
    res.setHeader('X-RateLimit-Limit', rateCheck.limit === Infinity ? 'unlimited' : rateCheck.limit);
    res.setHeader('X-RateLimit-Remaining', rateCheck.remaining === Infinity ? 'unlimited' : rateCheck.remaining);
    res.setHeader('X-RateLimit-Reset', Math.floor(rateCheck.resetAt / 1000));
    res.setHeader('X-RateLimit-Tier', rateCheck.tier);

    if (!rateCheck.allowed) {
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': rateCheck.retryAfter
      });
      res.end(JSON.stringify({
        error: 'Too many requests',
        reason: rateCheck.reason,
        retryAfter: rateCheck.retryAfter,
        tier: rateCheck.tier,
        hint: rateCheck.tier === 'public' ? 'Use an API key for higher limits' : 'Upgrade your tier for higher limits'
      }));
      return;
    }

    // Track usage for API key holders
    if (apiKeyMeta) {
      db.incrementUsage(apiKeyMeta.id).catch(() => {}); // Fire and forget
    }

    const url = new URL(req.url, `http://${req.headers.host}`);

    // API routes (/k-metric for dashboard, /api/v1 for external services)
    if (url.pathname.startsWith('/k-metric') || url.pathname.startsWith('/api/v1')) {
      log('INFO', `[${requestId.slice(0, 8)}] ${req.method} ${req.url}`);
      try {
        await router.handleRequest(req, res);
      } catch (error) {
        log('ERROR', `[${requestId.slice(0, 8)}] Request error: ${error.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
      return;
    }

    // Static files
    if (await serveStatic(req, res)) {
      return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end('<h1>404 Not Found</h1>');
  });

  // WebSocket upgrade handler
  server.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin;
    if (origin && !isOriginAllowed(origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    ws.handleUpgrade(req, socket, head);
  });

  server.listen(PORT, () => {
    log('INFO', '═══════════════════════════════════════════');
    log('INFO', `🔥 K-Metric Oracle running on port ${PORT}`);
    log('INFO', '═══════════════════════════════════════════');
    log('INFO', 'Frontend:');
    log('INFO', `  http://localhost:${PORT}/`);
    log('INFO', `  http://localhost:${PORT}/wallet`);
    log('INFO', 'Dashboard API (/k-metric):');
    log('INFO', `  GET  /k-metric                       → K_token (this token)`);
    log('INFO', `  GET  /k-metric/history               → Historical snapshots`);
    log('INFO', `  GET  /k-metric/holders               → Holder list`);
    log('INFO', `  GET  /k-metric/wallet/:addr/k-score  → K_wallet (this token)`);
    log('INFO', `  GET  /k-metric/wallet/:addr/k-global → K_wallet (all PumpFun)`);
    log('INFO', `  POST /k-metric/webhook               → Helius webhook`);
    log('INFO', 'Oracle API v1 (/api/v1):');
    log('INFO', `  GET  /api/v1/status                  → Oracle status`);
    log('INFO', `  GET  /api/v1/token/:mint             → Token K score`);
    log('INFO', `  GET  /api/v1/wallet/:addr            → Wallet K scores`);
    log('INFO', 'WebSocket:');
    log('INFO', `  ws://localhost:${PORT}/ws?key=API_KEY → Real-time events`);
    log('INFO', '───────────────────────────────────────────');
    log('INFO', 'Sync: Webhook + Polling fallback (5min)');
    log('INFO', '═══════════════════════════════════════════');

    // Start polling fallback service
    sync.startPolling();

    // Start K_wallet queue worker
    walletScore.startWorker();

    // Start Token K queue worker
    tokenScore.startWorker();

    // Start webhook delivery worker
    webhooks.startWorker();

    // Start scheduled backups (every 6 hours)
    security.startScheduledBackups();

    // Start daily snapshots (every 24 hours, also take one now if needed)
    startDailySnapshots();
  });
}

main().catch((error) => {
  log('ERROR', `Server failed to start: ${error.message}`);
  console.error(error);
  process.exit(1);
});
