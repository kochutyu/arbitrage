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
}
