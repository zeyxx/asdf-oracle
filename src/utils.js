/**
 * Utility functions
 */

import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Load environment variables from .env file
 * Does NOT overwrite existing env vars (command line takes precedence)
 */
export function loadEnv() {
  const envPath = join(__dirname, '..', '.env');
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, 'utf-8');
    content.split('\n').forEach((line) => {
      const [key, ...valueParts] = line.split('=');
      if (key && valueParts.length && !key.startsWith('#')) {
        const trimmedKey = key.trim();
        // Don't overwrite existing env vars (command line precedence)
        if (process.env[trimmedKey] === undefined) {
          process.env[trimmedKey] = valueParts.join('=').trim();
        }
      }
    });
  }
}

/**
 * Structured logging
 */
export function log(level, message) {
  const timestamp = new Date().toISOString();
  const prefix = { INFO: '●', WARN: '⚠', ERROR: '✖', DEBUG: '○' }[level] || '○';
  console.log(`[${timestamp}] ${prefix} ${message}`);
}

/**
 * Format number with locale
 */
export function formatNumber(n, locale = 'en-US') {
  return new Intl.NumberFormat(locale).format(n);
}

/**
 * Format percentage
 */
export function formatPercent(n) {
  return `${Math.round(n)}%`;
}

/**
 * Calculate percentage
 */
export function pct(value, total) {
  if (total === 0) return 0;
  return Math.round((value / total) * 100);
}

/**
 * Delay helper
 */
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default { loadEnv, log, formatNumber, formatPercent, pct, delay };
