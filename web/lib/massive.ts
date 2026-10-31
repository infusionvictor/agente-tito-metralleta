// Cliente de Massive (massive.com — antes Polygon.io). Solo se usa en el servidor.

import type { CompanyInfo, DailyBar, RawContract, TfBar } from "./types";
import { marketDateStr } from "./occ";

const BASE_URL = "https://api.massive.com";

const EXCHANGE_NAMES: Record<string, string> = {
  XNAS: "Nasdaq",
  XNYS: "NYSE",
  ARCX: "NYSE Arca",
  XASE: "NYSE American",
  BATS: "Cboe BZX",
  IEXG: "IEX",
};

export class MassiveError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "MassiveError";
    this.status = status;
  }
}

function apiKey(): string {
  const key = process.env.MASSIVE_API_KEY;
  if (!key) throw new MassiveError("Falta MASSIVE_API_KEY en el entorno (.env.local).");
  return key;
}

function maxPages(): number {
  const n = Number(process.env.MASSIVE_MAX_PAGES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 40;
}

export interface FetchProgress {
  /** Se llama al terminar cada página, con el número de página y el total acumulado. */
  onPage?: (page: number, accumulated: number) => void | Promise<void>;
}

export interface ChainResult {
  contracts: RawContract[];
  underlyingPrice: number | null;
  pages: number;
  truncated: boolean;
}

/**
 * Descarga la option chain completa de un ticker siguiendo la paginación por `next_url`.
 * Emite progreso por página. Corta en MASSIVE_MAX_PAGES como salvaguarda.
 */
export async function fetchOptionChain(
  ticker: string,
  progress: FetchProgress = {},
): Promise<ChainResult> {
  const key = apiKey();
  const limit = maxPages();
  const clean = ticker.trim().toUpperCase();
  if (!clean) throw new MassiveError("Ticker vacío.");

  const contracts: RawContract[] = [];
  let underlyingPrice: number | null = null;
  let url: string | null =
    `${BASE_URL}/v3/snapshot/options/${encodeURIComponent(clean)}?limit=250`;
  let page = 0;
  let truncated = false;

  while (url) {
    page += 1;
    const res: Response = await fetch(url, {
      headers: { Authorization: `Bearer ${key}` },
      cache: "no-store",
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new MassiveError(
        describeStatus(res.status, clean, body),
        res.status,
      );
    }

    const json: {
      results?: RawContract[];
      next_url?: string;
    } = await res.json();

    const results = json.results ?? [];
    for (const c of results) {
      contracts.push(c);
      if (underlyingPrice === null && typeof c.underlying_asset?.price === "number") {
        underlyingPrice = c.underlying_asset.price;
      }
    }

    await progress.onPage?.(page, contracts.length);

    if (page >= limit) {
      truncated = Boolean(json.next_url);
      break;
    }
    url = json.next_url ?? null;
  }

  return { contracts, underlyingPrice, pages: page, truncated };
}

interface TickerDetails {
  name?: string;
  market_cap?: number;
  primary_exchange?: string;
  homepage_url?: string;
  total_employees?: number;
  list_date?: string;
  sic_description?: string;
  description?: string;
  branding?: { logo_url?: string; icon_url?: string };
}

interface StockSnapshot {
  todaysChange?: number;
  todaysChangePerc?: number;
  day?: { o?: number; h?: number; l?: number; c?: number; v?: number };
  min?: { c?: number };
  prevDay?: { c?: number };
}

async function getJson<T>(path: string): Promise<T | null> {
  const key = apiKey();
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${key}` },
    cache: "no-store",
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new MassiveError(describeStatus(res.status, "", body), res.status);
  }
  return (await res.json()) as T;
}

/** Detalles de referencia + snapshot de precio, combinados en CompanyInfo. */
export async function fetchCompany(ticker: string): Promise<CompanyInfo> {
  const clean = ticker.trim().toUpperCase();
  const [details, snap] = await Promise.all([
    getJson<{ results?: TickerDetails }>(
      `/v3/reference/tickers/${encodeURIComponent(clean)}`,
    ).catch(() => null),
    getJson<{ ticker?: StockSnapshot }>(
      `/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(clean)}`,
    ).catch(() => null),
  ]);

  const d = details?.results ?? {};
  const t = snap?.ticker ?? {};
  const exchangeCode = d.primary_exchange;

  // Precio del subyacente. El snapshot en vivo (`/v2/snapshot/...`) requiere el plan
  // de Stocks; si no está disponible (403 → snap null) O con el mercado cerrado devuelve
  // `day.c = 0`, caemos al cierre previo (plan gratis). Usamos `||` a propósito: un 0 no
  // es un precio, así que debe saltar al siguiente candidato (evita el bug del $0.00).
  let price = t.day?.c || t.min?.c || t.prevDay?.c || null;
  let dayOpen = t.day?.o ?? null;
  let dayHigh = t.day?.h ?? null;
  let dayLow = t.day?.l ?? null;
  let dayVolume = t.day?.v ?? null;
  let prevClose = t.prevDay?.c ?? null;

  if (!price) {
    const prev = await getJson<{ results?: AggBar[] }>(
      `/v2/aggs/ticker/${encodeURIComponent(clean)}/prev?adjusted=true`,
    ).catch(() => null);
    const p = prev?.results?.[0];
    if (p) {
      price = p.c ?? null;
      dayOpen = p.o ?? null;
      dayHigh = p.h ?? null;
      dayLow = p.l ?? null;
      dayVolume = p.v ?? null;
      prevClose = p.c ?? null;
    }
  }

  return {
    ticker: clean,
    name: d.name ?? null,
    exchange: exchangeCode ? EXCHANGE_NAMES[exchangeCode] ?? exchangeCode : null,
    marketCap: d.market_cap ?? null,
    homepageUrl: d.homepage_url ?? null,
    employees: d.total_employees ?? null,
    listDate: d.list_date ?? null,
    sector: d.sic_description ?? null,
    description: d.description ?? null,
    hasLogo: Boolean(d.branding?.logo_url || d.branding?.icon_url),
    price,
    change: t.todaysChange ?? null,
    changePercent: t.todaysChangePerc ?? null,
    dayOpen,
    dayHigh,
    dayLow,
    dayVolume,
    prevClose,
  };
}

interface AggBar {
  t: number; // epoch ms
  o: number;
  h: number;
  l: number;
  c: number;
  v?: number;
}

function toDateStr(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Barras diarias del subyacente en los últimos `days` días (para la gráfica). */
export async function fetchDailyBars(ticker: string, days = 365): Promise<DailyBar[]> {
  const clean = ticker.trim().toUpperCase();
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  const path =
    `/v2/aggs/ticker/${encodeURIComponent(clean)}/range/1/day/` +
    `${toDateStr(from.getTime())}/${toDateStr(to.getTime())}` +
    `?adjusted=true&sort=asc&limit=500`;
  const json = await getJson<{ results?: AggBar[] }>(path).catch(() => null);
  const bars = json?.results ?? [];
  return bars.map((b) => ({
    time: toDateStr(b.t),
    open: b.o,
    high: b.h,
    low: b.l,
    close: b.c,
  }));
}

/** Barras del subyacente (diario o intradía) con tiempo UNIX en segundos. */
export async function fetchBars(
  ticker: string,
  multiplier: number,
  timespan: "day" | "minute",
  days: number,
): Promise<TfBar[]> {
  const clean = ticker.trim().toUpperCase();
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  const path =
    `/v2/aggs/ticker/${encodeURIComponent(clean)}/range/${multiplier}/${timespan}/` +
    `${toDateStr(from.getTime())}/${toDateStr(to.getTime())}` +
    `?adjusted=true&sort=asc&limit=50000`;
  const json = await getJson<{ results?: AggBar[] }>(path).catch(() => null);
  const bars = json?.results ?? [];
  return bars.map((b) => ({
    time: Math.floor(b.t / 1000),
    open: b.o,
    high: b.h,
    low: b.l,
    close: b.c,
  }));
}

/** Descarga la imagen del logo (o icono) para servirla por proxy. */
export async function fetchLogoImage(
  ticker: string,
): Promise<{ data: ArrayBuffer; contentType: string } | null> {
  const key = apiKey();
  const clean = ticker.trim().toUpperCase();
  const details = await getJson<{ results?: TickerDetails }>(
    `/v3/reference/tickers/${encodeURIComponent(clean)}`,
  ).catch(() => null);
  const url = details?.results?.branding?.logo_url ?? details?.results?.branding?.icon_url;
  if (!url) return null;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) return null;
  const contentType = res.headers.get("content-type") ?? "image/png";
  return { data: await res.arrayBuffer(), contentType };
}

/**
 * Cadena de PUTS filtrada en el servidor para el screener de Wheel.
 *
 * Los filtros (`contract_type`, `expiration_date.gte/lte`, `strike_price.lte`)
 * los resuelve Massive, así que un ticker cabe en UNA página en vez de exigir
 * la cadena completa paginada. Verificado el 2026-07-24: 126 contratos, sin
 * next_url.
 *
 * `last_quote` (bid/ask) SÍ viene en este plan; `greeks` e `implied_volatility`
 * NO — el delta se calcula por Black-Scholes en lib/wheel.ts.
 */
export interface WheelChainResult {
  spot: number | null;
  quotes: WheelChainQuote[];
}

export interface WheelChainQuote {
  strike: number;
  expiration: string;
  dte: number;
  bid: number | null;
  ask: number | null;
  lastTrade: number | null;
  openInterest: number;
}

interface WheelRawContract {
  details?: { strike_price?: number; expiration_date?: string; contract_type?: string };
  last_quote?: { bid?: number; ask?: number };
  last_trade?: { price?: number };
  open_interest?: number;
  underlying_asset?: { price?: number };
}

export async function fetchWheelChain(
  ticker: string,
  opts: { dteMin: number; dteMax: number; now?: Date },
): Promise<WheelChainResult> {
  const clean = ticker.trim().toUpperCase();
  if (!clean) throw new MassiveError("Ticker vacío.");
  const now = opts.now ?? new Date();
  const day = 24 * 60 * 60 * 1000;
  // Ancla "hoy" en el día de mercado ET (no UTC): después de las ~8 PM ET el
  // día UTC ya saltó al siguiente y el dte/rango de vencimientos saldría
  // desfasado un día (ver el aviso en marketDateStr, lib/occ.ts).
  const todayET = marketDateStr(now);
  const todayETMs = Date.parse(`${todayET}T00:00:00Z`);
  const from = toDateStr(todayETMs + opts.dteMin * day);
  const to = toDateStr(todayETMs + opts.dteMax * day);

  const path =
    `/v3/snapshot/options/${encodeURIComponent(clean)}` +
    `?contract_type=put&expiration_date.gte=${from}&expiration_date.lte=${to}&limit=250`;

  const json = await getJson<{ results?: WheelRawContract[] }>(path);
  const results = json?.results ?? [];

  let spot: number | null = null;
  const quotes: WheelChainQuote[] = [];

  for (const c of results) {
    const strike = c.details?.strike_price;
    const expiration = c.details?.expiration_date;
    if (!(strike != null && strike > 0) || !expiration) continue;
    if (spot == null && c.underlying_asset?.price) spot = c.underlying_asset.price;

    const dte = Math.round(
      (Date.parse(`${expiration}T00:00:00Z`) - todayETMs) / day,
    );

    quotes.push({
      strike,
      expiration,
      dte,
      bid: c.last_quote?.bid ?? null,
      ask: c.last_quote?.ask ?? null,
      lastTrade: c.last_trade?.price ?? null,
      openInterest: c.open_interest ?? 0,
    });
  }

  // Solo puts OTM: los ITM no son cash-secured puts de Wheel, son otra cosa.
  const otm = spot != null ? quotes.filter((q) => q.strike <= spot) : quotes;
  return { spot, quotes: otm };
}

export interface ChainQuote {
  strike: number;
  type: "call" | "put";
  /** cierre del día o último trade, por acción. */
  price: number;
  /** delta firmado (puts negativo); null si el plan no lo trae. */
  delta: number | null;
  /** IV en decimal (0.68 = 68%); null si no viene. */
  iv: number | null;
  oi: number;
  /** ms de la última actualización del contrato (para detectar data stale). */
  lastUpdatedMs: number | null;
}

export interface ChainQuotesResult {
  quotes: ChainQuote[];
  expiration: string;
  dte: number;
  spot: number | null;
}

interface ChainRawContract {
  details?: { strike_price?: number; expiration_date?: string; contract_type?: string };
  day?: { close?: number; last_updated?: number };
  last_trade?: { price?: number };
  greeks?: { delta?: number };
  implied_volatility?: number;
  open_interest?: number;
  underlying_asset?: { price?: number };
}

/**
 * Cadena near-money del vencimiento más cercano (≥2 días, para evitar 0DTE), con delta.
 * Una sola llamada que alimenta tanto el straddle ATM (move implícito) como el sugeridor
 * de spreads. Ver lib/earningsMove.ts y lib/premiumSell.ts.
 */
export async function fetchChainQuotes(
  ticker: string,
  spot: number | null,
): Promise<ChainQuotesResult | null> {
  const clean = ticker.trim().toUpperCase();
  if (!clean) return null;
  const day = 24 * 60 * 60 * 1000;
  const todayETMs = Date.parse(`${marketDateStr(new Date())}T00:00:00Z`);
  const from = toDateStr(todayETMs + 2 * day);
  const to = toDateStr(todayETMs + 45 * day);
  // Rango amplio: los spreads necesitan alas bien OTM (fuera del 1σ de earnings).
  const strikeFilter =
    spot && spot > 0
      ? `&strike_price.gte=${Math.floor(spot * 0.6)}&strike_price.lte=${Math.ceil(spot * 1.4)}`
      : "";
  const path =
    `/v3/snapshot/options/${encodeURIComponent(clean)}` +
    `?expiration_date.gte=${from}&expiration_date.lte=${to}${strikeFilter}&limit=250`;

  const json = await getJson<{ results?: ChainRawContract[] }>(path).catch(() => null);
  const results = json?.results ?? [];
  if (results.length === 0) return null;

  const exps = [
    ...new Set(results.map((c) => c.details?.expiration_date).filter(Boolean) as string[]),
  ].sort();
  const target = exps[0];
  if (!target) return null;
  const atExp = results.filter((c) => c.details?.expiration_date === target);

  const s =
    spot && spot > 0
      ? spot
      : atExp.find((c) => c.underlying_asset?.price)?.underlying_asset?.price ?? null;

  const quotes: ChainQuote[] = [];
  for (const c of atExp) {
    const strike = c.details?.strike_price;
    const type = c.details?.contract_type;
    const price = c.day?.close ?? c.last_trade?.price ?? 0;
    if (
      !(strike != null && strike > 0) ||
      (type !== "call" && type !== "put") ||
      price <= 0
    )
      continue;
    quotes.push({
      strike,
      type,
      price,
      delta: c.greeks?.delta ?? null,
      iv: c.implied_volatility ?? null,
      oi: c.open_interest ?? 0,
      // Massive entrega el timestamp en nanosegundos → a ms.
      lastUpdatedMs: c.day?.last_updated ? Math.round(c.day.last_updated / 1e6) : null,
    });
  }

  const dte = Math.round((Date.parse(`${target}T00:00:00Z`) - todayETMs) / day);
  return { quotes, expiration: target, dte, spot: s };
}

/**
 * Fechas de earnings pasadas (proxy: `filing_date` de los estados financieros trimestrales
 * de Massive). Fuente aislada a propósito para mejorarla luego (ver spec).
 */
export async function fetchEarningsDates(ticker: string): Promise<string[]> {
  const clean = ticker.trim().toUpperCase();
  if (!clean) return [];
  const json = await getJson<{ results?: { filing_date?: string }[] }>(
    `/vX/reference/financials?ticker=${encodeURIComponent(clean)}&limit=16&timeframe=quarterly`,
  ).catch(() => null);
  const dates = (json?.results ?? [])
    .map((r) => r.filing_date)
    .filter((d): d is string => Boolean(d));
  return [...new Set(dates)].sort();
}

function describeStatus(status: number, ticker: string, body: string): string {
  switch (status) {
    case 401:
    case 403:
      return "Autenticación rechazada por Massive. Revisa la API key.";
    case 404:
      return `Massive no encontró datos para "${ticker}".`;
    case 429:
      return "Límite de tasa de Massive alcanzado. Reintenta en unos segundos.";
    default:
      return `Massive respondió ${status}. ${body.slice(0, 200)}`.trim();
  }
}
