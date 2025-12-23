# Arbitrage Node Server

Node.js + TypeScript starter with Express and axios. Provides live exchange price scan for spot arbitrage.

## Scripts
- `npm run dev` — start with nodemon + ts-node
- `npm run build` — compile TypeScript to `dist`
- `npm start` — run compiled server
- `npm run arbitrage` — run standalone arbitrage scan (uses live exchange APIs)
- Frontend UI (Angular): `cd frontend && npm start`

## Environment
- `PORT` (default: `3000`)
- `MIN_DIFF_PERCENT` (default: `0.5`) — threshold for arbitrage diff
- `EXCHANGE_FEES_JSON` — optional JSON overrides for taker/transfer fees, e.g. `{"binance":{"takerFeePercent":0.1},"okx":{"takerFeePercent":0.08,"transferFeePercent":0.02}}`
Frontend UI uses `http://localhost:3000` by default; adjust in the UI if your API runs elsewhere.

## Endpoints
- `GET /health` — service health probe
- `GET /api/arbitrage?minDiffPercent=0.5` — scan exchanges for price deltas above threshold
- Frontend UI at `frontend/` displays arbitrage table with manual/auto refresh and filters

Arbitrage results now include `netDiff` (after taker + transfer fee assumptions per exchange) and best buy/sell legs; filtering uses `netDiff`.

## Structure
- `src/app.ts` — Express app entry
- `src/services/` — exchange configs + arbitrage logic
- `src/scripts/` — CLI scripts
- `src/interfaces/` — shared interfaces
- `src/types/` — response and helper types
