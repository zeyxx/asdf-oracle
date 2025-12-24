/**
 * Webhooks Module - Outbound notifications
 *
 * Dispatches events to registered webhook subscribers.
 * Features:
 * - HMAC-SHA256 signature for security
 * - Exponential backoff retry (3 attempts)
 * - Background worker for async delivery
 */

import { createHmac } from 'crypto';
import db from './db.js';
import { log } from './utils.js';

// Retry delays: 1min, 5min, 15min
const RETRY_DELAYS = [60, 300, 900];

// Worker state
let workerInterval = null;

/**
 * Sign a webhook payload with HMAC-SHA256
 */
function signPayload(payload, secret) {
  const hmac = createHmac('sha256', secret);
  hmac.update(JSON.stringify(payload));
  return hmac.digest('hex');
}

/**
 * Dispatch an event to all subscribers
 * @param {string} eventType - Event type (k_change, holder_new, etc.)
 * @param {object} data - Event payload
 */
export async function dispatchEvent(eventType, data) {
  const subscriptions = await db.getSubscriptionsForEvent(eventType);

  if (subscriptions.length === 0) {
    return { dispatched: 0 };
  }

  log('INFO', `[Webhook] Dispatching ${eventType} to ${subscriptions.length} subscribers`);

  const payload = {
    event: eventType,
    timestamp: Math.floor(Date.now() / 1000),
    data,
  };

  let queued = 0;
  for (const sub of subscriptions) {
    await db.createWebhookDelivery({
      subscriptionId: sub.id,
      eventType,
      payload,
    });
    queued++;
  }

  return { dispatched: queued };
}

/**
 * Send a webhook HTTP request
 */
async function sendWebhook(url, payload, secret) {
  const signature = signPayload(payload, secret);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Oracle-Signature': signature,
        'X-Oracle-Event': payload.event,
        'X-Oracle-Timestamp': payload.timestamp.toString(),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    const body = await response.text().catch(() => '');

    return {
      success: response.ok,
      status: response.status,
      body: body.substring(0, 500), // Truncate response
    };
  } catch (error) {
    clearTimeout(timeout);
    return {
      success: false,
      status: 0,
      body: error.message,
    };
  }
}

/**
 * Process pending webhook deliveries
 */
async function processDeliveries() {
  const deliveries = await db.getPendingWebhookDeliveries(10);

  if (deliveries.length === 0) return;

  log('DEBUG', `[Webhook] Processing ${deliveries.length} pending deliveries`);

  for (const delivery of deliveries) {
    const payload = JSON.parse(delivery.payload);

    const result = await sendWebhook(delivery.url, payload, delivery.secret);

    if (result.success) {
      // Success
      await db.updateWebhookDelivery(delivery.id, {
        status: 'success',
        responseCode: result.status,
        responseBody: result.body,
        nextRetryAt: null,
      });
      await db.resetWebhookFailure(delivery.subscription_id);

      log('INFO', `[Webhook] Delivered ${payload.event} to ${delivery.url}`);
    } else {
      // Failed
      const attempts = delivery.attempts + 1;

      if (attempts >= 3) {
        // Max retries reached
        await db.updateWebhookDelivery(delivery.id, {
          status: 'failed',
          responseCode: result.status,
          responseBody: result.body,
          nextRetryAt: null,
        });
        await db.incrementWebhookFailure(delivery.subscription_id);

        log('WARN', `[Webhook] Failed after 3 attempts: ${delivery.url} - ${result.body}`);
      } else {
        // Schedule retry
        const delay = RETRY_DELAYS[attempts - 1] || RETRY_DELAYS[RETRY_DELAYS.length - 1];
        const nextRetry = Math.floor(Date.now() / 1000) + delay;

        await db.updateWebhookDelivery(delivery.id, {
          status: 'pending',
          responseCode: result.status,
          responseBody: result.body,
          nextRetryAt: nextRetry,
        });

        log('DEBUG', `[Webhook] Retry ${attempts}/3 scheduled for ${delivery.url} in ${delay}s`);
      }
    }
  }
}

/**
 * Start webhook worker
 */
export function startWorker(intervalMs = 30000) {
  if (workerInterval) return;

  log('INFO', '[Webhook] Worker started (30s interval)');

  // Initial run
  processDeliveries().catch(err => log('ERROR', `[Webhook] Worker error: ${err.message}`));

  // Scheduled runs
  workerInterval = setInterval(() => {
    processDeliveries().catch(err => log('ERROR', `[Webhook] Worker error: ${err.message}`));
  }, intervalMs);
}

/**
 * Stop webhook worker
 */
export function stopWorker() {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
    log('INFO', '[Webhook] Worker stopped');
  }
}

// ============================================
// Event Triggers - Called from other modules
// ============================================

/**
 * Trigger k_change event
 * Called when K metric changes significantly
 */
export async function triggerKChange({ previousK, newK, delta, holders }) {
  // Only trigger if delta > 1%
  if (Math.abs(delta) < 1) return { dispatched: 0, skipped: true };

  return dispatchEvent('k_change', {
    previous_k: previousK,
    new_k: newK,
    delta,
    holders,
    direction: delta > 0 ? 'up' : 'down',
  });
}

/**
 * Trigger holder_new event
 * Called when a new holder is detected
 */
export async function triggerHolderNew({ address, balance, txSignature }) {
  return dispatchEvent('holder_new', {
    address,
    balance: balance.toString(),
    tx_signature: txSignature,
  });
}

/**
 * Trigger holder_exit event
 * Called when a holder exits (balance = 0)
 */
export async function triggerHolderExit({ address, previousBalance, txSignature }) {
  return dispatchEvent('holder_exit', {
    address,
    previous_balance: previousBalance.toString(),
    tx_signature: txSignature,
  });
}

/**
 * Trigger threshold_alert event
 * Called when K crosses a threshold
 */
export async function triggerThresholdAlert({ threshold, direction, currentK }) {
  return dispatchEvent('threshold_alert', {
    threshold,
    direction, // 'above' or 'below'
    current_k: currentK,
    message: `K has ${direction === 'above' ? 'risen above' : 'fallen below'} ${threshold}%`,
  });
}

export default {
  dispatchEvent,
  startWorker,
  stopWorker,
  triggerKChange,
  triggerHolderNew,
  triggerHolderExit,
  triggerThresholdAlert,
  signPayload,
};
