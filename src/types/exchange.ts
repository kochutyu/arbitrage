export interface Pair {
  base: string;
  quote: string;
  symbol: string;
}

export interface ExchangeConfig {
  name: string;
  fees: ExchangeFees;
  getPairs: () => Promise<Pair[]>;
  getPrices: (pairs: string[]) => Promise<Record<string, number>>;
  /**
   * 24h ticker data (best-effort, public endpoints only).
   * `quoteVolume24h` is expected to be in quote currency units; for this project it is typically USDT.
   */
  getTickers24h?: (pairs: string[]) => Promise<Record<string, Ticker24h>>;
  /**
   * Spot order book (best-effort, public endpoints only).
   * Prices are in quote currency per 1 base unit; amounts are in base units.
   */
  getOrderBook?: (symbol: string) => Promise<OrderBook | null>;
  /**
   * Currency metadata for deposit/withdraw/network checks.
   * NOTE: Many exchanges require authentication for this; if unavailable, return null/undefined.
   */
  getCurrencies?: () => Promise<Record<string, CurrencyInfo> | null>;
}

export interface ExchangeFees {
  takerFeePercent: number;
  transferFeePercent?: number;
}

export interface OpportunityLeg {
  exchange: string;
  price: number;
  effectivePrice: number;
  feePercentApplied: number;
}

export type PriceByExchange = Record<string, number>;

export type PricesBySymbol = Record<string, PriceByExchange>;

export interface ArbitrageOpportunity {
  symbol: string;
  min: number;
  max: number;
  diff: number;
  netDiff: number;
  buy: OpportunityLeg;
  sell: OpportunityLeg;
  exchanges: PriceByExchange;
  // Added in validation step (optional; not all exchanges support the needed public APIs).
  tradeAmountUsd?: number;
  realProfitUsd?: number;
  validation?: OpportunityValidation;
}

export interface Ticker24h {
  last?: number;
  /**
   * 24h quote volume (e.g. USDT volume for BASE/USDT pairs).
   * If exchange provides base volume only, this may be omitted.
   */
  quoteVolume24h?: number;
}

export type OrderBookLevel = readonly [price: number, amount: number];

export interface OrderBook {
  bids: OrderBookLevel[]; // sorted desc by price ideally
  asks: OrderBookLevel[]; // sorted asc by price ideally
}

export interface CurrencyNetworkInfo {
  network: string;
  depositEnabled?: boolean;
  withdrawEnabled?: boolean;
}

export interface CurrencyInfo {
  code: string; // normalized currency code, e.g. BTC
  networks?: CurrencyNetworkInfo[];
}

export interface OpportunityValidation {
  status: 'validated' | 'rejected';
  reasons?: string[];
  buy?: OpportunityLegValidation;
  sell?: OpportunityLegValidation;
  transfer?: TransferValidation;
}

export interface OpportunityLegValidation {
  bestPrice?: number;
  executablePrice?: number;
  slippagePercent?: number;
  volume24hQuote?: number;
}

export interface TransferValidation {
  /**
   * - ok: we found a common network with withdraw+deposit enabled
   * - blocked: we checked and there is no viable network
   * - unknown: exchange returned currency metadata but it's incomplete/ambiguous => SKIP conservatively
   * - unavailable: exchange does not provide this via public API (or endpoint not implemented) => best-effort only
   */
  status: 'ok' | 'unknown' | 'blocked' | 'unavailable';
  network?: string;
  reason?: string;
}
