// Cliente de Massive (massive.com — antes Polygon.io). Solo se usa en el servidor.

import type { CompanyInfo, DailyBar, RawContract, TfBar } from "./types";
import { marketDateStr } from "./occ";
import { NEAR_SPOT_PCT } from "./gex";

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Reintentos SOLO para 429 (límite de tasa) — es lo único que se arregla solo
 * con esperar; 401/403/404 van a fallar igual la próxima vez. Backoff corto:
 * la mayoría de estos límites de Massive se liberan en 1-2 segundos.
 */
const RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_DELAYS_MS = [800, 1600];

/** Fetch con reintento de 429 — comparten esta parte fetchOptionChain, fetchNearChain y getJson. */
async function fetchWithRateLimitRetry(url: string, key: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, cache: "no-store" });
    if (res.status === 429 && attempt < RATE_LIMIT_RETRIES) {
      await sleep(RATE_LIMIT_DELAYS_MS[attempt]);
      continue;
    }
    return res;
  }
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
    const res: Response = await fetchWithRateLimitRetry(url, key);

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
  const res = await fetchWithRateLimitRetry(`${BASE_URL}${path}`, key);
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
    price: t.day?.c ?? t.min?.c ?? t.prevDay?.c ?? null,
    change: t.todaysChange ?? null,
    changePercent: t.todaysChangePerc ?? null,
    dayOpen: t.day?.o ?? null,
    dayHigh: t.day?.h ?? null,
    dayLow: t.day?.l ?? null,
    dayVolume: t.day?.v ?? null,
    prevClose: t.prevDay?.c ?? null,
  };
}

interface AggBar {
  t: number; // epoch ms
  o: number;
  h: number;
  l: number;
  c: number;
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
  // Sin .catch acá a propósito: swallowear el error da un array vacío "exitoso"
  // indistinguible de "no hay barras", y GEX/niveles/predicción se quedan mudos
  // para siempre sin ningún aviso (bug real, visto con Massive fallando en
  // silencio bajo carga). Cada caller decide cómo manejar el fallo — la mayoría
  // encadena su propio `.catch(() => [])`; `/api/history` lo deja propagar para
  // devolver un 502 real en vez de fingir que no hay datos.
  const json = await getJson<{ results?: AggBar[] }>(path);
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
  // Mismo motivo que fetchDailyBars: no swallowear el error acá — /api/bars ya
  // lo convierte en un 502 real en vez de un array vacío indistinguible de
  // "no hay datos".
  const json = await getJson<{ results?: AggBar[] }>(path);
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

export interface NearChainResult {
  spot: number | null;
  /** Ambos lados (call y put), acotados a ±NEAR_SPOT_PCT del spot. */
  contracts: RawContract[];
  truncated: boolean;
}

/**
 * Cadena acotada para el piloto automático (GEX + niveles): trae ambos lados dentro
 * de la ventana de vencimiento, igual que `fetchWheelChain`, y filtra por strike
 * DESPUÉS de conocer el spot real (mismo motivo: no se puede acotar por strike antes
 * de tener un precio de referencia sin gastar una llamada aparte). `maxPages` acota
 * el costo por ticker — el piloto escanea ~40 tickers por corrida.
 */
export async function fetchNearChain(
  ticker: string,
  opts: { dteMax: number; now?: Date; maxPages?: number },
): Promise<NearChainResult> {
  const clean = ticker.trim().toUpperCase();
  if (!clean) throw new MassiveError("Ticker vacío.");
  const now = opts.now ?? new Date();
  const day = 24 * 60 * 60 * 1000;
  const todayET = marketDateStr(now);
  const todayETMs = Date.parse(`${todayET}T00:00:00Z`);
  const to = toDateStr(todayETMs + opts.dteMax * day);
  const limit = opts.maxPages ?? 3;

  const key = apiKey();
  const contracts: RawContract[] = [];
  let spot: number | null = null;
  let url: string | null =
    `${BASE_URL}/v3/snapshot/options/${encodeURIComponent(clean)}` +
    `?expiration_date.lte=${to}&limit=250`;
  let page = 0;
  let truncated = false;

  while (url) {
    page += 1;
    const res: Response = await fetchWithRateLimitRetry(url, key);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new MassiveError(describeStatus(res.status, clean, body), res.status);
    }
    const json: { results?: RawContract[]; next_url?: string } = await res.json();
    for (const c of json.results ?? []) {
      contracts.push(c);
      if (spot === null && typeof c.underlying_asset?.price === "number") {
        spot = c.underlying_asset.price;
      }
    }
    if (page >= limit) {
      truncated = Boolean(json.next_url);
      break;
    }
    url = json.next_url ?? null;
  }

  if (spot == null) return { spot: null, contracts: [], truncated };

  const lo = spot * (1 - NEAR_SPOT_PCT);
  const hi = spot * (1 + NEAR_SPOT_PCT);
  const near = contracts.filter((c) => {
    const k = c.details?.strike_price;
    return k != null && k >= lo && k <= hi;
  });

  return { spot, contracts: near, truncated };
}

export interface ContractQuote {
  underlyingPrice: number | null;
  bid: number | null;
  ask: number | null;
  lastTrade: number | null;
  /** Precio a usar para monitorear el trade: mid si hay bid/ask, si no el último trade. */
  mid: number | null;
}

interface ContractRawResult {
  last_quote?: { bid?: number; ask?: number };
  last_trade?: { price?: number };
  underlying_asset?: { price?: number };
}

/**
 * Cotización de UN contrato exacto (para monitorear un paper trade). Filtra en el
 * servidor por tipo/strike/vencimiento, igual que `fetchWheelChain`, así que un
 * ticker cabe en una sola llamada en vez de traer la cadena completa.
 */
export async function fetchContractQuote(
  ticker: string,
  contractType: "call" | "put",
  strike: number,
  expiration: string,
): Promise<ContractQuote | null> {
  const clean = ticker.trim().toUpperCase();
  if (!clean) throw new MassiveError("Ticker vacío.");
  const path =
    `/v3/snapshot/options/${encodeURIComponent(clean)}` +
    `?contract_type=${contractType}&expiration_date=${expiration}` +
    `&strike_price=${strike}&limit=1`;

  const json = await getJson<{ results?: ContractRawResult[] }>(path);
  const c = json?.results?.[0];
  if (!c) return null;

  const bid = c.last_quote?.bid ?? null;
  const ask = c.last_quote?.ask ?? null;
  const lastTrade = c.last_trade?.price ?? null;
  const mid = bid != null && ask != null ? (bid + ask) / 2 : lastTrade;

  return {
    underlyingPrice: c.underlying_asset?.price ?? null,
    bid,
    ask,
    lastTrade,
    mid,
  };
}

function describeStatus(status: number, ticker: string, body: string): string {
  switch (status) {
    case 401:
      return "Massive rechazó la API key (401): no es válida o no se envió. Revisa MASSIVE_API_KEY en .env.local.";
    case 403: {
      const detail = body.slice(0, 200).trim();
      return (
        `Massive bloqueó el acceso (403): la key es válida pero no tiene permiso para este endpoint ` +
        `(plan sin datos de opciones, rate limit u otra restricción de cuenta).${detail ? ` Detalle: ${detail}` : ""}`
      );
    }
    case 404:
      return `Massive no encontró datos para "${ticker}".`;
    case 429:
      return "Límite de tasa de Massive alcanzado. Reintenta en unos segundos.";
    default:
      return `Massive respondió ${status}. ${body.slice(0, 200)}`.trim();
  }
}
