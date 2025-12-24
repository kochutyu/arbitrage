import { exchanges } from './exchangeConfigs.js';
import type {
  ArbitrageOpportunity,
  ExchangeConfig,
  ExchangeFees,
  OrderBook,
  OpportunityLeg,
  OpportunityValidation,
  PricesBySymbol
} from '../types/exchange.js';
import {
  DEFAULT_TRADE_AMOUNT,
  MAX_SLIPPAGE_PERCENT,
  MIN_24H_VOLUME,
  MIN_REAL_PROFIT_USD
} from './arbitrageConfig.js';

const envMinDiff = Number(process.env.MIN_DIFF_PERCENT ?? 0.5);
export const DEFAULT_MIN_DIFF_PERCENT = Number.isNaN(envMinDiff) ? 0.5 : envMinDiff;

export async function collectPairs(): Promise<Map<string, string[]>> {
  const pairsByExchange = await Promise.all(
    exchanges.map(async (exchange) => ({ exchange: exchange.name, pairs: await exchange.getPairs() }))
  );

  const map = new Map<string, string[]>();

  for (const { exchange, pairs } of pairsByExchange) {
    for (const pair of pairs) {
      if (!map.has(pair.symbol)) {
        map.set(pair.symbol, []);
      }

      map.get(pair.symbol)!.push(exchange);
    }
  }

  return map;
}

export async function collectPrices(pairMap: Map<string, string[]>): Promise<PricesBySymbol> {
  const prices: PricesBySymbol = {};

  await Promise.all(
    exchanges.map(async (exchange) => {
      const symbols = symbolsForExchange(pairMap, exchange);
      if (symbols.length === 0) return;

      const exchangePrices = await exchange.getPrices(symbols);
      for (const [symbol, price] of Object.entries(exchangePrices)) {
        prices[symbol] ??= {};
        prices[symbol][exchange.name] = price;
      }
    })
  );

  return prices;
}

export function findArbitrage(prices: PricesBySymbol, minDiffPercent: number): ArbitrageOpportunity[] {
  const exchangeLookup = new Map(exchanges.map((exchange) => [exchange.name, exchange]));

  return Object.entries(prices)
    .map(([symbol, exchangePrices]) => {
      const entries = Object.entries(exchangePrices);
      if (entries.length < 2) return null;

      const rawPrices = entries.map(([, price]) => price);
      const min = Math.min(...rawPrices);
      const max = Math.max(...rawPrices);
      const grossDiff = ((max - min) / min) * 100;

      const buyLegs = entries.map(([exchange, price]) =>
        buildLeg(exchangeLookup.get(exchange)?.fees, exchange, price, 'buy')
      );
      const sellLegs = entries.map(([exchange, price]) =>
        buildLeg(exchangeLookup.get(exchange)?.fees, exchange, price, 'sell')
      );

      const bestBuy = buyLegs.reduce((best, next) => (next.effectivePrice < best.effectivePrice ? next : best));
      const bestSell = sellLegs.reduce((best, next) => (next.effectivePrice > best.effectivePrice ? next : best));

      const netDiff = ((bestSell.effectivePrice - bestBuy.effectivePrice) / bestBuy.effectivePrice) * 100;

      if (netDiff < minDiffPercent) return null;

      return {
        symbol,
        min,
        max,
        diff: Number(grossDiff.toFixed(2)),
        netDiff: Number(netDiff.toFixed(2)),
        buy: bestBuy,
        sell: bestSell,
        exchanges: exchangePrices
      };
    })
    .filter((entry): entry is ArbitrageOpportunity => Boolean(entry));
}

export async function getArbitrageOpportunities(minDiffPercent?: number) {
  const threshold =
    typeof minDiffPercent === 'number' && !Number.isNaN(minDiffPercent)
      ? minDiffPercent
      : DEFAULT_MIN_DIFF_PERCENT;

  const pairMap = await collectPairs();
  const prices = await collectPrices(pairMap);
  const candidates = findArbitrage(prices, threshold);
  return await validateOpportunities(candidates);
}

function symbolsForExchange(pairMap: Map<string, string[]>, exchange: ExchangeConfig): string[] {
  return [...pairMap.entries()]
    .filter(([, exchangesWithPair]) => exchangesWithPair.includes(exchange.name))
    .map(([symbol]) => symbol);
}

