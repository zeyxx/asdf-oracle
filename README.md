# K-Metric Dashboard 🔥

**this is fine** 🐕🔥 - On-chain holder conviction tracking for $asdfasdfa on Solana.

> Price is noise. K is signal.

## What is K?

K-Metric measures the percentage of holders who maintained or increased their position. It's a behavioral constant that filters out paper hands.

```
K = (maintained + accumulators) / total_holders × 100
```

## Features

- **Real-time tracking** via Helius webhooks
- **Polling fallback** every 5 minutes (no single point of failure)
- **PoH ordering** using Solana slots (no duplicates)
- **SQLite storage** with automated backups
- **Rate limiting** and input validation
- **Fire theme** dashboard with "This is Fine" mode

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    K-METRIC SYSTEM                      │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Data Sources (redundancy):                             │
│  ├── Helius Webhook (real-time)                         │
│  └── Polling fallback (5min)                            │
│                                                         │
│  Storage (backup):                                      │
│  ├── SQLite primary                                     │
│  └── Auto backups (6h) + manual                         │
│                                                         │
│  Security:                                              │
│  ├── Rate limiting (100 req/min)                        │
│  ├── HMAC-SHA256 webhook signature                      │
│  ├── Input validation                                   │
│  └── PoH slot ordering                                  │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

## Quick Start

```bash
# 1. Configure
cp .env.example .env
# Edit .env with your Helius API key

# 2. Initial sync (fetches all historical data)
node scripts/backfill.js

# 3. Start server
node src/server.js
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/k-metric` | GET | Current K-metric + token price |
| `/k-metric/history` | GET | Historical snapshots |
| `/k-metric/holders` | GET | Holder list with stats |
| `/k-metric/status` | GET | Sync status |
| `/k-metric/health` | GET | Health check |
| `/k-metric/webhook` | POST | Helius webhook receiver |
| `/k-metric/sync` | POST | Force manual sync |
| `/k-metric/backup` | POST | Create manual backup |

## Configuration

```env
# Required
HELIUS_API_KEY=your-helius-api-key

# Webhook security (generate with: openssl rand -hex 32)
HELIUS_WEBHOOK_SECRET=your-webhook-secret

# Token config
TOKEN_MINT=9zB5wRarXMj86MymwLumSKA1Dx35zPqqKfcZtK1Spump
TOKEN_SYMBOL=asdfasdfa
MIN_BALANCE=1000

# Server
PORT=3001
```

## Helius Webhook Setup

1. Go to https://dashboard.helius.dev/webhooks
2. Create webhook:
   - **Network**: mainnet
   - **Type**: enhanced
   - **URL**: `https://your-domain.com/k-metric/webhook`
   - **Auth Header**: your HELIUS_WEBHOOK_SECRET
   - **Account**: `9zB5wRarXMj86MymwLumSKA1Dx35zPqqKfcZtK1Spump`

## File Structure

```
asdf-oracle/
├── src/
│   ├── server.js      # HTTP server + static files
│   ├── router.js      # API routes
│   ├── db.js          # SQLite wrapper (PoH slots)
│   ├── helius.js      # Helius API client
│   ├── calculator.js  # K-Metric calculation
│   ├── webhook.js     # Real-time event handler
│   ├── sync.js        # Polling fallback
│   ├── security.js    # Rate limit, backup, validation
│   └── utils.js       # Helpers
├── scripts/
│   └── backfill.js    # Initial data sync
├── css/
│   └── style.css      # Fire theme
├── data/
│   └── k-metric.db    # SQLite database (gitignored)
├── index.html         # Dashboard frontend
└── .env.example       # Config template
```

## Security

- **No secrets in code** - all config via .env
- **Webhook signature verification** - HMAC-SHA256
- **Rate limiting** - 100 requests/minute per IP
- **Input validation** - payload size limits
- **Automated backups** - every 6 hours
- **PoH ordering** - prevents duplicate processing

## License

MIT

---

**chaos is a filter** 🔥
