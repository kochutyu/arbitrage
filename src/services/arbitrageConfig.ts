function readNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Minimum 24h volume (in quote currency, typically USDT) required on BOTH legs.
 */
export const MIN_24H_VOLUME = readNumberEnv('MIN_24H_VOLUME', 50_000);

/**
 * Reject opportunity if slippage (best -> executable) exceeds this % on either leg.
 */
export const MAX_SLIPPAGE_PERCENT = readNumberEnv('MAX_SLIPPAGE_PERCENT', 0.8);

/**
 * Reject opportunity if estimated real profit for DEFAULT_TRADE_AMOUNT is below this USD.
 */
export const MIN_REAL_PROFIT_USD = readNumberEnv('MIN_REAL_PROFIT_USD', 5);

/**
 * Trade size used to compute executable VWAP + real profit (in quote currency, typically USDT).
 */
export const DEFAULT_TRADE_AMOUNT = readNumberEnv('DEFAULT_TRADE_AMOUNT', 100);


