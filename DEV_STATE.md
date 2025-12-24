# K-Metric Oracle - Development State

## Status: OPERATIONAL

**Version:** API v2 + WebSocket
**Sync Mode:** Hybrid (webhook + 5min polling fallback)
**Database:** SQLite WAL mode + LRU caching
**Capacity:** 10k+ concurrent users

---

## Architecture

```
Helius ──webhook──▶ server ──▶ SQLite (WAL mode)
           │           │
       polling         ├──▶ LRU Cache (K, API keys, wallets)
       fallback        ├──▶ K calculator
                       ├──▶ Wallet scorer (queue)
                       ├──▶ Token scorer (queue)
                       ├──▶ WebSocket broadcaster
                       └──▶ Webhook dispatcher
```

```
src/
├── server.js          HTTP server, CORS, WebSocket upgrade
├── router.js          API route aggregator
├── routes/            Modular handlers (dashboard, api-v1, admin, webhooks)
├── db/                Modular DB (connection, wallets, transactions, api-keys)
├── ws.js              Native WebSocket (RFC 6455)
├── cache.js           LRU cache layer
├── sync.js            Hybrid sync (webhook + polling)
├── calculator.js      K-metric calculation
├── wallet-score.js    K_wallet background queue
├── token-score.js     Token K scoring
├── webhooks.js        Outbound webhook dispatcher
├── security.js        Rate limiting, validation, backups
└── gating.js          Token-gated access control
```

---

## Performance

| Layer | Optimization |
|-------|--------------|
| SQLite | WAL mode + 64MB cache + 256MB mmap |
| K-metric | 30s cache TTL |
| API keys | 5min cache TTL |
| Wallets | 1h cache TTL |
| Static files | Async I/O + 5min cache |
| WebSocket | Native RFC 6455, 5 conn/key |

---

## API Reference

### Dashboard (`/k-metric`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/k-metric` | Current K + holder breakdown |
| GET | `/k-metric/history` | Historical snapshots |
| GET | `/k-metric/holders` | All holders with classifications |
| GET | `/k-metric/status` | Sync + queue + cache stats |
| GET | `/k-metric/wallet/:addr/k-score` | Wallet K (this token) |
| GET | `/k-metric/wallet/:addr/k-global` | Wallet K (all tokens) |
| POST | `/k-metric/webhook` | Helius webhook receiver |

### Oracle API (`/api/v1`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/status` | Oracle status |
| GET | `/api/v1/token/:mint` | Token K score |
| GET | `/api/v1/wallet/:addr` | Wallet scores |
| POST | `/api/v1/wallets` | Batch wallets (max 100) |
| POST | `/api/v1/tokens` | Batch tokens (max 50) |
| GET | `/api/v1/holders` | Filtered by K score |

### WebSocket (`/ws`)

```javascript
const ws = new WebSocket('ws://host/ws?key=API_KEY');
ws.onmessage = (e) => {
  const { event, data, ts } = JSON.parse(e.data);
};
```

| Event | Payload | Trigger |
|-------|---------|---------|
| `k` | `{k, holders, delta}` | K change >= 1% |
| `holder:new` | `{address, balance}` | New holder |
| `holder:exit` | `{address}` | Holder exits |
| `tx` | `{signature, wallet, amount}` | Transaction |

### Webhooks (`/api/v1/webhooks`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/webhooks/events` | List events |
| GET | `/api/v1/webhooks` | List subscriptions |
| POST | `/api/v1/webhooks` | Create subscription |
| DELETE | `/api/v1/webhooks/:id` | Delete |

**Events:** `k_change`, `holder_new`, `holder_exit`, `threshold_alert`

---

## Rate Limits

| Tier | /min | /day |
|------|------|------|
| public | 100 | 10k |
| free | 500 | 50k |
| standard | 1k | 100k |
| premium | 5k | 500k |
| internal | unlimited | unlimited |

Header: `X-Oracle-Key: <key>`

---

## Commands

```bash
npm start        # Run server (port 3001)
npm run dev      # Development (--watch)
npm run backfill # Initial sync
```
