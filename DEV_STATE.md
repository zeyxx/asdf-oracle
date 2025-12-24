# K-Metric Oracle - Development State

## Status: OPERATIONAL

**Version:** API v2
**Sync Mode:** Hybrid (webhook + 5min polling fallback)
**Database:** SQLite with automated backups (6h)

### Live Stats
| Metric | Value |
|--------|-------|
| K Score | 87% |
| Holders | 408 |
| Transactions | 64,090 |
| Snapshots | 47 |

---

## API Reference

### Dashboard API (`/k-metric`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/k-metric` | Current K score + holder breakdown |
| GET | `/k-metric/history` | Historical snapshots |
| GET | `/k-metric/holders` | All holders with classifications |
| GET | `/k-metric/status` | Sync status + queue health |
| GET | `/k-metric/wallet/:addr/k-score` | Wallet K for primary token |
| GET | `/k-metric/wallet/:addr/k-global` | Wallet K across all tokens |
| POST | `/k-metric/webhook` | Helius webhook receiver |

### Oracle API v1 (`/api/v1`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/status` | Oracle status |
| GET | `/api/v1/token/:mint` | K score for any PumpFun token |
| GET | `/api/v1/wallet/:addr` | Wallet scores |
| POST | `/api/v1/wallets` | Batch wallet lookup (max 100) |
| POST | `/api/v1/tokens` | Batch token lookup (max 50) |
| GET | `/api/v1/holders` | Filtered holders by K score |

### Webhooks (`/api/v1/webhooks`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/webhooks/events` | List available events |
| GET | `/api/v1/webhooks` | List subscriptions |
| POST | `/api/v1/webhooks` | Create subscription |
| DELETE | `/api/v1/webhooks/:id` | Delete subscription |
| GET | `/api/v1/webhooks/:id/deliveries` | Delivery history |

**Events:** `k_change`, `holder_new`, `holder_exit`, `threshold_alert`

---

## Authentication

### API Keys
Header: `X-Oracle-Key: <key>`

| Tier | Requests/min | Requests/day |
|------|--------------|--------------|
| public | 100 | 10,000 |
| free | 500 | 50,000 |
| standard | 1,000 | 100,000 |
| premium | 5,000 | 500,000 |
| internal | unlimited | unlimited |

### Webhook Security
- HMAC-SHA256 signature in `X-Oracle-Signature` header
- Exponential backoff retry (1m, 5m, 15m)
- Auto-disable after 5 consecutive failures

---

## Commands
```bash
npm start        # Run server
npm run dev      # Development mode (--watch)
npm run backfill # Initial sync from Helius
```

---

## Architecture
```
src/
├── server.js       HTTP server, CORS, rate limiting
├── router.js       API route handlers
├── sync.js         Hybrid sync (webhook + polling)
├── webhook.js      Helius webhook processor
├── calculator.js   K-metric calculation
├── wallet-score.js K_wallet background queue
├── token-score.js  Token K scoring
├── webhooks.js     Outbound webhook dispatcher
├── security.js     Rate limiting, validation
├── gating.js       Token-gated access control
├── db.js           SQLite persistence
└── utils.js        Logging, env loading
```
