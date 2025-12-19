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
import { loadEnv, log } from './utils.js';
import router from './router.js';
import db from './db.js';
import calculator from './calculator.js';
import sync from './sync.js';
import security from './security.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.join(__dirname, '..');

loadEnv();

const PORT = process.env.PORT || 3001;

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

/**
 * Serve static files
 */
function serveStatic(req, res) {
  let filePath = req.url === '/' ? '/index.html' : req.url;

  // Security: prevent directory traversal
  filePath = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, '');

  const fullPath = path.join(ROOT_DIR, filePath);

  // Check if file exists
  if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
    return false;
  }

  const ext = path.extname(fullPath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  try {
    const content = fs.readFileSync(fullPath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
    return true;
  } catch (error) {
    return false;
  }
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
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Helius-Signature');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Rate limiting
    const clientIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress;
    const rateCheck = security.rateLimit(clientIp);

    if (!rateCheck.allowed) {
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': rateCheck.retryAfter
      });
      res.end(JSON.stringify({ error: 'Too many requests', retryAfter: rateCheck.retryAfter }));
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);

    // API routes
    if (url.pathname.startsWith('/k-metric')) {
      log('INFO', `${req.method} ${req.url}`);
      try {
        await router.handleRequest(req, res);
      } catch (error) {
        log('ERROR', `Request error: ${error.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
      return;
    }

    // Static files
    if (serveStatic(req, res)) {
      return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end('<h1>404 Not Found</h1>');
  });

  server.listen(PORT, () => {
    log('INFO', '═══════════════════════════════════════════');
    log('INFO', `🔥 K-Metric server running on port ${PORT}`);
    log('INFO', '═══════════════════════════════════════════');
    log('INFO', 'Frontend:');
    log('INFO', `  http://localhost:${PORT}/`);
    log('INFO', 'API:');
    log('INFO', `  GET  /k-metric         → Current K-metric`);
    log('INFO', `  GET  /k-metric/history → Historical snapshots`);
    log('INFO', `  GET  /k-metric/holders → Holder list`);
    log('INFO', `  POST /k-metric/webhook → Helius webhook (real-time)`);
    log('INFO', `  POST /k-metric/sync    → Force sync`);
    log('INFO', '───────────────────────────────────────────');
    log('INFO', 'Sync: Webhook + Polling fallback (5min)');
    log('INFO', '═══════════════════════════════════════════');

    // Start polling fallback service
    sync.startPolling();

    // Start scheduled backups (every 6 hours)
    security.startScheduledBackups();
  });
}

main().catch((error) => {
  log('ERROR', `Server failed to start: ${error.message}`);
  console.error(error);
  process.exit(1);
});
