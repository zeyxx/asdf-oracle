# asdf-oracle

On-chain conviction scoring API for Solana tokens.

## What It Does

Returns K scores — the percentage of holders who kept or grew their position through volatility. Query any wallet or token, get a trust signal.

```bash
curl http://localhost:3001/api/v1/wallet/YOUR_WALLET
```

```json
{
  "address": "...",
  "k_wallet": 85,
  "tokens_analyzed": 12,
  "classification": "accumulator"
}
```

## Quick Start

```bash
# Clone
git clone https://github.com/zeyxx/asdf-oracle.git
cd asdf-oracle

# Configure
cp .env.example .env
# Add HELIUS_API_KEY and TOKEN_MINT

# Run (Node.js 22+ required)
npm start
```

Server runs at `http://localhost:3001`

## Requirements

- Node.js 22+
- Helius API key
- Token mint address (the token you're tracking)

## API Reference

### Public Endpoints

| Method | Endpoint | What It Does |
|--------|----------|--------------|
| GET | `/api/v1/status` | Oracle health + queue stats |
| GET | `/api/v1/token/:mint` | K score for any PumpFun token |
| GET | `/api/v1/wallet/:addr` | Wallet conviction scores |

### Batch Endpoints (API Key Required)

| Method | Endpoint | What It Does | Limit |
|--------|----------|--------------|-------|
| POST | `/api/v1/wallets` | Bulk wallet lookup | 100 |
| POST | `/api/v1/tokens` | Bulk token lookup | 50 |
| GET | `/api/v1/holders` | Filter holders by K score | - |

### WebSocket (Real-time)

```javascript
const ws = new WebSocket('ws://localhost:3001/ws?key=YOUR_API_KEY');
ws.onmessage = (e) => {
  const { event, data, ts } = JSON.parse(e.data);
  // event: 'k' | 'holder:new' | 'holder:exit' | 'tx'
};
```

| Event | Payload | Trigger |
|-------|---------|---------|
| `k` | `{k, holders, delta}` | K change >= 1% |
| `holder:new` | `{address, balance}` | New holder |
| `holder:exit` | `{address}` | Holder exits |
| `tx` | `{signature, wallet, amount}` | Transaction |

### Webhooks (HTTP)

Subscribe to events: `k_change`, `holder_new`, `holder_exit`, `threshold_alert`

| Method | Endpoint | What It Does |
|--------|----------|--------------|
| POST | `/api/v1/webhooks` | Create subscription |
| GET | `/api/v1/webhooks` | List your webhooks |
| DELETE | `/api/v1/webhooks/:id` | Remove subscription |

## Authentication

Header: `X-Oracle-Key: your_api_key`

| Tier | Requests/min | Requests/day |
|------|--------------|--------------|
| public (no key) | 100 | 10,000 |
| free | 500 | 50,000 |
| standard | 1,000 | 100,000 |
| premium | 5,000 | 500,000 |
| internal | unlimited | unlimited |

Rate limit headers included in every response:
```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 87
X-RateLimit-Reset: 1703350800
X-RateLimit-Tier: public
```

## Environment

```env
# Required
HELIUS_API_KEY=your_key
TOKEN_MINT=token_to_track

# Production
HELIUS_WEBHOOK_SECRET=your_secret
NODE_ENV=production
ADMIN_KEY=your_admin_key
```

## Error Codes

| Code | Meaning |
|------|---------|
| 400 | Invalid address format |
| 401 | Missing or invalid API key |
| 403 | Access denied (holder gating) |
| 429 | Rate limit exceeded |
| 500 | Internal error |
| 503 | Maintenance mode |

## Troubleshooting

**"No wallet data found"**
- Run `npm run backfill` for initial sync

**Rate limited immediately?**
- Public tier is 100/min. Get an API key for higher limits.

**K_wallet returns 202?**
- Calculation queued. Retry after `retry_after` seconds.

**Webhook not receiving events?**
- Check `/api/v1/webhooks/:id/deliveries` for failure logs
- Verify HMAC signature validation on your end

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

**Performance (10k+ users)**
- SQLite WAL + 64MB cache + mmap
- LRU caching (K: 30s, API keys: 5min, wallets: 1h)
- Async static file I/O
- Native WebSocket (RFC 6455)

No external dependencies. Native Node.js 22 + SQLite.

## Related

- [asdf-burn-engine](https://github.com/zeyxx/asdf-burn-engine) — Burns based on K
- [asdf-validator](https://github.com/zeyxx/asdf-validator) — Fee tracking

---

*this is fine*
