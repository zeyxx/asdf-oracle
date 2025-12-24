/**
 * K-Metric SQLite Database - Facade
 *
 * Re-exports all database functions from modular files.
 * Maintains backward compatibility with existing imports.
 *
 * Modules:
 * - db/connection.js: Database initialization and connection
 * - db/wallets.js: Wallet CRUD and K-score calculations
 * - db/transactions.js: Transaction recording
 * - db/snapshots.js: K-metric snapshots and sync state
 * - db/k-wallet-queue.js: Background queue for K_wallet calculations
 * - db/tokens.js: Multi-token K scoring
 * - db/api-keys.js: API key management and usage tracking
 * - db/webhooks.js: Outbound webhook subscriptions
 */

// Connection
export { getDb, getDbSync } from './db/connection.js';

// Wallets
export {
  classifyWalletK,
  upsertWallet,
  getWallets,
  getWalletKScore,
  updateWalletBalance,
  getWalletsNeedingKWallet,
  getHoldersFiltered,
} from './db/wallets.js';

// Transactions
export {
  recordTransaction,
  getLastProcessedSlot,
  getLastProcessedSignature,
  getRecentTransactions,
} from './db/transactions.js';

// Snapshots & Sync State
export {
  saveSnapshot,
  getSnapshots,
  getSyncState,
  setSyncState,
  getStats,
} from './db/snapshots.js';

// K_wallet Queue
export {
  enqueueKWallet,
  enqueueKWalletBatch,
  dequeueKWallet,
  completeKWallet,
  failKWallet,
  cleanupKWalletQueue,
  clearKWalletQueue,
  getKWalletQueueStats,
} from './db/k-wallet-queue.js';

// Token K Scoring
export {
  getToken,
  upsertToken,
  enqueueToken,
  dequeueToken,
  completeToken,
  failToken,
  getTokenQueueStats,
  cleanupTokenQueue,
} from './db/tokens.js';

// API Keys & Usage
export {
  createApiKey,
  validateApiKey,
  getApiKey,
  listApiKeys,
  updateApiKey,
  revokeApiKey,
  deleteApiKey,
  incrementUsage,
  getTodayUsage,
  getUsageHistory,
  getUsageStats,
  cleanupUsageHistory,
} from './db/api-keys.js';

// Webhooks
export {
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
} from './db/webhooks.js';

// Default export for backward compatibility
import { getDb, getDbSync } from './db/connection.js';
import { classifyWalletK, upsertWallet, getWallets, getWalletKScore, updateWalletBalance, getWalletsNeedingKWallet, getHoldersFiltered } from './db/wallets.js';
import { recordTransaction, getLastProcessedSlot, getLastProcessedSignature, getRecentTransactions } from './db/transactions.js';
import { saveSnapshot, getSnapshots, getSyncState, setSyncState, getStats } from './db/snapshots.js';
import { enqueueKWallet, enqueueKWalletBatch, dequeueKWallet, completeKWallet, failKWallet, cleanupKWalletQueue, clearKWalletQueue, getKWalletQueueStats } from './db/k-wallet-queue.js';
import { getToken, upsertToken, enqueueToken, dequeueToken, completeToken, failToken, getTokenQueueStats, cleanupTokenQueue } from './db/tokens.js';
import { createApiKey, validateApiKey, getApiKey, listApiKeys, updateApiKey, revokeApiKey, deleteApiKey, incrementUsage, getTodayUsage, getUsageHistory, getUsageStats, cleanupUsageHistory } from './db/api-keys.js';
import { getWebhookEventTypes, createWebhookSubscription, getWebhookSubscription, listWebhookSubscriptions, getSubscriptionsForEvent, updateWebhookSubscription, deleteWebhookSubscription, createWebhookDelivery, getPendingWebhookDeliveries, updateWebhookDelivery, incrementWebhookFailure, resetWebhookFailure, getWebhookDeliveryHistory } from './db/webhooks.js';

export default {
  // Connection
  getDb,
  getDbSync,
  // Wallets
  classifyWalletK,
  upsertWallet,
  getWallets,
  getWalletKScore,
  updateWalletBalance,
  getWalletsNeedingKWallet,
  getHoldersFiltered,
  // Transactions
  recordTransaction,
  getLastProcessedSlot,
  getLastProcessedSignature,
  getRecentTransactions,
  // Snapshots
  saveSnapshot,
  getSnapshots,
  getSyncState,
  setSyncState,
  getStats,
  // K_wallet Queue
  enqueueKWallet,
  enqueueKWalletBatch,
  dequeueKWallet,
  completeKWallet,
  failKWallet,
  cleanupKWalletQueue,
  clearKWalletQueue,
  getKWalletQueueStats,
  // Token K Scoring
  getToken,
  upsertToken,
  enqueueToken,
  dequeueToken,
  completeToken,
  failToken,
  getTokenQueueStats,
  cleanupTokenQueue,
  // API Keys
  createApiKey,
  validateApiKey,
  getApiKey,
  listApiKeys,
  updateApiKey,
  revokeApiKey,
  deleteApiKey,
  // Usage
  incrementUsage,
  getTodayUsage,
  getUsageHistory,
  getUsageStats,
  cleanupUsageHistory,
  // Webhooks
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
