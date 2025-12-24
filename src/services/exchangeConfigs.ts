import axios from 'axios';
import type { ExchangeConfig, ExchangeFees, Pair } from '../types/exchange.js';

const client = axios.create({ timeout: 8000 });

const USDT = 'USDT';
const normalizeSymbol = (base: string, quote: string): string => `${base}${quote}`.toUpperCase();
const feeOverrides = readFeeOverrides();

let krakenPairLookup: Record<string, string> = {};
let bitfinexSymbolLookup: Record<string, string> = {};
let upbitMarketLookup: Record<string, string> = {};

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
  },
  async getTickers24h(pairs: string[]) {
    const { data } = await client.get<Binance24hTicker[]>('https://api.binance.com/api/v3/ticker/24hr');
    const tickers = Array.isArray(data) ? data : [];
    return Object.fromEntries(
      tickers
        .filter((t) => pairs.includes(t.symbol))
        .map((t) => [
          t.symbol,
          {
            last: Number(t.lastPrice),
            quoteVolume24h: Number(t.quoteVolume)
          }
        ])
    );
  },
  async getOrderBook(symbol: string) {
    const { data } = await client.get<BinanceDepthResponse>(
      `https://api.binance.com/api/v3/depth?symbol=${encodeURIComponent(symbol)}&limit=500`
    );
    const bidsRaw = Array.isArray((data as BinanceDepthResponse | undefined)?.bids)
      ? ((data as BinanceDepthResponse).bids ?? [])
      : [];
    const asksRaw = Array.isArray((data as BinanceDepthResponse | undefined)?.asks)
      ? ((data as BinanceDepthResponse).asks ?? [])
      : [];
    const bids = bidsRaw
      .map(([p, q]) => [Number(p), Number(q)] as const)
      .filter(([p, q]) => Number.isFinite(p) && Number.isFinite(q) && p > 0 && q > 0)
      .sort((a, b) => b[0] - a[0]);
    const asks = asksRaw
      .map(([p, q]) => [Number(p), Number(q)] as const)
      .filter(([p, q]) => Number.isFinite(p) && Number.isFinite(q) && p > 0 && q > 0)
      .sort((a, b) => a[0] - b[0]);
    return { bids, asks };
  }
};

