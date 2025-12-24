/**
 * Webhook Database Operations
 *
 * Outbound webhook subscriptions and delivery tracking.
 */

import { randomUUID } from 'crypto';
import { getDb } from './connection.js';

const WEBHOOK_EVENTS = ['k_change', 'holder_new', 'holder_exit', 'threshold_alert'];

/**
 * Get available webhook event types
 */
export function getWebhookEventTypes() {
  return [...WEBHOOK_EVENTS];
}

/**
 * Create a webhook subscription
 */
export async function createWebhookSubscription({ apiKeyId, url, events, secret }) {
  const db = await getDb();
  const id = randomUUID();

  const validEvents = events.filter(e => WEBHOOK_EVENTS.includes(e));
  if (validEvents.length === 0) {
    throw new Error(`Invalid events. Valid: ${WEBHOOK_EVENTS.join(', ')}`);
  }

  const stmt = db.prepare(`
    INSERT INTO webhook_subscriptions (id, api_key_id, url, events, secret)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(id, apiKeyId, url, JSON.stringify(validEvents), secret);

  return { id, api_key_id: apiKeyId, url, events: validEvents };
}

/**
 * Get webhook subscription by ID
 */
export async function getWebhookSubscription(id) {
  const db = await getDb();
  const stmt = db.prepare('SELECT * FROM webhook_subscriptions WHERE id = ?');
  const row = stmt.get(id);
  if (row) {
    row.events = JSON.parse(row.events);
  }
  return row;
}

/**
 * List webhook subscriptions for an API key
 */
export async function listWebhookSubscriptions(apiKeyId) {
  const db = await getDb();
  const stmt = db.prepare('SELECT * FROM webhook_subscriptions WHERE api_key_id = ? AND is_active = 1');
  const rows = stmt.all(apiKeyId);
  return rows.map(row => ({ ...row, events: JSON.parse(row.events) }));
}

/**
 * List all active subscriptions for a specific event type
 */
export async function getSubscriptionsForEvent(eventType) {
  const db = await getDb();
  const stmt = db.prepare(`
    SELECT * FROM webhook_subscriptions
    WHERE is_active = 1 AND failure_count < 5
  `);
  const rows = stmt.all();

  return rows.filter(row => {
    const events = JSON.parse(row.events);
    return events.includes(eventType);
  }).map(row => ({ ...row, events: JSON.parse(row.events) }));
}

/**
 * Update webhook subscription
 */
export async function updateWebhookSubscription(id, { url, events, isActive }) {
  const db = await getDb();

  const updates = [];
  const params = [];

  if (url !== undefined) { updates.push('url = ?'); params.push(url); }
  if (events !== undefined) {
    const validEvents = events.filter(e => WEBHOOK_EVENTS.includes(e));
    updates.push('events = ?');
    params.push(JSON.stringify(validEvents));
  }
  if (isActive !== undefined) { updates.push('is_active = ?'); params.push(isActive ? 1 : 0); }

  if (updates.length === 0) return false;

  params.push(id);
  const stmt = db.prepare(`UPDATE webhook_subscriptions SET ${updates.join(', ')} WHERE id = ?`);
  const result = stmt.run(...params);
  return result.changes > 0;
}

/**
 * Delete webhook subscription
 */
export async function deleteWebhookSubscription(id) {
  const db = await getDb();
  const stmt = db.prepare('DELETE FROM webhook_subscriptions WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
}

/**
 * Record webhook delivery attempt
 */
export async function createWebhookDelivery({ subscriptionId, eventType, payload }) {
  const db = await getDb();
  const stmt = db.prepare(`
    INSERT INTO webhook_deliveries (subscription_id, event_type, payload, status)
    VALUES (?, ?, ?, 'pending')
  `);
  const result = stmt.run(subscriptionId, eventType, JSON.stringify(payload));
  return result.lastInsertRowid;
}

/**
 * Get pending webhook deliveries ready for retry
 */
export async function getPendingWebhookDeliveries(limit = 10) {
  const db = await getDb();
  const now = Math.floor(Date.now() / 1000);

  const stmt = db.prepare(`
    SELECT d.*, s.url, s.secret
    FROM webhook_deliveries d
    JOIN webhook_subscriptions s ON d.subscription_id = s.id
    WHERE d.status = 'pending'
      AND (d.next_retry_at IS NULL OR d.next_retry_at <= ?)
      AND d.attempts < 3
    ORDER BY d.created_at ASC
    LIMIT ?
  `);
  return stmt.all(now, limit);
}

/**
 * Update webhook delivery status
 */
export async function updateWebhookDelivery(id, { status, responseCode, responseBody, nextRetryAt }) {
  const db = await getDb();
  const now = Math.floor(Date.now() / 1000);

  const stmt = db.prepare(`
    UPDATE webhook_deliveries SET
      status = ?,
      attempts = attempts + 1,
      response_code = ?,
      response_body = ?,
      next_retry_at = ?,
      completed_at = CASE WHEN ? IN ('success', 'failed') THEN ? ELSE NULL END
    WHERE id = ?
  `);
  stmt.run(status, responseCode, responseBody, nextRetryAt, status, now, id);
}

/**
 * Mark subscription as failed (too many failures)
 */
export async function incrementWebhookFailure(subscriptionId) {
  const db = await getDb();
  const stmt = db.prepare(`
    UPDATE webhook_subscriptions SET
      failure_count = failure_count + 1,
      is_active = CASE WHEN failure_count >= 4 THEN 0 ELSE is_active END
    WHERE id = ?
  `);
  stmt.run(subscriptionId);
}

/**
 * Reset failure count on successful delivery
 */
export async function resetWebhookFailure(subscriptionId) {
  const db = await getDb();
  const now = Math.floor(Date.now() / 1000);
  const stmt = db.prepare(`
    UPDATE webhook_subscriptions SET failure_count = 0, last_triggered_at = ? WHERE id = ?
  `);
  stmt.run(now, subscriptionId);
}

/**
 * Get webhook delivery history for a subscription
 */
export async function getWebhookDeliveryHistory(subscriptionId, limit = 50) {
  const db = await getDb();
  const stmt = db.prepare(`
    SELECT * FROM webhook_deliveries
    WHERE subscription_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `);
  return stmt.all(subscriptionId, limit);
}

export default {
  getWebhookEventTypes,
  createWebhookSubscription,
  getWebhookSubscription,
  listWebhookSubscriptions,
  getSubscriptionsForEvent,
  updateWebhookSubscription,
  deleteWebhookSubscription,
  createWebhookDelivery,
  getPendingWebhookDeliveries,
  updateWebhookDelivery,
  incrementWebhookFailure,
  resetWebhookFailure,
  getWebhookDeliveryHistory,
};
