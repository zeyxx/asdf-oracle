# asdf-oracle 🔥

**K-Metric Dashboard** — Holder conviction, measured on-chain.

```
K = (maintained + accumulators) / total holders
```

No narrative. Just math.

---

## What is K?

K measures who actually holds through chaos.

| Classification | Retention | Meaning |
|----------------|-----------|---------|
| **Accumulator** | ≥ 1.5 | Bought more |
| **Holder** | ≥ 1.0 | Never sold |
| **Reducer** | ≥ 0.5 | Sold some |
| **Extractor** | < 0.5 | Paper hands |

**K = % of holders who maintained or accumulated.**

A KOL claims diamond hands? Check their K_wallet.

---

## Features

- **Real-time sync** — Helius webhooks + polling fallback
- **PoH ordering** — Solana slot-based transaction ordering
- **K_wallet** — Global conviction score across all PumpFun tokens
- **Pool detection** — Hide Raydium/Orca/Meteora liquidity
- **SQLite storage** — Native Node.js 22, no dependencies

---

## Quick Start

```bash
# Requirements: Node.js 22+
node -v  # v22.x.x

# Setup
cp .env.example .env
# Add your HELIUS_API_KEY and TOKEN_MINT

# Run
npm start
# or
./start.sh
```

Dashboard: `http://localhost:3001`

---

## API

| Endpoint | Description |
|----------|-------------|
| `GET /k-metric` | Current K + holder stats |
| `GET /k-metric/holders` | All holders with classifications |
| `GET /k-metric/wallet/:addr` | Single wallet data |
| `GET /k-metric/wallet/:addr/k-global` | K_wallet (all PumpFun tokens) |
| `GET /k-metric/status` | Sync status |
| `POST /k-metric/webhook` | Helius webhook receiver |

---

## Environment

```env
HELIUS_API_KEY=your_key
HELIUS_WEBHOOK_SECRET=your_secret  # Required in production
TOKEN_MINT=your_token_mint
NODE_ENV=production                # Enables security checks
```

---

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Helius    │────▶│   server    │────▶│   SQLite    │
│  webhooks   │     │   + sync    │     │    (PoH)    │
└─────────────┘     └─────────────┘     └─────────────┘
                           │
                           ▼
                    ┌─────────────┐
                    │  Dashboard  │
                    │  (static)   │
                    └─────────────┘
```

---

## Security

- **CORS** — Whitelist-based (localhost, Codespaces, Render, alonisthe.dev)
- **Webhook** — HMAC signature verification required in production
- **Rate limiting** — 100 req/min per IP
- **Input validation** — Address format, payload size
- **Backups** — Automatic every 6 hours

---

## Part of the Optimistic Burn Protocol

This dashboard feeds into the $ASDFASDFA ecosystem:

- **[asdf-validator](https://github.com/zeyxx/asdf-validator)** — Fee tracking
- **[asdf-burn-engine](https://github.com/zeyxx/asdf-burn-engine)** — Automatic burns

K-Metric proves conviction. Burns reward it.

---

## Contributing

Prototype for [alonisthe.dev](https://alonisthe.dev) by [@gcrtrd](https://x.com/gcrtrd).

---

*price is noise · K is signal · 🔥 this is fine*