function buildLeg(
  fees: ExchangeFees | undefined,
  exchange: string,
  price: number,
  side: 'buy' | 'sell'
): OpportunityLeg {
  const totalFeePercent = (fees?.takerFeePercent ?? 0) + (fees?.transferFeePercent ?? 0);
  const multiplier = side === 'buy' ? 1 + totalFeePercent / 100 : 1 - totalFeePercent / 100;
  const effectivePrice = price * multiplier;

  return {
    exchange,
    price,
    effectivePrice,
    feePercentApplied: totalFeePercent
  };
}

async function validateOpportunities(opportunities: ArbitrageOpportunity[]): Promise<ArbitrageOpportunity[]> {
  const exchangeLookup = new Map(exchanges.map((exchange) => [exchange.name, exchange]));

  // Pre-fetch 24h tickers in batches where supported (best-effort).
  const symbolsByExchange = new Map<string, Set<string>>();
  for (const opp of opportunities) {
    const buy = exchangeLookup.get(opp.buy.exchange);
    const sell = exchangeLookup.get(opp.sell.exchange);
    if (buy?.getTickers24h) addSymbol(symbolsByExchange, buy.name, opp.symbol);
    if (sell?.getTickers24h) addSymbol(symbolsByExchange, sell.name, opp.symbol);
  }

  const tickersCache = new Map<string, Record<string, { last?: number; quoteVolume24h?: number }>>();
  await Promise.all(
    [...symbolsByExchange.entries()].map(async ([exchangeName, symbolsSet]) => {
      const ex = exchangeLookup.get(exchangeName);
      if (!ex?.getTickers24h) return;
      try {
        const tickers = await ex.getTickers24h([...symbolsSet]);
        tickersCache.set(exchangeName, tickers);
      } catch {
        // Best-effort: treat as unknown => conservative reject later.
        tickersCache.set(exchangeName, {});
      }
    })
  );

  // Pre-fetch currency metadata once per exchange where supported (best-effort).
  const currenciesCache = new Map<string, Record<string, { code: string; networks?: { network: string; depositEnabled?: boolean; withdrawEnabled?: boolean }[] }> | null>();
  const exchangesNeedingCurrencies = new Set<string>();
  for (const opp of opportunities) {
    exchangesNeedingCurrencies.add(opp.buy.exchange);
    exchangesNeedingCurrencies.add(opp.sell.exchange);
  }
  await Promise.all(
    [...exchangesNeedingCurrencies].map(async (name) => {
      const ex = exchangeLookup.get(name);
      if (!ex?.getCurrencies) return;
      try {
        const data = await ex.getCurrencies();
        currenciesCache.set(name, data);
      } catch {
        currenciesCache.set(name, null);
      }
    })
  );

  const validated = await Promise.all(
    opportunities.map(async (opp) => {
      const buyEx = exchangeLookup.get(opp.buy.exchange);
      const sellEx = exchangeLookup.get(opp.sell.exchange);
      if (!buyEx || !sellEx) return null;

      const reasons: string[] = [];

      // 1) Liquidity / 24h volume filter (quote volume, typically USDT)
      const buyVol = tickersCache.get(buyEx.name)?.[opp.symbol]?.quoteVolume24h;
      const sellVol = tickersCache.get(sellEx.name)?.[opp.symbol]?.quoteVolume24h;

      // If ticker volume is unknown, we conservatively reject (per requirement).
      if (buyVol === undefined) reasons.push(`buy volume_24h unknown on ${buyEx.name}`);
      if (sellVol === undefined) reasons.push(`sell volume_24h unknown on ${sellEx.name}`);
      if (buyVol !== undefined && buyVol < MIN_24H_VOLUME) reasons.push(`buy volume_24h < MIN_24H_VOLUME (${buyVol})`);
      if (sellVol !== undefined && sellVol < MIN_24H_VOLUME) reasons.push(`sell volume_24h < MIN_24H_VOLUME (${sellVol})`);

      // 2) Executable price + slippage (needs order books)
      if (!buyEx.getOrderBook) reasons.push(`order book unsupported on ${buyEx.name}`);
      if (!sellEx.getOrderBook) reasons.push(`order book unsupported on ${sellEx.name}`);
      if (reasons.length > 0) return attachValidation(opp, 'rejected', reasons, buyVol, sellVol);

      const buyBook = await safeOrderBook(buyEx, opp.symbol);
      if (!buyBook) return attachValidation(opp, 'rejected', [`buy order book unavailable on ${buyEx.name}`], buyVol, sellVol);
      const sellBook = await safeOrderBook(sellEx, opp.symbol);
      if (!sellBook) return attachValidation(opp, 'rejected', [`sell order book unavailable on ${sellEx.name}`], buyVol, sellVol);

      const bestAsk = buyBook.asks[0]?.[0];
      const bestBid = sellBook.bids[0]?.[0];
      if (bestAsk === undefined || !Number.isFinite(bestAsk)) {
        return attachValidation(opp, 'rejected', [`best ask missing on ${buyEx.name}`], buyVol, sellVol);
      }
      if (bestBid === undefined || !Number.isFinite(bestBid)) {
        return attachValidation(opp, 'rejected', [`best bid missing on ${sellEx.name}`], buyVol, sellVol);
      }

      const bestAskPrice = bestAsk;
      const bestBidPrice = bestBid;

      const buyFill = vwapBuyForQuoteAmount(buyBook, DEFAULT_TRADE_AMOUNT);
      if (!buyFill) {
        return attachValidation(
          opp,
          'rejected',
          [`insufficient buy-side depth for ${DEFAULT_TRADE_AMOUNT} quote on ${buyEx.name}`],
          buyVol,
          sellVol
        );
      }

      const sellFill = vwapSellForBaseAmount(sellBook, buyFill.baseAmount);
      if (!sellFill) {
        return attachValidation(
          opp,
          'rejected',
          [`insufficient sell-side depth for base amount on ${sellEx.name}`],
          buyVol,
          sellVol
        );
      }

      const buySlippage = ((buyFill.executablePrice - bestAskPrice) / bestAskPrice) * 100;
      const sellSlippage = ((bestBidPrice - sellFill.executablePrice) / bestBidPrice) * 100;
      if (buySlippage > MAX_SLIPPAGE_PERCENT)
        reasons.push(`buy slippage > MAX_SLIPPAGE_PERCENT (${buySlippage.toFixed(3)}%)`);
      if (sellSlippage > MAX_SLIPPAGE_PERCENT)
        reasons.push(`sell slippage > MAX_SLIPPAGE_PERCENT (${sellSlippage.toFixed(3)}%)`);
      if (reasons.length > 0) {
        return attachValidation(
          opp,
          'rejected',
          reasons,
          buyVol,
          sellVol,
          { bestPrice: bestAskPrice, executablePrice: buyFill.executablePrice, slippagePercent: buySlippage },
          { bestPrice: bestBidPrice, executablePrice: sellFill.executablePrice, slippagePercent: sellSlippage }
        );
      }

      // 3) Deposit/Withdraw/Network checks (public endpoints are often unavailable; unknown => reject)
      const base = baseFromSymbolUsdt(opp.symbol);
      const transfer = validateTransferabilityFromCache(
        currenciesCache.get(buyEx.name),
        currenciesCache.get(sellEx.name),
        buyEx,
        sellEx,
        base
      );
      // Per requirement: if status is unknown => conservatively SKIP.
      // If API is unavailable (public endpoints missing), we keep best-effort behavior and continue,
      // but we surface it in `validation.transfer`.
      if (transfer.status === 'unknown' || transfer.status === 'blocked') {
        reasons.push(`transfer check ${transfer.status}${transfer.reason ? `: ${transfer.reason}` : ''}`);
        return attachValidation(
          opp,
          'rejected',
          reasons,
          buyVol,
          sellVol,
          { bestPrice: bestAskPrice, executablePrice: buyFill.executablePrice, slippagePercent: buySlippage },
          { bestPrice: bestBidPrice, executablePrice: sellFill.executablePrice, slippagePercent: sellSlippage },
          transfer
        );
      }

      // 4) Real profit for DEFAULT_TRADE_AMOUNT (USD/USDT)
      const buyFeePct = opp.buy.feePercentApplied;
      const sellFeePct = opp.sell.feePercentApplied;

      const costWithFees = DEFAULT_TRADE_AMOUNT * (1 + buyFeePct / 100);
      const proceedsBeforeFees = sellFill.baseAmount * sellFill.executablePrice;
      const proceedsWithFees = proceedsBeforeFees * (1 - sellFeePct / 100);
      const realProfitUsd = proceedsWithFees - costWithFees;

      if (realProfitUsd < MIN_REAL_PROFIT_USD) {
        reasons.push(`realProfitUsd < MIN_REAL_PROFIT_USD (${realProfitUsd.toFixed(2)})`);
        return attachValidation(
          { ...opp, tradeAmountUsd: DEFAULT_TRADE_AMOUNT, realProfitUsd },
          'rejected',
          reasons,
          buyVol,
          sellVol,
          { bestPrice: bestAskPrice, executablePrice: buyFill.executablePrice, slippagePercent: buySlippage },
          { bestPrice: bestBidPrice, executablePrice: sellFill.executablePrice, slippagePercent: sellSlippage },
          transfer
        );
      }

      const netDiff = (realProfitUsd / costWithFees) * 100;
      const updated: ArbitrageOpportunity = {
        ...opp,
        // Override netDiff with executable+fees estimate (keep grossDiff as informational).
        netDiff: Number(netDiff.toFixed(2)),
        tradeAmountUsd: DEFAULT_TRADE_AMOUNT,
        realProfitUsd: Number(realProfitUsd.toFixed(2)),
        validation: (() => {
          const buyValidation = buildLegValidationRequired({
            bestPrice: bestAskPrice,
            executablePrice: buyFill.executablePrice,
            slippagePercent: buySlippage,
            ...(buyVol !== undefined ? { volume24hQuote: buyVol } : {})
          });
          const sellValidation = buildLegValidationRequired({
            bestPrice: bestBidPrice,
            executablePrice: sellFill.executablePrice,
            slippagePercent: sellSlippage,
            ...(sellVol !== undefined ? { volume24hQuote: sellVol } : {})
          });
          return {
            status: 'validated',
            buy: buyValidation,
            sell: sellValidation,
            transfer
          };
        })()
      };

      return updated;
    })
  );

  return validated.filter((x): x is ArbitrageOpportunity => Boolean(x)).filter((x) => x.validation?.status === 'validated');
}

