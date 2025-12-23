import axios from 'axios';
import type { ExchangeConfig, ExchangeFees, Pair } from '../types/exchange.js';

const client = axios.create({ timeout: 8000 });

const USDT = 'USDT';
const normalizeSymbol = (base: string, quote: string): string => `${base}${quote}`.toUpperCase();
const feeOverrides = readFeeOverrides();

const binance: ExchangeConfig = {
  name: 'binance',
  fees: resolveFees('binance', { takerFeePercent: 0.1 }),
  async getPairs(): Promise<Pair[]> {
    const { data } = await client.get<{ symbols: BinanceSymbol[] }>(
      'https://api.binance.com/api/v3/exchangeInfo'
    );

    const symbols = Array.isArray((data as { symbols?: BinanceSymbol[] }).symbols)
      ? (data as { symbols?: BinanceSymbol[] }).symbols!
      : [];

    return symbols
      .filter((symbol) => symbol.status === 'TRADING' && symbol.quoteAsset === USDT)
      .map((symbol) => ({
        base: symbol.baseAsset,
        quote: symbol.quoteAsset,
        symbol: normalizeSymbol(symbol.baseAsset, symbol.quoteAsset)
      }));
  },
  async getPrices(pairs: string[]) {
    const { data } = await client.get<BinancePrice[]>('https://api.binance.com/api/v3/ticker/price');
    const prices = Array.isArray(data) ? data : [];

    return Object.fromEntries(
      prices
        .filter((price) => pairs.includes(price.symbol))
        .map((price) => [price.symbol, Number(price.price)])
    );
  }
};

const okx: ExchangeConfig = {
  name: 'okx',
  fees: resolveFees('okx', { takerFeePercent: 0.1 }),
  async getPairs(): Promise<Pair[]> {
    const { data } = await client.get<OkxInstrumentsResponse>(
      'https://www.okx.com/api/v5/public/instruments?instType=SPOT'
    );

    const instruments = Array.isArray((data as OkxInstrumentsResponse | undefined)?.data)
      ? (data as OkxInstrumentsResponse).data
      : [];

    return instruments
      .filter((instrument) => instrument.quoteCcy === USDT && instrument.state === 'live')
      .map((instrument) => ({
        base: instrument.baseCcy,
        quote: instrument.quoteCcy,
        symbol: normalizeSymbol(instrument.baseCcy, instrument.quoteCcy)
      }));
  },
  async getPrices(pairs: string[]) {
    const { data } = await client.get<OkxTickersResponse>(
      'https://www.okx.com/api/v5/market/tickers?instType=SPOT'
    );

    const tickers = Array.isArray((data as OkxTickersResponse | undefined)?.data)
      ? (data as OkxTickersResponse).data
      : [];

    return Object.fromEntries(
      tickers
        .map((ticker) => [ticker.instId.replace('-', ''), Number(ticker.last)] as const)
        .filter(([symbol]) => pairs.includes(symbol))
    );
  }
};

const bybit: ExchangeConfig = {
  name: 'bybit',
  fees: resolveFees('bybit', { takerFeePercent: 0.1 }),
  async getPairs(): Promise<Pair[]> {
    const { data } = await client.get<BybitInstrumentsResponse>(
      'https://api.bybit.com/v5/market/instruments-info?category=spot'
    );

    const list = Array.isArray((data as BybitInstrumentsResponse | undefined)?.result?.list)
      ? (data as BybitInstrumentsResponse).result.list
      : [];

    return list
      .filter((instrument) => instrument.quoteCoin === USDT)
      .map((instrument) => ({
        base: instrument.baseCoin,
        quote: instrument.quoteCoin,
        symbol: normalizeSymbol(instrument.baseCoin, instrument.quoteCoin)
      }));
  },
  async getPrices(pairs: string[]) {
    const { data } = await client.get<BybitTickersResponse>(
      'https://api.bybit.com/v5/market/tickers?category=spot'
    );

    const tickers = Array.isArray((data as BybitTickersResponse | undefined)?.result?.list)
      ? (data as BybitTickersResponse).result.list
      : [];

    return Object.fromEntries(
      tickers
        .map((ticker) => [ticker.symbol, Number(ticker.lastPrice)] as const)
        .filter(([symbol]) => pairs.includes(symbol))
    );
  }
};

