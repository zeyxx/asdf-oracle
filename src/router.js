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
 */

import { loadEnv } from './utils.js';
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
        let body = '';
        for await (const chunk of req) {
          body += chunk;
        }
        try {
          req.body = JSON.parse(body);
        } catch {
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