function attachValidation(
  opp: ArbitrageOpportunity,
  status: OpportunityValidation['status'],
  reasons: string[],
  buyVol?: number,
  sellVol?: number,
  buy?: { bestPrice?: number; executablePrice?: number; slippagePercent?: number },
  sell?: { bestPrice?: number; executablePrice?: number; slippagePercent?: number },
  transfer?: { status: 'ok' | 'unknown' | 'blocked' | 'unavailable'; network?: string; reason?: string }
): ArbitrageOpportunity {
  const validation: OpportunityValidation = { status, reasons };
  const buyVal = buildLegValidationOptional(buy, buyVol);
  const sellVal = buildLegValidationOptional(sell, sellVol);
  if (buyVal) validation.buy = buyVal;
  if (sellVal) validation.sell = sellVal;
  if (transfer) validation.transfer = transfer;
  return {
    ...opp,
    tradeAmountUsd: DEFAULT_TRADE_AMOUNT,
    validation
  };
}

async function safeOrderBook(exchange: ExchangeConfig, symbol: string): Promise<OrderBook | null> {
  try {
    return (await exchange.getOrderBook?.(symbol)) ?? null;
  } catch {
    return null;
  }
}

function addSymbol(map: Map<string, Set<string>>, exchangeName: string, symbol: string) {
  const set = map.get(exchangeName);
  if (set) {
    set.add(symbol);
  } else {
    map.set(exchangeName, new Set([symbol]));
  }
}

