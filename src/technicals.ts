// technicals.ts — OHLCV candle data + technical indicators
// RSI, MACD, Bollinger Bands — all calculated numerically from DexScreener candles

export interface Candle {
  timestamp: number;
  open:      number;
  high:      number;
  low:       number;
  close:     number;
  volume:    number;
}

export interface TechnicalIndicators {
  rsi14:          number;        // 0-100
  macdLine:       number;
  macdSignal:     number;
  macdHistogram:  number;
  bbUpper:        number;        // Bollinger Band upper
  bbMiddle:       number;        // Bollinger Band middle (20 SMA)
  bbLower:        number;        // Bollinger Band lower
  bbPosition:     number;        // 0-1, where price sits in BB range
  sma20:          number;
  sma50:          number;
  ema12:          number;
  ema26:          number;
  priceVsSma20:   number;        // % above/below SMA20
  priceVsSma50:   number;        // % above/below SMA50
  volumeAvg20:    number;        // 20-period volume average
  volumeRatio:    number;        // current volume / avg
  trend:          "strong_up" | "up" | "neutral" | "down" | "strong_down";
  signals:        TechnicalSignals;
}

export interface TechnicalSignals {
  rsiOversold:        boolean;   // RSI < 30
  rsiOverbought:      boolean;   // RSI > 70
  macdBullish:        boolean;   // MACD crossed above signal
  macdBearish:        boolean;   // MACD crossed below signal
  bbSqueeze:          boolean;   // BB width < 2% of price (consolidation)
  bbBreakoutUp:       boolean;   // Price broke above upper BB
  bbBreakoutDown:     boolean;   // Price broke below lower BB
  goldenCross:        boolean;   // SMA20 crossed above SMA50
  deathCross:         boolean;   // SMA20 crossed below SMA50
  volumeSpike:        boolean;   // Volume > 2x average
  oversoldRecovery:   boolean;   // RSI < 35 AND price rising (best entry signal)
}

// DexScreener candle intervals
type CandleInterval = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

const DEXSCREENER_BASE = "https://api.dexscreener.com";

export class KiraTechnicals {

  // ── FETCH CANDLES ─────────────────────────────────────────────────────────────