const qmall: ExchangeConfig = {
  name: 'qmall',
  fees: resolveFees('qmall', { takerFeePercent: 0.1 }),
  async getPairs(): Promise<Pair[]> {
    const { data } = await client.get<QmallSymbolsResponse>(
      'https://qmall.io/api/v1/public/symbols'
    );

    const symbols = Array.isArray((data as QmallSymbolsResponse | undefined)?.symbols)
      ? (data as QmallSymbolsResponse).symbols
      : [];

    return symbols
      .filter((symbol) => symbol.quote.toUpperCase() === USDT)
      .map((symbol) => ({
        base: symbol.base.toUpperCase(),
        quote: symbol.quote.toUpperCase(),
        symbol: normalizeSymbol(symbol.base, symbol.quote)
      }));
  },
  async getPrices(pairs: string[]) {
    const { data } = await client.get<QmallTickersResponse>('https://qmall.io/api/v1/public/tickers');
    const tickers = data ?? {};

    return Object.fromEntries(
      Object.values(tickers)
        .map((ticker) => [ticker.market.replace('_', '').toUpperCase(), Number(ticker.last)] as const)
        .filter(([symbol]) => pairs.includes(symbol))
    );
  }
};

export const exchanges: ExchangeConfig[] = [binance, okx, bybit, qmall];

function resolveFees(name: string, defaults: ExchangeFees): ExchangeFees {
  const override = feeOverrides?.[name];
  return {
    takerFeePercent: override?.takerFeePercent ?? defaults.takerFeePercent,
    transferFeePercent: override?.transferFeePercent ?? defaults.transferFeePercent ?? 0
  };
}

function readFeeOverrides(): Record<string, ExchangeFees> | null {
  const raw = process.env.EXCHANGE_FEES_JSON ?? process.env.EXCHANGE_FEES;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, Partial<ExchangeFees>>;
    const normalized: Record<string, ExchangeFees> = {};

    for (const [key, value] of Object.entries(parsed)) {
      const taker = Number(value.takerFeePercent ?? NaN);
      const transferRaw = value.transferFeePercent;
      const transfer = transferRaw === undefined ? undefined : Number(transferRaw);
      normalized[key.toLowerCase()] = {
        takerFeePercent: Number.isNaN(taker) ? 0 : taker,
        transferFeePercent: transfer === undefined || Number.isNaN(transfer) ? 0 : transfer
      };
    }

    return normalized;
  } catch (error) {
    console.warn('Failed to parse EXCHANGE_FEES_JSON; falling back to defaults', error);
    return null;
  }
}

interface BinanceSymbol {
  status: string;
  quoteAsset: string;
  baseAsset: string;
}

interface BinancePrice {
  symbol: string;
  price: string;
}

interface OkxInstrument {
  baseCcy: string;
  quoteCcy: string;
  state: string;
}

interface OkxTicker {
  instId: string;
  last: string;
}

interface OkxInstrumentsResponse {
  data: OkxInstrument[];
}

interface OkxTickersResponse {
  data: OkxTicker[];
}

interface BybitInstrument {
  baseCoin: string;
  quoteCoin: string;
}

interface BybitTicker {
  symbol: string;
  lastPrice: string;
}

interface BybitInstrumentsResponse {
  result: {
    list: BybitInstrument[];
  };
}

interface BybitTickersResponse {
  result: {
    list: BybitTicker[];
  };
}

interface QmallSymbol {
  base: string;
  quote: string;
}

interface QmallTicker {
  market: string;
  last: string;
}

interface QmallSymbolsResponse {
  symbols: QmallSymbol[];
}

type QmallTickersResponse = Record<string, QmallTicker>;