function buildLegValidation(input: {
  bestPrice?: number;
  executablePrice?: number;
  slippagePercent?: number;
  volume24hQuote?: number;
}) {
  const out: Record<string, number> = {};
  if (input.bestPrice !== undefined) out.bestPrice = input.bestPrice;
  if (input.executablePrice !== undefined) out.executablePrice = input.executablePrice;
  if (input.slippagePercent !== undefined) out.slippagePercent = input.slippagePercent;
  if (input.volume24hQuote !== undefined) out.volume24hQuote = input.volume24hQuote;
  return Object.keys(out).length > 0 ? (out as unknown as OpportunityValidation['buy']) : undefined;
}

function buildLegValidationOptional(
  partial: { bestPrice?: number; executablePrice?: number; slippagePercent?: number } | undefined,
  volume24hQuote?: number
) {
  const input: { bestPrice?: number; executablePrice?: number; slippagePercent?: number; volume24hQuote?: number } = {};
  if (partial?.bestPrice !== undefined) input.bestPrice = partial.bestPrice;
  if (partial?.executablePrice !== undefined) input.executablePrice = partial.executablePrice;
  if (partial?.slippagePercent !== undefined) input.slippagePercent = partial.slippagePercent;
  if (volume24hQuote !== undefined) input.volume24hQuote = volume24hQuote;
  return buildLegValidation(input);
}

