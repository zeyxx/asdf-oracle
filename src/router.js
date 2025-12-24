/**
 * K-Metric Router
 *
 * Aggregates all route modules and handles request routing.
 * No Express dependency - works with native Node.js http.
 *
 * Route modules:
 * - dashboard.js: /k-metric/* (internal dashboard API)
 * - api-v1.js: /api/v1/* (external Oracle API)
 * - webhooks.js: /api/v1/webhooks/* (webhook subscriptions)
 * - admin.js: /k-metric/admin/* (administrative endpoints)
 *
 * Security:
 * - MAX_BODY_SIZE prevents memory exhaustion attacks
 * - Content-Length validation before reading body
 * - Body read timeout prevents slowloris attacks
 */

import { loadEnv } from './utils.js';

// Security: Maximum body size (1MB)
const MAX_BODY_SIZE = 1024 * 1024;
// Security: Body read timeout (30 seconds)
const BODY_READ_TIMEOUT = 30000;
loadEnv();

// Import route modules
import dashboardRoutes from './routes/dashboard.js';
import apiV1Routes from './routes/api-v1.js';
import webhooksRoutes from './routes/webhooks.js';
import adminRoutes from './routes/admin.js';

// Aggregate static routes
const routes = {
  ...dashboardRoutes.routes,
  ...apiV1Routes.routes,
  ...webhooksRoutes.routes,
  ...adminRoutes.routes,
};

// Aggregate dynamic routes (order matters for pattern matching)
const dynamicRoutes = [
  ...dashboardRoutes.dynamicRoutes,
  ...adminRoutes.dynamicRoutes,
  ...apiV1Routes.dynamicRoutes,
  ...webhooksRoutes.dynamicRoutes,
];

/**
 * Send JSON response
 */
function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/**
 * Read request body with security limits
 * - Uses Buffer concatenation (O(n) vs O(n²) string concat)
 * - Enforces MAX_BODY_SIZE during read
 * - Times out after BODY_READ_TIMEOUT
 */
async function readBodyWithLimits(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    // Security: Timeout for slow clients (slowloris prevention)
    const timeout = setTimeout(() => {
      req.destroy();
      reject(new Error('BODY_READ_TIMEOUT'));
    }, BODY_READ_TIMEOUT);

    req.on('data', (chunk) => {
      size += chunk.length;
      // Security: Reject if body exceeds limit during read
      if (size > MAX_BODY_SIZE) {
        clearTimeout(timeout);
        req.destroy();
        reject(new Error('PAYLOAD_TOO_LARGE'));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      clearTimeout(timeout);
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });

    req.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/**
 * Handle incoming request
 */
export async function handleRequest(req, res) {
  const method = req.method;
  const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;

  // For /k-metric routes, also try with /api prefix stripped (backwards compat)
  const paths = [pathname];
  if (pathname.startsWith('/api/') && !pathname.startsWith('/api/v1')) {
    paths.push(pathname.replace(/^\/api/, ''));
  }

  // Try each path variant
  for (const path of paths) {
    const routeKey = `${method} ${path}`;
    const handler = routes[routeKey];

    if (handler) {
      // Parse JSON body for POST/DELETE requests
      if ((method === 'POST' || method === 'DELETE') && !req.body) {
        // Security: Check Content-Length before reading
        const contentLength = parseInt(req.headers['content-length'] || '0', 10);
        if (contentLength > MAX_BODY_SIZE) {
          sendJson(res, 413, { error: 'Payload too large', max: MAX_BODY_SIZE });
          return;
        }

        // Security: Read body with size limit and timeout
        try {
          req.body = await readBodyWithLimits(req);
        } catch (err) {
          if (err.message === 'PAYLOAD_TOO_LARGE') {
            sendJson(res, 413, { error: 'Payload too large', max: MAX_BODY_SIZE });
            return;
          }
          if (err.message === 'BODY_READ_TIMEOUT') {
            sendJson(res, 408, { error: 'Request timeout' });
            return;
          }
          req.body = {};
        }
      }

      await handler(req, res);
      return;
    }

    // Try dynamic routes
    for (const route of dynamicRoutes) {
      const match = `${method} ${path}`.match(route.pattern);
      if (match) {
        const params = match.slice(1); // Extract captured groups
        await route.handler(req, res, params);
        return;
      }
    }
  }

  sendJson(res, 404, { error: 'Not found' });
}

/**
 * Express router middleware (if using Express)
 */
export function expressRouter() {
  return async (req, res, next) => {
    const path = req.path;

    if (path.startsWith('/k-metric') || path.startsWith('/api/v1')) {
      await handleRequest(req, res);
    } else {
      next();
    }
  };
}

export default { handleRequest, expressRouter, routes };
