# Development State - 2024-12-23

## Current Status: OPERATIONAL (Oracle API v2 + Webhooks)

### Sprint 1: Multi-Tenant API (Complete)

#### API Keys
- Tier-based access control (free/standard/premium/internal)
- Rate Limiting V2 with daily quotas
- Usage tracking per key

#### Batch Endpoints
- `POST /api/v1/wallets` - Batch K_wallet lookup (max 100)
- `POST /api/v1/tokens` - Batch Token K lookup (max 50)
- `GET /api/v1/holders` - Filtered holders list

### Sprint 2: Webhooks (Complete)

#### Outbound Notifications
Clients can subscribe to events and receive POST notifications.

**Event Types:**
| Event | Description |
|-------|-------------|
| `k_change` | K metric changes by more than 1% |
| `holder_new` | New holder detected |
| `holder_exit` | Holder exits (balance = 0) |
| `threshold_alert` | K crosses a configured threshold |

**Webhook Endpoints:**
```
GET  /api/v1/webhooks/events       - List available events
GET  /api/v1/webhooks              - List your webhooks
POST /api/v1/webhooks              - Create webhook
GET  /api/v1/webhooks/:id          - Get webhook details
DELETE /api/v1/webhooks/:id        - Delete webhook
GET  /api/v1/webhooks/:id/deliveries - Delivery history
```

**Security:**
- HMAC-SHA256 signature in `X-Oracle-Signature` header
- 3 retry attempts with exponential backoff (1m, 5m, 15m)
- Auto-disable after 5 consecutive failures

### API Keys Active
- **ASDev** (internal): `oracle_internal_2dc663e977854253b7da646a1506438c`

### Tier Limits
| Tier | Requests/min | Requests/day |
|------|--------------|--------------|
| public | 100 | 10,000 |
| free | 500 | 50,000 |
| standard | 1,000 | 100,000 |
| premium | 5,000 | 500,000 |
| internal | unlimited | unlimited |

### Example: Create Webhook
```bash
curl -X POST http://localhost:3001/api/v1/webhooks \
  -H "X-Oracle-Key: oracle_internal_xxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-app.com/webhook",
    "events": ["k_change", "holder_new"]
  }'
```

### Example: Webhook Payload
```json
{
  "event": "k_change",
  "timestamp": 1766535836,
  "data": {
    "previous_k": 85,
    "new_k": 87,
    "delta": 2,
    "holders": 407,
    "direction": "up"
  }
}
```

### Signature Verification (Client Side)
```javascript
const crypto = require('crypto');

function verifySignature(payload, signature, secret) {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(payload))
    .digest('hex');
  return signature === expected;
}
```

### Database Stats
- 407 holders tracked
- K = 86%
- 1 API key active
- 2 webhook subscriptions

### Commands
```bash
npm start              # Run server
npm run dev            # Run with --watch
npm run backfill       # Initial sync
```

### Next Steps (Sprint 3)
- [ ] OpenAPI/Swagger spec
- [ ] Admin dashboard UI (GCRTRD)
- [ ] On-chain oracle integration (future)