function buildLegValidationRequired(input: {
  bestPrice: number;
  executablePrice: number;
  slippagePercent: number;
  volume24hQuote?: number;
}) {
  const out: { bestPrice: number; executablePrice: number; slippagePercent: number; volume24hQuote?: number } = {
    bestPrice: input.bestPrice,
    executablePrice: input.executablePrice,
    slippagePercent: input.slippagePercent
  };
  if (input.volume24hQuote !== undefined) out.volume24hQuote = input.volume24hQuote;
  return out;
}

function baseFromSymbolUsdt(symbol: string): string {
  // Current project only uses USDT-quoted pairs and normalizes to BASEUSDT.
  return symbol.endsWith('USDT') ? symbol.slice(0, -'USDT'.length) : symbol;
}

function vwapBuyForQuoteAmount(book: OrderBook, quoteAmount: number): { executablePrice: number; baseAmount: number } | null {
  let remainingQuote = quoteAmount;
  let baseBought = 0;
  let quoteSpent = 0;

  for (const [price, amountBase] of book.asks) {
    if (!Number.isFinite(price) || !Number.isFinite(amountBase) || price <= 0 || amountBase <= 0) continue;
    const levelQuote = price * amountBase;
    const takeQuote = Math.min(remainingQuote, levelQuote);
    const takeBase = takeQuote / price;
    baseBought += takeBase;
    quoteSpent += takeQuote;
    remainingQuote -= takeQuote;
    if (remainingQuote <= 1e-9) break;
  }

  if (baseBought <= 0 || remainingQuote > 1e-6) return null;
  return { executablePrice: quoteSpent / baseBought, baseAmount: baseBought };
}

function vwapSellForBaseAmount(book: OrderBook, baseAmount: number): { executablePrice: number; baseAmount: number } | null {
  let remainingBase = baseAmount;
  let baseSold = 0;
  let quoteReceived = 0;

  for (const [price, amountBase] of book.bids) {
    if (!Number.isFinite(price) || !Number.isFinite(amountBase) || price <= 0 || amountBase <= 0) continue;
    const takeBase = Math.min(remainingBase, amountBase);
    baseSold += takeBase;
    quoteReceived += takeBase * price;
    remainingBase -= takeBase;
    if (remainingBase <= 1e-12) break;
  }

  if (baseSold <= 0 || remainingBase > 1e-9) return null;
  return { executablePrice: quoteReceived / baseSold, baseAmount: baseSold };
}

function validateTransferabilityFromCache(
  buyCurrencies: Record<string, { code: string; networks?: { network: string; depositEnabled?: boolean; withdrawEnabled?: boolean }[] }> | null | undefined,
  sellCurrencies: Record<string, { code: string; networks?: { network: string; depositEnabled?: boolean; withdrawEnabled?: boolean }[] }> | null | undefined,
  buyEx: ExchangeConfig,
  sellEx: ExchangeConfig,
  currency: string
): { status: 'ok' | 'unknown' | 'blocked' | 'unavailable'; network?: string; reason?: string } {
  // Many exchanges require auth for currency/network status; do NOT guess.
  if (!buyCurrencies || !sellCurrencies) {
    return {
      status: 'unavailable',
      reason: `fetchCurrencies not available (public API) on ${!buyCurrencies ? buyEx.name : sellEx.name}`
    };
  }

  const buyInfo = buyCurrencies[currency.toUpperCase()];
  const sellInfo = sellCurrencies[currency.toUpperCase()];
  if (!buyInfo?.networks?.length || !sellInfo?.networks?.length) {
    return { status: 'unknown', reason: 'currency networks missing' };
  }

  const buyWithdraw = new Map(
    buyInfo.networks
      .filter((n) => (n.withdrawEnabled ?? false) === true)
      .map((n) => [n.network.toUpperCase(), n])
  );
  const sellDeposit = new Map(
    sellInfo.networks
      .filter((n) => (n.depositEnabled ?? false) === true)
      .map((n) => [n.network.toUpperCase(), n])
  );

  for (const net of buyWithdraw.keys()) {
    if (sellDeposit.has(net)) {
      return { status: 'ok', network: net };
    }
  }

  return { status: 'blocked', reason: 'no common network with withdraw+deposit enabled' };
}
