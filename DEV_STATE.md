# Development State - 2024-12-23

## Current Status: PAUSED (Helius credits exhausted)

### What Works
- K-Metric Dashboard fully functional (cached data)
- API v1 endpoints ready for ASDev integration
- Maintenance mode implemented ("this is fine" overlay)

### API Endpoints Ready
```
GET /api/v1/status        - Oracle status
GET /api/v1/token/:mint   - K score for any PumpFun/Ignition token
GET /api/v1/wallet/:addr  - Wallet K scores (K_wallet + primary token)
```

### Last Session Work
1. **Token K scoring for ASDev** - Analyzing token 2Pot5sqDBiQBtEHU5eJgHSNeaxVBqu2X7Yxpv2bKASDF
2. **Optimized token-score.js** - Changed from sequential to parallel processing (5 concurrent)
3. **Reduced sample size** - MAX_HOLDERS_TO_ANALYZE: 500 -> 50 for speed
4. **Added maintenance mode** - `MAINTENANCE=1` in .env or `?maintenance` URL param

### Resume Checklist
1. Get new Helius API key (100k credits/month free tier)
2. Update `.env` with new `HELIUS_API_KEY`
3. Set `MAINTENANCE=0` in `.env`
4. Restart server: `npm start`
5. Test token K: `curl http://localhost:3001/api/v1/token/2Pot5sqDBiQBtEHU5eJgHSNeaxVBqu2X7Yxpv2bKASDF`

### Next Steps for ASDev Integration
See CLAUDE.md "ASDev Integration Guide" section for:
- A. Wallet Score on Dashboard (K_wallet display)
- B. Airdrop Boost (K > 80% = 2x multiplier)
- C. Trust Score on Leaderboard (token K display)

The integration logic stays in ASDev, Oracle just provides data.

### Files Modified This Session
- `src/token-score.js` - Parallel processing optimization
- `src/router.js` - Added maintenance flag to status
- `index.html` - Maintenance mode overlay
- `.env.example` - Added MAINTENANCE and HELIUS_RATE_LIMIT

### Database State
SQLite at `data/k-metric.db` contains:
- 6354 wallets tracked
- 63843 transactions indexed
- K = 87% (last calculated)
- 94 K_wallet scores cached

### Commands
```bash
npm start              # Run server
npm run dev            # Run with --watch
npm run backfill       # Initial sync (requires Helius credits)

# Force maintenance mode
MAINTENANCE=1 npm start

# Test maintenance via URL
http://localhost:3001/?maintenance
```
