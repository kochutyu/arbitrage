import { exchanges } from './exchangeConfigs.js';
import type {
  ArbitrageOpportunity,
  ExchangeConfig,
  ExchangeFees,
  OpportunityLeg,
  PricesBySymbol
} from '../types/exchange.js';

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
  return findArbitrage(prices, threshold);
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