  async getCandles(
    pairAddress: string,
    chain:       string = "base",
    interval:    CandleInterval = "1h",
    limit:       number = 100
  ): Promise<Candle[]> {
    try {
      // DexScreener chart data endpoint
      const chainId = chain === "ethereum" ? "ethereum" : chain;
      const url     = `${DEXSCREENER_BASE}/latest/dex/pairs/${chainId}/${pairAddress}`;

      const res  = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) return [];

      const data = await res.json() as any;
      const pair = data.pair;
      if (!pair) return [];

      // DexScreener doesn't provide full OHLCV candles in the free API
      // We reconstruct from price history using available data points
      // For now: return synthetic candles from price snapshots
      // This will be upgraded when we add a proper candle data source
      return this.syntheticCandles(pair, limit);

    } catch (err: any) {
      console.error(`Candles fetch failed for ${pairAddress}:`, err?.message);
      return [];
    }
  }

  // Generate synthetic candles from DexScreener price change data
  // Approximates historical candles from % change data
  private syntheticCandles(pair: any, limit: number): Candle[] {
    const currentPrice = parseFloat(pair.priceUsd || "0");
    if (currentPrice === 0) return [];

    const candles: Candle[] = [];
    const now = Date.now();

    // Work backwards from current price using % changes
    const change1h  = pair.priceChange?.h1  || 0;
    const change6h  = pair.priceChange?.h6  || 0;
    const change24h = pair.priceChange?.h24 || 0;
    const volume24h = pair.volume?.h24      || 0;

    // Reconstruct approximate prices at different points
    const price24hAgo = currentPrice / (1 + change24h / 100);
    const price6hAgo  = currentPrice / (1 + change6h  / 100);
    const price1hAgo  = currentPrice / (1 + change1h  / 100);

    // Build candles with linear interpolation
    const pricePoints = [
      { time: now - 24 * 3600 * 1000, price: price24hAgo },
      { time: now -  6 * 3600 * 1000, price: price6hAgo  },
      { time: now -  1 * 3600 * 1000, price: price1hAgo  },
      { time: now,                     price: currentPrice },
    ];

    // Interpolate candles between price points
    for (let i = 0; i < pricePoints.length - 1; i++) {
      const start  = pricePoints[i];
      const end    = pricePoints[i + 1];
      const steps  = Math.max(1, Math.round((end.time - start.time) / (3600 * 1000)));
      const priceDelta = (end.price - start.price) / steps;
      const volPerCandle = volume24h / 24;

      for (let j = 0; j < steps; j++) {
        const open  = start.price + priceDelta * j;
        const close = start.price + priceDelta * (j + 1);
        const noise = open * 0.005; // 0.5% noise
        candles.push({
          timestamp: start.time + j * 3600 * 1000,
          open,
          high:   Math.max(open, close) + noise,
          low:    Math.min(open, close) - noise,
          close,
          volume: volPerCandle * (0.8 + Math.random() * 0.4),
        });
      }
    }

    return candles.slice(-limit);
  }

  // ── TECHNICAL INDICATORS ──────────────────────────────────────────────────────

  calculateIndicators(candles: Candle[]): TechnicalIndicators | null {
    if (candles.length < 26) return null; // Need at least 26 candles for MACD

    const closes  = candles.map(c => c.close);
    const volumes = candles.map(c => c.volume);
    const current = closes[closes.length - 1];

    const rsi14      = this.calculateRSI(closes, 14);
    const sma20      = this.calculateSMA(closes, 20);
    const sma50      = this.calculateSMA(closes, Math.min(50, closes.length));
    const ema12      = this.calculateEMA(closes, 12);
    const ema26      = this.calculateEMA(closes, 26);
    const macdLine   = ema12 - ema26;

    // MACD signal is 9-period EMA of MACD line
    // Approximate with recent MACD values
    const macdValues = closes.slice(-15).map((_, i) => {
      const slice = closes.slice(0, closes.length - 14 + i);
      return this.calculateEMA(slice, 12) - this.calculateEMA(slice, Math.min(26, slice.length));
    });
    const macdSignal    = this.calculateEMA(macdValues, 9);
    const macdHistogram = macdLine - macdSignal;

    const { upper: bbUpper, middle: bbMiddle, lower: bbLower } = this.calculateBollingerBands(closes, 20, 2);
    const bbRange    = bbUpper - bbLower;
    const bbPosition = bbRange > 0 ? (current - bbLower) / bbRange : 0.5;

    const volumeAvg20 = this.calculateSMA(volumes, 20);
    const volumeRatio = volumeAvg20 > 0 ? volumes[volumes.length - 1] / volumeAvg20 : 1;

    const priceVsSma20 = sma20 > 0 ? ((current - sma20) / sma20) * 100 : 0;
    const priceVsSma50 = sma50 > 0 ? ((current - sma50) / sma50) * 100 : 0;

    // Previous period values for crossover detection
    const prevCloses  = closes.slice(0, -1);
    const prevSma20   = this.calculateSMA(prevCloses, 20);
    const prevSma50   = this.calculateSMA(prevCloses, Math.min(50, prevCloses.length));
    const prevEma12   = this.calculateEMA(prevCloses, 12);
    const prevEma26   = this.calculateEMA(prevCloses, 26);
    const prevMacd    = prevEma12 - prevEma26;
    const prevMacdSig = this.calculateEMA(macdValues.slice(0, -1), 9);

    // Signals
    const signals: TechnicalSignals = {
      rsiOversold:      rsi14 < 30,
      rsiOverbought:    rsi14 > 70,
      macdBullish:      prevMacd < prevMacdSig && macdLine > macdSignal,
      macdBearish:      prevMacd > prevMacdSig && macdLine < macdSignal,
      bbSqueeze:        bbRange < current * 0.02,
      bbBreakoutUp:     current > bbUpper,
      bbBreakoutDown:   current < bbLower,
      goldenCross:      prevSma20 < prevSma50 && sma20 > sma50,
      deathCross:       prevSma20 > prevSma50 && sma20 < sma50,
      volumeSpike:      volumeRatio > 2,
      oversoldRecovery: rsi14 < 35 && current > closes[closes.length - 2],
    };

    // Overall trend
    let trend: TechnicalIndicators["trend"] = "neutral";
    const bullishSignals = [
      signals.macdBullish, signals.goldenCross,
      priceVsSma20 > 2, priceVsSma50 > 5,
    ].filter(Boolean).length;
    const bearishSignals = [
      signals.macdBearish, signals.deathCross,
      priceVsSma20 < -2, priceVsSma50 < -5,
    ].filter(Boolean).length;

    if (bullishSignals >= 3) trend = "strong_up";
    else if (bullishSignals >= 2) trend = "up";
    else if (bearishSignals >= 3) trend = "strong_down";
    else if (bearishSignals >= 2) trend = "down";

    return {
      rsi14, macdLine, macdSignal, macdHistogram,
      bbUpper, bbMiddle, bbLower, bbPosition,
      sma20, sma50, ema12, ema26,
      priceVsSma20, priceVsSma50,
      volumeAvg20, volumeRatio,
      trend, signals,
    };
  }

  // ── INDICATOR CALCULATIONS ────────────────────────────────────────────────────

  private calculateRSI(closes: number[], period: number = 14): number {
    if (closes.length < period + 1) return 50;

    const changes = closes.slice(1).map((c, i) => c - closes[i]);
    const recent  = changes.slice(-period);

    const gains  = recent.filter(c => c > 0).reduce((a, b) => a + b, 0) / period;
    const losses = recent.filter(c => c < 0).reduce((a, b) => a + Math.abs(b), 0) / period;

    if (losses === 0) return 100;
    const rs = gains / losses;
    return 100 - (100 / (1 + rs));
  }

  private calculateSMA(values: number[], period: number): number {
    if (values.length < period) period = values.length;
    const slice = values.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  }

  private calculateEMA(values: number[], period: number): number {
    if (values.length === 0) return 0;
    if (values.length < period) period = values.length;

    const k      = 2 / (period + 1);
    let ema      = values[0];

    for (let i = 1; i < values.length; i++) {
      ema = values[i] * k + ema * (1 - k);
    }
    return ema;
  }

  private calculateBollingerBands(
    closes: number[],
    period: number = 20,
    stdDev: number = 2
  ): { upper: number; middle: number; lower: number } {
    const sma    = this.calculateSMA(closes, period);
    const slice  = closes.slice(-period);
    const variance = slice.reduce((sum, c) => sum + Math.pow(c - sma, 2), 0) / slice.length;
    const std    = Math.sqrt(variance);

    return {
      upper:  sma + stdDev * std,
      middle: sma,
      lower:  sma - stdDev * std,
    };
  }

  // ── TECHNICAL SCORE ───────────────────────────────────────────────────────────

  // Converts technical indicators to a score contribution (0-25 pts)
  scoreTechnicals(indicators: TechnicalIndicators): number {
    let score = 0;
    const { signals, rsi14, trend, bbPosition, macdHistogram } = indicators;

    // Best entry signal: oversold + recovering
    if (signals.oversoldRecovery)   score += 10;
    else if (signals.rsiOversold)   score += 6;
    else if (rsi14 < 40)            score += 3;

    // Momentum signals
    if (signals.macdBullish)        score += 6;
    if (signals.goldenCross)        score += 5;
    if (signals.volumeSpike && trend === "up") score += 4;

    // BB position (lower = better entry)
    if (bbPosition < 0.2)           score += 4;
    else if (bbPosition < 0.4)      score += 2;

    // Penalties
    if (signals.rsiOverbought)      score -= 8;
    if (signals.macdBearish)        score -= 5;
    if (signals.deathCross)         score -= 6;
    if (signals.bbBreakoutDown)     score -= 4;

    return Math.max(0, Math.min(25, score));
  }

  formatForContext(indicators: TechnicalIndicators, symbol: string): string {
    const { rsi14, trend, signals, priceVsSma20, volumeRatio, macdHistogram } = indicators;
    const activeSignals = Object.entries(signals)
      .filter(([, v]) => v)
      .map(([k]) => k)
      .join(", ");

    return [
      `${symbol} technicals:`,
      `RSI: ${rsi14.toFixed(1)}`,
      `Trend: ${trend}`,
      `vs SMA20: ${priceVsSma20 > 0 ? "+" : ""}${priceVsSma20.toFixed(1)}%`,
      `Vol ratio: ${volumeRatio.toFixed(1)}x`,
      `MACD hist: ${macdHistogram > 0 ? "+" : ""}${macdHistogram.toFixed(4)}`,
      activeSignals ? `Signals: ${activeSignals}` : "",
    ].filter(Boolean).join(" | ");
  }
}