const binanceUs: ExchangeConfig = {
  name: 'binanceus',
  fees: resolveFees('binanceus', { takerFeePercent: 0.1 }),
  async getPairs(): Promise<Pair[]> {
    try {
      const { data } = await client.get<{ symbols: BinanceSymbol[] }>(
        'https://api.binance.us/api/v3/exchangeInfo'
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
    } catch (error) {
      console.warn('binanceus getPairs failed:', toErrorMessage(error));
      return [];
    }
  },
  async getPrices(pairs: string[]) {
    try {
      const { data } = await client.get<BinancePrice[]>('https://api.binance.us/api/v3/ticker/price');
      const prices = Array.isArray(data) ? data : [];

      return Object.fromEntries(
        prices
          .filter((price) => pairs.includes(price.symbol))
          .map((price) => [price.symbol, Number(price.price)])
      );
    } catch (error) {
      console.warn('binanceus getPrices failed:', toErrorMessage(error));
      return {};
    }
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
  },
  async getTickers24h(pairs: string[]) {
    const { data } = await client.get<OkxTickersResponse>(
      'https://www.okx.com/api/v5/market/tickers?instType=SPOT'
    );
    const tickers = Array.isArray((data as OkxTickersResponse | undefined)?.data)
      ? (data as OkxTickersResponse).data
      : [];
    const entries: [string, { last?: number; quoteVolume24h?: number }][] = [];
    for (const t of tickers) {
      const symbol = t.instId.replace('-', '');
      if (!pairs.includes(symbol)) continue;
      const last = Number(t.last);
      const vol = Number((t as OkxTickerExtended).volCcy24h);
      const out: { last?: number; quoteVolume24h?: number } = {};
      if (Number.isFinite(last)) out.last = last;
      if (Number.isFinite(vol)) out.quoteVolume24h = vol;
      if (out.last !== undefined || out.quoteVolume24h !== undefined) {
        entries.push([symbol, out]);
      }
    }
    return Object.fromEntries(entries);
  },
  async getOrderBook(symbol: string) {
    const instId = okxInstId(symbol);
    const { data } = await client.get<OkxBooksResponse>(
      `https://www.okx.com/api/v5/market/books?instId=${encodeURIComponent(instId)}&sz=200`
    );
    const first = Array.isArray((data as OkxBooksResponse | undefined)?.data)
      ? (data as OkxBooksResponse).data?.[0]
      : undefined;
    const bidsRaw = Array.isArray(first?.bids) ? first!.bids! : [];
    const asksRaw = Array.isArray(first?.asks) ? first!.asks! : [];
    const bids = bidsRaw
      .map((lvl) => [Number(lvl[0]), Number(lvl[1])] as const)
      .filter(([p, q]) => Number.isFinite(p) && Number.isFinite(q) && p > 0 && q > 0)
      .sort((a, b) => b[0] - a[0]);
    const asks = asksRaw
      .map((lvl) => [Number(lvl[0]), Number(lvl[1])] as const)
      .filter(([p, q]) => Number.isFinite(p) && Number.isFinite(q) && p > 0 && q > 0)
      .sort((a, b) => a[0] - b[0]);
    return { bids, asks };
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
  },
  async getTickers24h(pairs: string[]) {
    const { data } = await client.get<BybitTickersResponse>(
      'https://api.bybit.com/v5/market/tickers?category=spot'
    );
    const tickers = Array.isArray((data as BybitTickersResponse | undefined)?.result?.list)
      ? (data as BybitTickersResponse).result.list
      : [];
    const entries: [string, { last?: number; quoteVolume24h?: number }][] = [];
    for (const t of tickers) {
      if (!pairs.includes(t.symbol)) continue;
      const last = Number(t.lastPrice);
      const vol = Number((t as BybitTickerExtended).turnover24h);
      const out: { last?: number; quoteVolume24h?: number } = {};
      if (Number.isFinite(last)) out.last = last;
      if (Number.isFinite(vol)) out.quoteVolume24h = vol;
      if (out.last !== undefined || out.quoteVolume24h !== undefined) {
        entries.push([t.symbol, out]);
      }
    }
    return Object.fromEntries(entries);
  },
  async getOrderBook(symbol: string) {
    const { data } = await client.get<BybitOrderBookResponse>(
      `https://api.bybit.com/v5/market/orderbook?category=spot&symbol=${encodeURIComponent(symbol)}&limit=200`
    );
    const result = (data as BybitOrderBookResponse | undefined)?.result;
    const bidsRaw = Array.isArray(result?.b) ? result!.b! : [];
    const asksRaw = Array.isArray(result?.a) ? result!.a! : [];
    const bids = bidsRaw
      .map((lvl) => [Number(lvl[0]), Number(lvl[1])] as const)
      .filter(([p, q]) => Number.isFinite(p) && Number.isFinite(q) && p > 0 && q > 0)
      .sort((a, b) => b[0] - a[0]);
    const asks = asksRaw
      .map((lvl) => [Number(lvl[0]), Number(lvl[1])] as const)
      .filter(([p, q]) => Number.isFinite(p) && Number.isFinite(q) && p > 0 && q > 0)
      .sort((a, b) => a[0] - b[0]);
    return { bids, asks };
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

const coinbase = buildCoinbaseExchange('coinbase');
const coinbasePro = buildCoinbaseExchange('coinbasepro');

const kraken: ExchangeConfig = {
  name: 'kraken',
  fees: resolveFees('kraken', { takerFeePercent: 0.1 }),
  async getPairs(): Promise<Pair[]> {
    return loadKrakenPairs();
  },
  async getPrices(pairs: string[]) {
    if (Object.keys(krakenPairLookup).length === 0) {
      await loadKrakenPairs();
    }

    const pairIds = pairs.map((symbol) => krakenPairLookup[symbol]).filter(Boolean);
    if (pairIds.length === 0) return {};

    const { data } = await client.get<KrakenTickerResponse>(
      `https://api.kraken.com/0/public/Ticker?pair=${pairIds.join(',')}`
    );

    const result = (data as KrakenTickerResponse | undefined)?.result ?? {};
    const symbolById = new Map<string, string>(
      Object.entries(krakenPairLookup).map(([symbol, id]) => [id, symbol])
    );

    return Object.fromEntries(
      Object.entries(result)
        .map(([id, ticker]) => {
          const price = Number((ticker as KrakenTicker).c?.[0]);
          const symbol = symbolById.get(id);
          return symbol && Number.isFinite(price) ? ([symbol, price] as const) : null;
        })
        .filter((entry): entry is [string, number] => Boolean(entry))
    );
  }
};

const gemini: ExchangeConfig = {
  name: 'gemini',
  fees: resolveFees('gemini', { takerFeePercent: 0.1 }),
  async getPairs(): Promise<Pair[]> {
    try {
      const { data } = await client.get<string[]>('https://api.gemini.com/v1/symbols');
      const symbols = Array.isArray(data) ? data : [];

      return symbols
        .filter((symbol) => symbol.toUpperCase().endsWith(USDT))
        .map((symbol) => {
          const base = symbol.slice(0, -USDT.length).toUpperCase();
          return { base, quote: USDT, symbol: normalizeSymbol(base, USDT) };
        });
    } catch (error) {
      console.warn('gemini getPairs failed:', toErrorMessage(error));
      return [];
    }
  },
  async getPrices(pairs: string[]) {
    try {
      const entries = await Promise.all(
        pairs.map(async (symbol) => {
          const geminiSymbol = symbol.toLowerCase();
          const { data } = await client.get<GeminiTicker>(
            `https://api.gemini.com/v1/pubticker/${geminiSymbol}`
          );
          const price = Number((data as GeminiTicker | undefined)?.last);
          return Number.isFinite(price) ? ([symbol, price] as const) : null;
        })
      );

      return Object.fromEntries(entries.filter(Boolean) as [string, number][]);
    } catch (error) {
      console.warn('gemini getPrices failed:', toErrorMessage(error));
      return {};
    }
  }
};

const kucoin: ExchangeConfig = {
  name: 'kucoin',
  fees: resolveFees('kucoin', { takerFeePercent: 0.1 }),
  async getPairs(): Promise<Pair[]> {
    const { data } = await client.get<KucoinSymbolsResponse>('https://api.kucoin.com/api/v1/symbols');
    const symbols = Array.isArray((data as KucoinSymbolsResponse | undefined)?.data)
      ? (data as KucoinSymbolsResponse).data
      : [];

    return symbols
      .filter((symbol) => symbol.quoteCurrency === USDT && symbol.enableTrading)
      .map((symbol) => ({
        base: symbol.baseCurrency.toUpperCase(),
        quote: symbol.quoteCurrency.toUpperCase(),
        symbol: normalizeSymbol(symbol.baseCurrency, symbol.quoteCurrency)
      }));
  },
  async getPrices(pairs: string[]) {
    const { data } = await client.get<KucoinTickersResponse>(
      'https://api.kucoin.com/api/v1/market/allTickers'
    );

    const tickers = Array.isArray((data as KucoinTickersResponse | undefined)?.data?.ticker)
      ? (data as KucoinTickersResponse).data!.ticker
      : [];

    return Object.fromEntries(
      tickers
        .map((ticker) => {
          const symbol = normalizeSymbolFromKucoin(ticker.symbol);
          const price = Number(ticker.last);
          return symbol && pairs.includes(symbol) && Number.isFinite(price)
            ? ([symbol, price] as const)
            : null;
        })
        .filter((entry): entry is [string, number] => Boolean(entry))
    );
  },
  async getTickers24h(pairs: string[]) {
    const { data } = await client.get<KucoinTickersResponse>(
      'https://api.kucoin.com/api/v1/market/allTickers'
    );
    const tickers = Array.isArray((data as KucoinTickersResponse | undefined)?.data?.ticker)
      ? (data as KucoinTickersResponse).data!.ticker
      : [];
    const entries: [string, { last?: number; quoteVolume24h?: number }][] = [];
    for (const t of tickers) {
      const symbol = normalizeSymbolFromKucoin(t.symbol);
      if (!symbol || !pairs.includes(symbol)) continue;
      const last = Number(t.last);
      const vol = Number((t as KucoinTickerEntryExtended).volValue);
      const out: { last?: number; quoteVolume24h?: number } = {};
      if (Number.isFinite(last)) out.last = last;
      if (Number.isFinite(vol)) out.quoteVolume24h = vol;
      if (out.last !== undefined || out.quoteVolume24h !== undefined) {
        entries.push([symbol, out]);
      }
    }
    return Object.fromEntries(entries);
  },
  async getOrderBook(symbol: string) {
    const kucoinSymbol = kucoinSymbolFromNormalized(symbol);
    if (!kucoinSymbol) return null;
    const { data } = await client.get<KucoinOrderBookResponse>(
      `https://api.kucoin.com/api/v1/market/orderbook/level2_100?symbol=${encodeURIComponent(kucoinSymbol)}`
    );
    const book = (data as KucoinOrderBookResponse | undefined)?.data;
    const bidsRaw = Array.isArray(book?.bids) ? book!.bids! : [];
    const asksRaw = Array.isArray(book?.asks) ? book!.asks! : [];
    const bids = bidsRaw
      .map((lvl) => [Number(lvl[0]), Number(lvl[1])] as const)
      .filter(([p, q]) => Number.isFinite(p) && Number.isFinite(q) && p > 0 && q > 0)
      .sort((a, b) => b[0] - a[0]);
    const asks = asksRaw
      .map((lvl) => [Number(lvl[0]), Number(lvl[1])] as const)
      .filter(([p, q]) => Number.isFinite(p) && Number.isFinite(q) && p > 0 && q > 0)
      .sort((a, b) => a[0] - b[0]);
    return { bids, asks };
  },
  async getCurrencies() {
    // NOTE: KuCoin provides a public currencies endpoint with chain status.
    // If this endpoint becomes authenticated, return null and let validation conservatively skip.
    try {
      // v3 includes chain/network data; v1 lacks `chains`.
      const { data } = await client.get<KucoinCurrenciesResponse>('https://api.kucoin.com/api/v3/currencies');
      const list: KucoinCurrency[] = Array.isArray((data as KucoinCurrenciesResponse | undefined)?.data)
        ? ((data as KucoinCurrenciesResponse).data ?? [])
        : [];
      const result: Record<
        string,
        { code: string; networks?: { network: string; depositEnabled?: boolean; withdrawEnabled?: boolean }[] }
      > = {};
      for (const c of list) {
        const code = (c.currency ?? '').toUpperCase();
        if (!code) continue;
        const networks = Array.isArray(c.chains)
          ? (c.chains
              .map((ch) => {
                const network = (ch.chainName ?? ch.chain ?? '').toUpperCase();
                if (!network) return null;
                return {
                  network,
                  depositEnabled: Boolean(ch.isDepositEnabled),
                  withdrawEnabled: Boolean(ch.isWithdrawEnabled)
                };
              })
              .filter(Boolean) as { network: string; depositEnabled?: boolean; withdrawEnabled?: boolean }[])
          : null;
        const entry: {
          code: string;
          networks?: { network: string; depositEnabled?: boolean; withdrawEnabled?: boolean }[];
        } = { code };
        if (networks && networks.length > 0) entry.networks = networks;
        result[code] = entry;
      }
      return result;
    } catch (error) {
      console.warn('kucoin getCurrencies unavailable:', toErrorMessage(error));
      return null;
    }
  }
};

const bitget: ExchangeConfig = {
  name: 'bitget',
  fees: resolveFees('bitget', { takerFeePercent: 0.1 }),
  async getPairs(): Promise<Pair[]> {
    const { data } = await client.get<BitgetSymbolsResponse>(
      'https://api.bitget.com/api/v2/spot/public/symbols'
    );

    const symbols = Array.isArray((data as BitgetSymbolsResponse | undefined)?.data)
      ? (data as BitgetSymbolsResponse).data
      : [];

    return symbols
      .filter((symbol) => symbol.quoteCoin === USDT && symbol.status === 'online')
      .map((symbol) => ({
        base: symbol.baseCoin.toUpperCase(),
        quote: symbol.quoteCoin.toUpperCase(),
        symbol: normalizeSymbol(symbol.baseCoin, symbol.quoteCoin)
      }));
  },
  async getPrices(pairs: string[]) {
    const { data } = await client.get<BitgetTickersResponse>(
      'https://api.bitget.com/api/v2/spot/market/tickers'
    );

    const tickers = Array.isArray((data as BitgetTickersResponse | undefined)?.data)
      ? (data as BitgetTickersResponse).data
      : [];

    return Object.fromEntries(
      tickers
        .map((ticker) => {
          const symbol = ticker.symbol?.toUpperCase();
          const price = Number(ticker.lastPr);
          return symbol && pairs.includes(symbol) && Number.isFinite(price)
            ? ([symbol, price] as const)
            : null;
        })
        .filter((entry): entry is [string, number] => Boolean(entry))
    );
  }
};

const mexc: ExchangeConfig = {
  name: 'mexc',
  fees: resolveFees('mexc', { takerFeePercent: 0.1 }),
  async getPairs(): Promise<Pair[]> {
    const { data } = await client.get<MexcExchangeInfo>('https://api.mexc.com/api/v3/exchangeInfo');
    const symbols = Array.isArray((data as MexcExchangeInfo | undefined)?.symbols)
      ? (data as MexcExchangeInfo).symbols!
      : [];

    return symbols
      .filter((symbol) => symbol.status === 'ENABLED' && symbol.quoteAsset === USDT)
      .map((symbol) => ({
        base: symbol.baseAsset,
        quote: symbol.quoteAsset,
        symbol: normalizeSymbol(symbol.baseAsset, symbol.quoteAsset)
      }));
  },
  async getPrices(pairs: string[]) {
    const { data } = await client.get<MexcTicker[]>('https://api.mexc.com/api/v3/ticker/price');
    const tickers = Array.isArray(data) ? data : [];

    return Object.fromEntries(
      tickers
        .map((ticker) => [ticker.symbol, Number(ticker.price)] as const)
        .filter(([symbol, price]) => pairs.includes(symbol) && Number.isFinite(price))
    );
  }
};

const bingx: ExchangeConfig = {
  name: 'bingx',
  fees: resolveFees('bingx', { takerFeePercent: 0.1 }),
  async getPairs(): Promise<Pair[]> {
    const { data } = await client.get<BingxSymbolsResponse>(
      'https://open-api.bingx.com/openApi/spot/v1/common/symbols'
    );

    const symbols = Array.isArray((data as BingxSymbolsResponse | undefined)?.data?.symbols)
      ? (data as BingxSymbolsResponse).data!.symbols!
      : [];

    return symbols
      .filter((symbol) => symbol.symbol?.toUpperCase().endsWith('-USDT'))
      .filter((symbol) => symbol.apiStateBuy && symbol.apiStateSell)
      .map((symbol) => {
        const [base, quote] = (symbol.symbol ?? '').split('-');
        if (!base || !quote) return null;
        const baseUpper = base.toUpperCase();
        const quoteUpper = quote.toUpperCase();
        return { base: baseUpper, quote: quoteUpper, symbol: normalizeSymbol(baseUpper, quoteUpper) };
      })
      .filter((entry): entry is Pair => Boolean(entry));
  },
  async getPrices(pairs: string[]) {
    const { data } = await client.get<BingxTickerResponse>(
      'https://open-api.bingx.com/openApi/spot/v1/ticker/price'
    );

    const tickers: BingxTickerEntry[] = Array.isArray((data as BingxTickerResponse | undefined)?.data)
      ? (data as BingxTickerResponse).data!
      : [];

    return Object.fromEntries(
      tickers
        .map((ticker) => {
          const rawSymbol = ticker.symbol ?? '';
          const symbol = rawSymbol.replace('_', '').toUpperCase();
          const price = Number(ticker.trades?.[0]?.price);
          return pairs.includes(symbol) && Number.isFinite(price) ? ([symbol, price] as const) : null;
        })
        .filter((entry): entry is [string, number] => Boolean(entry))
    );
  }
};

const bitfinex: ExchangeConfig = {
  name: 'bitfinex',
  fees: resolveFees('bitfinex', { takerFeePercent: 0.1 }),
  async getPairs(): Promise<Pair[]> {
    return loadBitfinexPairs();
  },
  async getPrices(pairs: string[]) {
    if (Object.keys(bitfinexSymbolLookup).length === 0) {
      await loadBitfinexPairs();
    }

    const requested = pairs.map((symbol) => bitfinexSymbolLookup[symbol]).filter(Boolean);
    if (requested.length === 0) return {};

    const { data } = await client.get<BitfinexTickerResponse>(
      `https://api-pub.bitfinex.com/v2/tickers?symbols=${requested.join(',')}`
    );

    const tickers = Array.isArray(data) ? data : [];
    const symbolByCode = new Map<string, string>(
      Object.entries(bitfinexSymbolLookup).map(([symbol, code]) => [code, symbol])
    );

    return Object.fromEntries(
      tickers
        .map((entry) => {
          const arr = Array.isArray(entry) ? entry : [];
          const code = (arr[0] as string | undefined) ?? '';
          const price = Number(arr[7]);
          const symbol = symbolByCode.get(code);
          return symbol && Number.isFinite(price) ? ([symbol, price] as const) : null;
        })
        .filter((entry): entry is [string, number] => Boolean(entry))
    );
  }
};

const bitstamp: ExchangeConfig = {
  name: 'bitstamp',
  fees: resolveFees('bitstamp', { takerFeePercent: 0.1 }),
  async getPairs(): Promise<Pair[]> {
    const { data } = await client.get<BitstampPair[]>(
      'https://www.bitstamp.net/api/v2/trading-pairs-info/'
    );

    const pairs = Array.isArray(data) ? data : [];

    return pairs
      .filter((pair) => (pair.trading ?? '').toLowerCase() === 'enabled')
      .filter((pair) => (pair.name ?? '').toUpperCase().includes('/USDT'))
      .map((pair) => {
        const [baseRaw, quoteRaw] = (pair.name ?? '').split('/');
        const base = (baseRaw ?? '').toUpperCase();
        const quote = (quoteRaw ?? '').toUpperCase();
        return { base, quote, symbol: normalizeSymbol(base, quote) };
      });
  },
  async getPrices(pairs: string[]) {
    const entries = await Promise.all(
      pairs.map(async (symbol) => {
        const urlSymbol = symbol.toLowerCase();
        const { data } = await client.get<BitstampTicker>(
          `https://www.bitstamp.net/api/v2/ticker/${urlSymbol}`
        );
        const price = Number((data as BitstampTicker | undefined)?.last);
        return Number.isFinite(price) ? ([symbol, price] as const) : null;
      })
    );

    return Object.fromEntries(entries.filter(Boolean) as [string, number][]);
  }
};

const huobi: ExchangeConfig = {
  name: 'huobi',
  fees: resolveFees('huobi', { takerFeePercent: 0.1 }),
  async getPairs(): Promise<Pair[]> {
    const { data } = await client.get<HuobiSymbolsResponse>('https://api.huobi.pro/v1/common/symbols');
    const symbols: HuobiSymbol[] = Array.isArray((data as HuobiSymbolsResponse | undefined)?.data)
      ? (data as HuobiSymbolsResponse).data!
      : [];

    return symbols
      .filter(
        (symbol) =>
          (symbol['quote-currency'] ?? '').toUpperCase() === USDT && (symbol.state ?? '').toLowerCase() === 'online'
      )
      .map((symbol) => {
        const base = (symbol['base-currency'] ?? '').toUpperCase();
        const quote = (symbol['quote-currency'] ?? '').toUpperCase();
        return { base, quote, symbol: normalizeSymbol(base, quote) };
      });
  },
  async getPrices(pairs: string[]) {
    const { data } = await client.get<HuobiTickersResponse>('https://api.huobi.pro/market/tickers');
    const tickers: HuobiTicker[] = Array.isArray((data as HuobiTickersResponse | undefined)?.data)
      ? (data as HuobiTickersResponse).data!
      : [];

    return Object.fromEntries(
      tickers
        .map((ticker) => {
          const symbol = (ticker.symbol ?? '').toUpperCase();
          const price = Number(ticker.close);
          return symbol.endsWith(USDT) && pairs.includes(symbol) && Number.isFinite(price)
            ? ([symbol, price] as const)
            : null;
        })
        .filter((entry): entry is [string, number] => Boolean(entry))
    );
  },
  async getTickers24h(pairs: string[]) {
    const { data } = await client.get<HuobiTickersResponse>('https://api.huobi.pro/market/tickers');
    const tickers: HuobiTickerExtended[] = Array.isArray((data as HuobiTickersResponse | undefined)?.data)
      ? ((data as HuobiTickersResponse).data as HuobiTickerExtended[])
      : [];
    const entries: [string, { last?: number; quoteVolume24h?: number }][] = [];
    for (const t of tickers) {
      const symbol = (t.symbol ?? '').toUpperCase();
      if (!pairs.includes(symbol)) continue;
      const last = Number(t.close);
      const vol = Number((t as HuobiTickerExtended).vol);
      const out: { last?: number; quoteVolume24h?: number } = {};
      if (Number.isFinite(last)) out.last = last;
      if (Number.isFinite(vol)) out.quoteVolume24h = vol;
      if (out.last !== undefined || out.quoteVolume24h !== undefined) {
        entries.push([symbol, out]);
      }
    }
    return Object.fromEntries(entries);
  },
  async getOrderBook(symbol: string) {
    const huobiSymbol = symbol.toLowerCase();
    const { data } = await client.get<HuobiDepthResponse>(
      `https://api.huobi.pro/market/depth?symbol=${encodeURIComponent(huobiSymbol)}&type=step0`
    );
    const tick = (data as HuobiDepthResponse | undefined)?.tick;
    const bidsRaw = Array.isArray(tick?.bids) ? tick!.bids! : [];
    const asksRaw = Array.isArray(tick?.asks) ? tick!.asks! : [];
    const bids = bidsRaw
      .map((lvl) => [Number(lvl[0]), Number(lvl[1])] as const)
      .filter(([p, q]) => Number.isFinite(p) && Number.isFinite(q) && p > 0 && q > 0)
      .sort((a, b) => b[0] - a[0]);
    const asks = asksRaw
      .map((lvl) => [Number(lvl[0]), Number(lvl[1])] as const)
      .filter(([p, q]) => Number.isFinite(p) && Number.isFinite(q) && p > 0 && q > 0)
      .sort((a, b) => a[0] - b[0]);
    return { bids, asks };
  },
  async getCurrencies() {
    // NOTE: Relies on a public reference endpoint. If it becomes restricted, return null.
    try {
      const { data } = await client.get<HuobiCurrenciesResponse>('https://api.huobi.pro/v2/reference/currencies');
      const list: HuobiCurrency[] = Array.isArray((data as HuobiCurrenciesResponse | undefined)?.data)
        ? ((data as HuobiCurrenciesResponse).data ?? [])
        : [];
      const result: Record<
        string,
        { code: string; networks?: { network: string; depositEnabled?: boolean; withdrawEnabled?: boolean }[] }
      > = {};
      for (const c of list) {
        const code = (c.currency ?? '').toUpperCase();
        if (!code) continue;
        const chains = Array.isArray(c.chains) ? c.chains : [];
        const networks = chains
          .map((ch) => {
            const network = (ch.displayName ?? ch.chain ?? '').toUpperCase();
            if (!network) return null;
            const depositEnabled = String(ch.depositStatus ?? '').toLowerCase() === 'allowed';
            const withdrawEnabled = String(ch.withdrawStatus ?? '').toLowerCase() === 'allowed';
            return { network, depositEnabled, withdrawEnabled };
          })
          .filter(Boolean) as { network: string; depositEnabled?: boolean; withdrawEnabled?: boolean }[];
        const entry: {
          code: string;
          networks?: { network: string; depositEnabled?: boolean; withdrawEnabled?: boolean }[];
        } = { code };
        if (networks.length > 0) entry.networks = networks;
        result[code] = entry;
      }
      return result;
    } catch (error) {
      console.warn('huobi getCurrencies unavailable:', toErrorMessage(error));
      return null;
    }
  }
};

const upbit: ExchangeConfig = {
  name: 'upbit',
  fees: resolveFees('upbit', { takerFeePercent: 0.1 }),
  async getPairs(): Promise<Pair[]> {
    return loadUpbitPairs();
  },
  async getPrices(pairs: string[]) {
    if (Object.keys(upbitMarketLookup).length === 0) {
      await loadUpbitPairs();
    }

    const markets = pairs.map((symbol) => upbitMarketLookup[symbol]).filter(Boolean);
    if (markets.length === 0) return {};

    const { data } = await client.get<UpbitTicker[]>(
      `https://api.upbit.com/v1/ticker?markets=${markets.join(',')}`
    );

    const tickers = Array.isArray(data) ? data : [];
    const symbolByMarket = new Map<string, string>(
      Object.entries(upbitMarketLookup).map(([symbol, market]) => [market, symbol])
    );

    return Object.fromEntries(
      tickers
        .map((ticker) => {
          const symbol = symbolByMarket.get(ticker.market ?? '');
          const price = Number(ticker.trade_price);
          return symbol && Number.isFinite(price) ? ([symbol, price] as const) : null;
        })
        .filter((entry): entry is [string, number] => Boolean(entry))
    );
  },
  async getTickers24h(pairs: string[]) {
    if (Object.keys(upbitMarketLookup).length === 0) {
      await loadUpbitPairs();
    }
    const markets = pairs.map((symbol) => upbitMarketLookup[symbol]).filter(Boolean);
    if (markets.length === 0) return {};
    const { data } = await client.get<UpbitTickerExtended[]>(
      `https://api.upbit.com/v1/ticker?markets=${markets.join(',')}`
    );
    const tickers = Array.isArray(data) ? data : [];
    const symbolByMarket = new Map<string, string>(
      Object.entries(upbitMarketLookup).map(([symbol, market]) => [market, symbol])
    );
    const entries: [string, { last?: number; quoteVolume24h?: number }][] = [];
    for (const t of tickers) {
      const symbol = symbolByMarket.get(t.market ?? '');
      if (!symbol) continue;
      const last = Number(t.trade_price);
      const vol = Number((t as UpbitTickerExtended).acc_trade_price_24h);
      const out: { last?: number; quoteVolume24h?: number } = {};
      if (Number.isFinite(last)) out.last = last;
      if (Number.isFinite(vol)) out.quoteVolume24h = vol;
      if (out.last !== undefined || out.quoteVolume24h !== undefined) {
        entries.push([symbol, out]);
      }
    }
    return Object.fromEntries(entries);
  },
  async getOrderBook(symbol: string) {
    if (Object.keys(upbitMarketLookup).length === 0) {
      await loadUpbitPairs();
    }
    const market = upbitMarketLookup[symbol];
    if (!market) return null;
    const { data } = await client.get<UpbitOrderBookEntry[]>(
      `https://api.upbit.com/v1/orderbook?markets=${encodeURIComponent(market)}`
    );
    const first = Array.isArray(data) ? data[0] : undefined;
    const units = Array.isArray(first?.orderbook_units) ? first!.orderbook_units : [];
    const bids = units
      .map((u) => [Number(u.bid_price), Number(u.bid_size)] as const)
      .filter(([p, q]) => Number.isFinite(p) && Number.isFinite(q) && p > 0 && q > 0)
      .sort((a, b) => b[0] - a[0]);
    const asks = units
      .map((u) => [Number(u.ask_price), Number(u.ask_size)] as const)
      .filter(([p, q]) => Number.isFinite(p) && Number.isFinite(q) && p > 0 && q > 0)
      .sort((a, b) => a[0] - b[0]);
    return { bids, asks };
  }
};

const bithumb: ExchangeConfig = {
  name: 'bithumb',
  fees: resolveFees('bithumb', { takerFeePercent: 0.1 }),
  async getPairs(): Promise<Pair[]> {
    try {
      const data = await fetchBithumbData();
      if (!data) return [];

      return Object.entries(data)
        .filter(([key]) => key.toUpperCase() !== 'DATE')
        .filter(([, ticker]) => (ticker as BithumbTicker).closing_price !== undefined)
        .map(([base]) => ({
          base: base.toUpperCase(),
          quote: USDT,
          symbol: normalizeSymbol(base, USDT)
        }));
    } catch (error) {
      console.warn('bithumb getPairs failed:', toErrorMessage(error));
      return [];
    }
  },
  async getPrices(pairs: string[]) {
    try {
      const data = await fetchBithumbData();
      if (!data) return {};

      const entries: [string, number][] = [];
      for (const [base, ticker] of Object.entries(data)) {
        if (base.toUpperCase() === 'DATE') continue;
        const symbol = normalizeSymbol(base, USDT);
        if (!pairs.includes(symbol)) continue;
        const price = Number((ticker as BithumbTicker).closing_price);
        if (Number.isFinite(price)) {
          entries.push([symbol, price]);
        }
      }

      return Object.fromEntries(entries);
    } catch (error) {
      console.warn('bithumb getPrices failed:', toErrorMessage(error));
      return {};
    }
  }
};

const bitflyer: ExchangeConfig = {
  name: 'bitflyer',
  fees: resolveFees('bitflyer', { takerFeePercent: 0.1 }),
  async getPairs(): Promise<Pair[]> {
    try {
      const { data } = await client.get<BitflyerMarket[]>('https://api.bitflyer.com/v1/markets');
      const markets = Array.isArray(data) ? data : [];

      return markets
        .map((market) => market.product_code ?? '')
        .filter((code) => code.toUpperCase().endsWith('_USDT'))
        .map((code) => {
          const [baseRaw] = code.split('_');
          const base = (baseRaw ?? '').toUpperCase();
          return { base, quote: USDT, symbol: normalizeSymbol(base, USDT) };
        });
    } catch (error) {
      console.warn('bitflyer getPairs failed:', toErrorMessage(error));
      return [];
    }
  },
  async getPrices(pairs: string[]) {
    try {
      const entries = await Promise.all(
        pairs.map(async (symbol) => {
          const productCode = bitflyerProductCodeFromSymbol(symbol);
          const { data } = await client.get<BitflyerTicker>(
            `https://api.bitflyer.com/v1/ticker?product_code=${productCode}`
          );
          const price = Number((data as BitflyerTicker | undefined)?.ltp);
          return Number.isFinite(price) ? ([symbol, price] as const) : null;
        })
      );

      return Object.fromEntries(entries.filter(Boolean) as [string, number][]);
    } catch (error) {
      console.warn('bitflyer getPrices failed:', toErrorMessage(error));
      return {};
    }
  }
};

export const exchanges: ExchangeConfig[] = [
  binance,
  binanceUs,
  coinbase,
  coinbasePro,
  kraken,
  gemini,
  okx,
  bybit,
  bingx,
  kucoin,
  bitget,
  mexc,
  bitfinex,
  bitstamp,
  huobi,
  upbit,
  bithumb,
  bitflyer,
  qmall
];

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

function buildCoinbaseExchange(name: string): ExchangeConfig {
  return {
    name,
    fees: resolveFees(name, { takerFeePercent: 0.1 }),
    async getPairs(): Promise<Pair[]> {
      try {
        const { data } = await client.get<CoinbaseProduct[]>(
          'https://api.exchange.coinbase.com/products?limit=500'
        );

        const products = Array.isArray(data) ? data : [];

        return products
          .filter(
            (product) =>
              product.quote_currency === USDT && product.status === 'online' && !product.trading_disabled
          )
          .map((product) => {
            const base = product.base_currency.toUpperCase();
            const quote = product.quote_currency.toUpperCase();
            return { base, quote, symbol: normalizeSymbol(base, quote) };
          });
      } catch (error) {
        console.warn(`${name} getPairs failed:`, toErrorMessage(error));
        return [];
      }
    },
    async getPrices(pairs: string[]) {
      try {
        const entries = await Promise.all(
          pairs.map(async (symbol) => {
            try {
              const productId = coinbaseProductId(symbol);
              const { data } = await client.get<CoinbaseTicker>(
                `https://api.exchange.coinbase.com/products/${productId}/ticker`
              );
              const price = Number((data as CoinbaseTicker | undefined)?.price);
              return Number.isFinite(price) ? ([symbol, price] as const) : null;
            } catch (error) {
              console.warn(`${name} price failed for ${symbol}:`, toErrorMessage(error));
              return null;
            }
          })
        );

        return Object.fromEntries(entries.filter(Boolean) as [string, number][]);
      } catch (error) {
        console.warn(`${name} getPrices failed:`, toErrorMessage(error));
        return {};
      }
    }
  };
}

function coinbaseProductId(symbol: string): string {
  const base = symbol.slice(0, -USDT.length);
  return `${base}-${USDT}`;
}

async function loadKrakenPairs(): Promise<Pair[]> {
  const { data } = await client.get<KrakenPairsResponse>('https://api.kraken.com/0/public/AssetPairs');
  const pairs = (data as KrakenPairsResponse | undefined)?.result ?? {};

  krakenPairLookup = {};

  const list: Pair[] = [];

  for (const [pairId, info] of Object.entries(pairs)) {
    const wsname = info.wsname ?? '';
    const [rawBase, rawQuote] = wsname.split('/');
    if (!rawBase || rawQuote !== USDT || info.status !== 'online') continue;
    const base = normalizeKrakenAsset(rawBase);
    const symbol = normalizeSymbol(base, rawQuote);
    list.push({ base, quote: rawQuote, symbol });
    krakenPairLookup[symbol] = pairId;
  }

  return list;
}

function normalizeKrakenAsset(asset: string): string {
  const normalized = asset.toUpperCase();
  if (normalized === 'XBT') return 'BTC';
  if (normalized === 'XETH') return 'ETH';
  return normalized.replace(/^X/, '').replace(/^Z/, '');
}

function normalizeSymbolFromKucoin(id: string): string | null {
  const [base, quote] = id.split('-');
  if (!base || !quote) return null;
  return normalizeSymbol(base, quote);
}

function kucoinSymbolFromNormalized(symbol: string): string | null {
  if (!symbol.endsWith(USDT)) return null;
  const base = symbol.slice(0, -USDT.length);
  if (!base) return null;
  return `${base}-${USDT}`;
}

function okxInstId(symbol: string): string {
  if (!symbol.endsWith(USDT)) return symbol;
  const base = symbol.slice(0, -USDT.length);
  return `${base}-${USDT}`;
}

async function loadBitfinexPairs(): Promise<Pair[]> {
  const { data } = await client.get<BitfinexPairListResponse>(
    'https://api-pub.bitfinex.com/v2/conf/pub:list:pair:exchange'
  );

  const pairs = Array.isArray(data?.[0]) ? (data[0] as string[]) : [];
  bitfinexSymbolLookup = {};

  const result: Pair[] = [];

  for (const raw of pairs) {
    if (typeof raw !== 'string') continue;
    const parsed = parseBitfinexPair(raw);
    if (!parsed) continue;
    result.push({ base: parsed.base, quote: parsed.quote, symbol: parsed.symbol });
    bitfinexSymbolLookup[parsed.symbol] = parsed.tickerCode;
  }

  return result;
}

function parseBitfinexPair(raw: string): BitfinexParsedPair | null {
  const [baseRaw, quoteRaw] = raw.includes(':') ? raw.split(':', 2) : [raw.slice(0, -3), raw.slice(-3)];
  if (!baseRaw || !quoteRaw) return null;

  const quote = quoteRaw.toUpperCase();
  if (quote !== 'UST') return null;

  const base = baseRaw.toUpperCase();
  const symbol = normalizeSymbol(base, USDT);
  return { base, quote: USDT, symbol, tickerCode: `t${raw}` };
}

async function loadUpbitPairs(): Promise<Pair[]> {
  const { data } = await client.get<UpbitMarket[]>('https://api.upbit.com/v1/market/all?isDetails=false');
  const markets = Array.isArray(data) ? data : [];

  upbitMarketLookup = {};

  return markets
    .map((market) => market.market ?? '')
    .filter((market) => market.startsWith('USDT-'))
    .map((market) => {
      const base = market.replace('USDT-', '');
      const symbol = normalizeSymbol(base, USDT);
      upbitMarketLookup[symbol] = market;
      return { base, quote: USDT, symbol };
    });
}

async function fetchBithumbData(): Promise<Record<string, BithumbTicker> | null> {
  try {
    const { data } = await client.get<BithumbResponse>('https://api.bithumb.com/public/ticker/ALL_USDT');
    const status = (data as BithumbResponse | undefined)?.status;
    if (status !== '0000') return null;

    const payload = (data as BithumbResponse | undefined)?.data;
    if (!payload) return null;

    const entries: Record<string, BithumbTicker> = {};
    for (const [key, value] of Object.entries(payload)) {
      if (typeof value === 'string') continue;
      entries[key] = value as BithumbTicker;
    }

    return entries;
  } catch (error) {
    console.warn('bithumb fetch failed:', toErrorMessage(error));
    return null;
  }
}

function bitflyerProductCodeFromSymbol(symbol: string): string {
  const base = symbol.slice(0, -USDT.length);
  return `${base}_${USDT}`;
}

function toErrorMessage(error: unknown): string {
  const anyErr = error as { response?: { status?: number; statusText?: string } };
  const status = anyErr?.response?.status;
  const statusText = anyErr?.response?.statusText;
  if (status) return `HTTP ${status}${statusText ? ` ${statusText}` : ''}`;
  return error instanceof Error ? error.message : String(error);
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

interface Binance24hTicker {
  symbol: string;
  lastPrice: string;
  quoteVolume: string;
}

interface BinanceDepthResponse {
  bids?: [string, string][];
  asks?: [string, string][];
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

interface OkxTickerExtended extends OkxTicker {
  volCcy24h?: string;
}

interface OkxInstrumentsResponse {
  data: OkxInstrument[];
}

interface OkxTickersResponse {
  data: OkxTicker[];
}

interface OkxBookEntry {
  bids?: string[][];
  asks?: string[][];
}

interface OkxBooksResponse {
  data?: OkxBookEntry[];
}

interface BybitInstrument {
  baseCoin: string;
  quoteCoin: string;
}

interface BybitTicker {
  symbol: string;
  lastPrice: string;
}

interface BybitTickerExtended extends BybitTicker {
  turnover24h?: string;
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

interface BybitOrderBookResponse {
  result?: {
    b?: string[][];
    a?: string[][];
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

interface CoinbaseProduct {
  id: string;
  base_currency: string;
  quote_currency: string;
  status: string;
  trading_disabled: boolean;
}

interface CoinbaseTicker {
  price: string;
}

interface KrakenPairInfo {
  wsname?: string;
  status?: string;
}

interface KrakenPairsResponse {
  result?: Record<string, KrakenPairInfo>;
}

interface KrakenTicker {
  c?: [string, ...string[]];
}

interface KrakenTickerResponse {
  result?: Record<string, KrakenTicker>;
}

interface GeminiTicker {
  last: string;
}

interface KucoinSymbol {
  baseCurrency: string;
  quoteCurrency: string;
  enableTrading: boolean;
}

interface KucoinSymbolsResponse {
  data: KucoinSymbol[];
}

interface KucoinTickerEntry {
  symbol: string;
  last: string;
}

interface KucoinTickerEntryExtended extends KucoinTickerEntry {
  volValue?: string;
}

interface KucoinTickersResponse {
  data?: { ticker: KucoinTickerEntry[] };
}

interface KucoinOrderBookResponse {
  data?: {
    bids?: string[][];
    asks?: string[][];
  };
}

interface KucoinCurrencyChain {
  chainName?: string;
  chain?: string;
  isDepositEnabled?: boolean;
  isWithdrawEnabled?: boolean;
}

interface KucoinCurrency {
  currency?: string;
  chains?: KucoinCurrencyChain[];
}

interface KucoinCurrenciesResponse {
  data?: KucoinCurrency[];
}

interface BitgetSymbol {
  baseCoin: string;
  quoteCoin: string;
  status: string;
  symbol: string;
}

interface BitgetSymbolsResponse {
  data: BitgetSymbol[];
}

interface BitgetTicker {
  symbol?: string;
  lastPr?: string;
}

interface BitgetTickersResponse {
  data: BitgetTicker[];
}

interface MexcSymbol {
  baseAsset: string;
  quoteAsset: string;
  status: string;
}

interface MexcExchangeInfo {
  symbols?: MexcSymbol[];
}

interface MexcTicker {
  symbol: string;
  price: string;
}

interface BingxSymbol {
  symbol?: string;
  apiStateBuy?: boolean;
  apiStateSell?: boolean;
}

interface BingxSymbolsResponse {
  data?: {
    symbols?: BingxSymbol[];
  };
}

interface BingxTickerTrade {
  price?: string;
}

interface BingxTickerEntry {
  symbol?: string;
  trades?: BingxTickerTrade[];
}

interface BingxTickerResponse {
  data?: BingxTickerEntry[];
}

type BitfinexPairListResponse = (string[] | undefined)[];
type BitfinexTickerResponse = (readonly unknown[])[];

interface BitfinexParsedPair {
  base: string;
  quote: string;
  symbol: string;
  tickerCode: string;
}

interface BitstampPair {
  name?: string;
  trading?: string;
}

interface BitstampTicker {
  last?: string;
}

interface HuobiSymbol {
  'base-currency'?: string;
  'quote-currency'?: string;
  state?: string;
}

interface HuobiSymbolsResponse {
  data?: HuobiSymbol[];
}

interface HuobiTicker {
  symbol?: string;
  close?: number;
}

interface HuobiTickersResponse {
  data?: HuobiTicker[];
}

interface HuobiTickerExtended extends HuobiTicker {
  vol?: number;
}

interface HuobiDepthResponse {
  tick?: {
    bids?: number[][];
    asks?: number[][];
  };
}

interface HuobiCurrencyChain {
  displayName?: string;
  chain?: string;
  depositStatus?: string;
  withdrawStatus?: string;
}

interface HuobiCurrency {
  currency?: string;
  chains?: HuobiCurrencyChain[];
}

interface HuobiCurrenciesResponse {
  data?: HuobiCurrency[];
}

interface UpbitMarket {
  market?: string;
}

interface UpbitTicker {
  market?: string;
  trade_price?: number;
}

interface UpbitTickerExtended extends UpbitTicker {
  acc_trade_price_24h?: number;
}

interface UpbitOrderBookUnit {
  ask_price?: number;
  ask_size?: number;
  bid_price?: number;
  bid_size?: number;
}

interface UpbitOrderBookEntry {
  orderbook_units?: UpbitOrderBookUnit[];
}

interface BithumbTicker {
  closing_price?: string;
}

interface BithumbResponse {
  status?: string;
  data?: Record<string, BithumbTicker | string>;
}

interface BitflyerMarket {
  product_code?: string;
}

interface BitflyerTicker {
  ltp?: number;
}
