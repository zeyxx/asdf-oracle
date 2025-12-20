/**
 * Helius Webhook Handler
 *
 * Processes real-time token transfer events.
 * Updates wallet data incrementally.
 */

import crypto from 'crypto';
import db from './db.js';
import calculator from './calculator.js';
import walletScore from './wallet-score.js';
import { log } from './utils.js';
import security from './security.js';

const WEBHOOK_SECRET = process.env.HELIUS_WEBHOOK_SECRET;
const TOKEN_MINT = process.env.TOKEN_MINT;

/**
 * Verify Helius webhook signature
 */
export function verifySignature(payload, signature) {
  if (!WEBHOOK_SECRET) {
    log('WARN', 'No webhook secret configured, skipping verification');
    return true;
  }

  const expectedSignature = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(payload)
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(signature || ''),
    Buffer.from(expectedSignature)
  );
}

/**
 * Process webhook payload
 * Uses Solana PoH (Proof of History) slot as ordering key.
 * Only processes transactions with slot > lastProcessedSlot.
 *
 * @param {Object[]} events - Array of Helius webhook events
 */
export async function processEvents(events) {
  // Validate payload
  const validation = security.validateWebhookPayload(events);
  if (!validation.valid) {
    log('WARN', `Invalid webhook payload: ${validation.error}`);
    return 0;
  }

  if (!Array.isArray(events)) {
    events = [events];
  }

  // Get last processed slot (PoH reference)
  const lastProcessedSlot = await db.getLastProcessedSlot();
  let processed = 0;
  let maxSlot = lastProcessedSlot;

  for (const event of events) {
    try {
      // Check if this is a token transfer for our mint
      if (event.type !== 'TRANSFER' && event.type !== 'TOKEN_TRANSFER') {
        continue;
      }

      // PoH ordering: skip if we've already processed this slot
      const slot = event.slot || 0;
      if (slot <= lastProcessedSlot && lastProcessedSlot > 0) {
        log('DEBUG', `Skipping already processed slot ${slot}`);
        continue;
      }

      const tokenTransfers = event.tokenTransfers || [];
      const relevantTransfers = tokenTransfers.filter(
        (t) => t.mint === TOKEN_MINT
      );

      if (relevantTransfers.length === 0) {
        continue;
      }

      for (const transfer of relevantTransfers) {
        const { fromUserAccount, toUserAccount, tokenAmount } = transfer;
        const amount = parseInt(tokenAmount || '0');
        const signature = event.signature;
        const blockTime = event.timestamp || Math.floor(Date.now() / 1000);

        // Record transaction with PoH slot
        if (fromUserAccount) {
          await db.recordTransaction({
            signature: `${signature}-from`,
            slot,
            blockTime,
            wallet: fromUserAccount,
            amountChange: -amount,
          });

          // Update sender wallet
          await updateWalletFromTransfer(fromUserAccount, -amount, blockTime, signature);

          // Queue K_wallet recalculation
          await walletScore.enqueueWallet(fromUserAccount);
        }

        if (toUserAccount) {
          await db.recordTransaction({
            signature: `${signature}-to`,
            slot,
            blockTime,
            wallet: toUserAccount,
            amountChange: amount,
          });

          // Update receiver wallet
          await updateWalletFromTransfer(toUserAccount, amount, blockTime, signature);

          // Queue K_wallet recalculation
          await walletScore.enqueueWallet(toUserAccount);
        }

        processed++;
      }

      // Track max slot for PoH ordering
      if (slot > maxSlot) {
        maxSlot = slot;
      }
    } catch (error) {
      log('ERROR', `Error processing event: ${error.message}`);
    }
  }

  if (processed > 0) {
    log('INFO', `Processed ${processed} transfers via webhook (slot ${lastProcessedSlot} → ${maxSlot})`);

    // Recalculate K (instant since it's local)
    await calculator.calculate();
  }

  return processed;
}

/**
 * Update wallet data from a transfer
 */
async function updateWalletFromTransfer(address, amountChange, blockTime, signature) {
  const wallets = await db.getWallets(0);
  const existing = wallets.find((w) => w.address === address);

  if (existing) {
    // Update existing wallet
    const newBalance = (existing.current_balance || 0) + amountChange;
    const received = amountChange > 0 ? amountChange : 0;
    const sent = amountChange < 0 ? Math.abs(amountChange) : 0;

    await db.upsertWallet({
      address,
      balance: Math.max(0, newBalance),
      firstBuyTs: existing.first_buy_ts,
      firstBuyAmount: existing.first_buy_amount,
      received,
      sent,
      lastTxSig: signature,
    });
  } else if (amountChange > 0) {
    // New wallet receiving tokens
    await db.upsertWallet({
      address,
      balance: amountChange,
      firstBuyTs: blockTime,
      firstBuyAmount: amountChange,
      received: amountChange,
      sent: 0,
      lastTxSig: signature,
    });
  }
}

/**
 * Express middleware for webhook endpoint
 */
export function webhookHandler(req, res) {
  try {
    const signature = req.headers['x-helius-signature'];
    const rawBody = JSON.stringify(req.body);

    // Verify signature
    if (!verifySignature(rawBody, signature)) {
      log('WARN', 'Invalid webhook signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // Process events asynchronously
    processEvents(req.body).catch((err) => {
      log('ERROR', `Webhook processing error: ${err.message}`);
    });

    // Respond immediately
    res.status(200).json({ received: true });
  } catch (error) {
    log('ERROR', `Webhook handler error: ${error.message}`);
    res.status(500).json({ error: 'Internal error' });
  }
}

export default { verifySignature, processEvents, webhookHandler };
