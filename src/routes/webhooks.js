/**
 * Webhook Routes (/api/v1/webhooks)
 *
 * Outbound webhook subscription management.
 */

import db from '../db.js';
import { log } from '../utils.js';
import { sendJson, requireApiKey } from './utils.js';

/**
 * GET /api/v1/webhooks/events - List available event types
 */
async function handleApiV1WebhookEvents(req, res) {
  try {
    const events = db.getWebhookEventTypes();
    sendJson(res, 200, {
      events,
      description: {
        k_change: 'Triggered when K metric changes by more than 1%',
        holder_new: 'Triggered when a new holder is detected',
        holder_exit: 'Triggered when a holder exits (balance = 0)',
        threshold_alert: 'Triggered when K crosses a configured threshold',
      },
    });
  } catch (error) {
    log('ERROR', `Webhook events error: ${error.message}`);
    sendJson(res, 500, { error: error.message });
  }
}

/**
 * GET /api/v1/webhooks - List webhooks for current API key
 */
async function handleApiV1ListWebhooks(req, res) {
  try {
    if (!requireApiKey(req)) {
      return sendJson(res, 401, { error: 'API key required', hint: 'Set X-Oracle-Key header' });
    }

    const webhooksList = await db.listWebhookSubscriptions(req.apiKeyMeta.id);

    sendJson(res, 200, {
      webhooks: webhooksList.map(w => ({
        id: w.id,
        url: w.url,
        events: w.events,
        is_active: !!w.is_active,
        failure_count: w.failure_count,
        last_triggered_at: w.last_triggered_at,
        created_at: w.created_at,
      })),
      total: webhooksList.length,
    });
  } catch (error) {
    log('ERROR', `List webhooks error: ${error.message}`);
    sendJson(res, 500, { error: error.message });
  }
}

/**
 * POST /api/v1/webhooks - Create webhook subscription
 */
async function handleApiV1CreateWebhook(req, res) {
  try {
    if (!requireApiKey(req)) {
      return sendJson(res, 401, { error: 'API key required', hint: 'Set X-Oracle-Key header' });
    }

    const { url, events, secret } = req.body || {};

    if (!url || typeof url !== 'string') {
      return sendJson(res, 400, { error: 'url is required' });
    }

    if (!events || !Array.isArray(events) || events.length === 0) {
      return sendJson(res, 400, {
        error: 'events array is required',
        valid_events: db.getWebhookEventTypes(),
      });
    }

    try {
      new URL(url);
    } catch {
      return sendJson(res, 400, { error: 'Invalid URL format' });
    }

    const { randomBytes } = await import('crypto');
    const webhookSecret = secret || randomBytes(32).toString('hex');

    const webhook = await db.createWebhookSubscription({
      apiKeyId: req.apiKeyMeta.id,
      url,
      events,
      secret: webhookSecret,
    });

    log('INFO', `[Webhook] Created subscription ${webhook.id} for ${req.apiKeyMeta.name}`);

    sendJson(res, 201, {
      ...webhook,
      secret: webhookSecret,
      message: 'Webhook created. Save the secret for signature verification.',
      signature_header: 'X-Oracle-Signature',
    });
  } catch (error) {
    log('ERROR', `Create webhook error: ${error.message}`);
    sendJson(res, 500, { error: error.message });
  }
}

/**
 * GET /api/v1/webhooks/:id - Get webhook details
 */
async function handleApiV1GetWebhook(req, res, params) {
  try {
    if (!requireApiKey(req)) {
      return sendJson(res, 401, { error: 'API key required' });
    }

    const webhookId = params[0];
    const webhook = await db.getWebhookSubscription(webhookId);

    if (!webhook) {
      return sendJson(res, 404, { error: 'Webhook not found' });
    }

    if (webhook.api_key_id !== req.apiKeyMeta.id) {
      return sendJson(res, 403, { error: 'Access denied' });
    }

    sendJson(res, 200, {
      id: webhook.id,
      url: webhook.url,
      events: webhook.events,
      is_active: !!webhook.is_active,
      failure_count: webhook.failure_count,
      last_triggered_at: webhook.last_triggered_at,
      created_at: webhook.created_at,
    });
  } catch (error) {
    log('ERROR', `Get webhook error: ${error.message}`);
    sendJson(res, 500, { error: error.message });
  }
}

/**
 * DELETE /api/v1/webhooks/:id - Delete webhook
 */
async function handleApiV1DeleteWebhook(req, res, params) {
  try {
    if (!requireApiKey(req)) {
      return sendJson(res, 401, { error: 'API key required' });
    }

    const webhookId = params[0];
    const webhook = await db.getWebhookSubscription(webhookId);

    if (!webhook) {
      return sendJson(res, 404, { error: 'Webhook not found' });
    }

    if (webhook.api_key_id !== req.apiKeyMeta.id) {
      return sendJson(res, 403, { error: 'Access denied' });
    }

    await db.deleteWebhookSubscription(webhookId);

    log('INFO', `[Webhook] Deleted subscription ${webhookId}`);
    sendJson(res, 200, { success: true, message: 'Webhook deleted' });
  } catch (error) {
    log('ERROR', `Delete webhook error: ${error.message}`);
    sendJson(res, 500, { error: error.message });
  }
}

/**
 * GET /api/v1/webhooks/:id/deliveries - Get delivery history
 */
async function handleApiV1WebhookDeliveries(req, res, params) {
  try {
    if (!requireApiKey(req)) {
      return sendJson(res, 401, { error: 'API key required' });
    }

    const webhookId = params[0];
    const webhook = await db.getWebhookSubscription(webhookId);

    if (!webhook) {
      return sendJson(res, 404, { error: 'Webhook not found' });
    }

    if (webhook.api_key_id !== req.apiKeyMeta.id) {
      return sendJson(res, 403, { error: 'Access denied' });
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);

    const deliveries = await db.getWebhookDeliveryHistory(webhookId, limit);

    sendJson(res, 200, {
      deliveries: deliveries.map(d => ({
        id: d.id,
        event_type: d.event_type,
        status: d.status,
        attempts: d.attempts,
        response_code: d.response_code,
        created_at: d.created_at,
        completed_at: d.completed_at,
      })),
      total: deliveries.length,
    });
  } catch (error) {
    log('ERROR', `Webhook deliveries error: ${error.message}`);
    sendJson(res, 500, { error: error.message });
  }
}

// Route definitions
export const routes = {
  'GET /api/v1/webhooks': handleApiV1ListWebhooks,
  'POST /api/v1/webhooks': handleApiV1CreateWebhook,
  'GET /api/v1/webhooks/events': handleApiV1WebhookEvents,
};

export const dynamicRoutes = [
  { pattern: /^GET \/api\/v1\/webhooks\/([a-f0-9-]{36})$/, handler: handleApiV1GetWebhook },
  { pattern: /^DELETE \/api\/v1\/webhooks\/([a-f0-9-]{36})$/, handler: handleApiV1DeleteWebhook },
  { pattern: /^GET \/api\/v1\/webhooks\/([a-f0-9-]{36})\/deliveries$/, handler: handleApiV1WebhookDeliveries },
];

export default { routes, dynamicRoutes };
