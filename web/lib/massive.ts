// Cliente de Massive (massive.com — antes Polygon.io). Solo se usa en el servidor.

import type { CompanyInfo, DailyBar, RawContract, TfBar } from "./types";
import { marketDateStr } from "./occ";
import { fetchChainFromFlow, fetchWheelChainFromFlow } from "./marketsnack";

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
    const res: Response = await fetchMassive(url, key);

    if (!res.ok) {
      // El plan ya no autoriza el snapshot de opciones (403): reconstruimos la
      // cadena desde el flujo de MarketSnack, que sí trae OI/bid/greeks por
      // contrato. Transparente para el resto del pipeline (misma forma).
      if (res.status === 403) {
        return fetchChainFromFlow(clean, {
          onPage: (p, acc) => progress.onPage?.(p, acc),
        });
      }
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
    // Pausa entre páginas: espacia las llamadas para no reventar el límite/min
    // de Massive en cadenas grandes (SPY pagina muchas veces).
    if (url) await new Promise((r) => setTimeout(r, 200));
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

interface DailyAggBar {
  t: number; // epoch ms
  o: number;
  h: number;
  l: number;
  c: number;
  v?: number;
}

/**
 * Últimas `n` barras diarias (EOD) del subyacente, más reciente primero.
 *
 * Reemplaza al stock snapshot en vivo (`/v2/snapshot/...`), que el plan de
 * Massive dejó de autorizar (403 "upgrade your plan", oct 2026). Las barras
 * diarias (`/v2/aggs/.../range/1/day`) SÍ siguen entitled, así que el precio
 * mostrado es el ÚLTIMO CIERRE de mercado (retrasado), no el intradía.
 */
async function fetchRecentDaily(clean: string, n = 2): Promise<DailyAggBar[]> {
  const to = new Date();
  const from = new Date(to.getTime() - 14 * 24 * 60 * 60 * 1000);
  const path =
    `/v2/aggs/ticker/${encodeURIComponent(clean)}/range/1/day/` +
    `${toDateStr(from.getTime())}/${toDateStr(to.getTime())}` +
    `?adjusted=true&sort=desc&limit=${n}`;
  const json = await getJson<{ results?: DailyAggBar[] }>(path).catch(() => null);
  return json?.results ?? [];
}

// Cliente HTTP compartido con REINTENTO ante 429: el plan de Massive limita por
// minuto, y una página con 429 no debe tirar toda la operación. Espera y
// reintenta (respeta Retry-After si viene; si no, backoff exponencial).
async function fetchMassive(url: string, key: string): Promise<Response> {
  const maxAttempts = 4;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${key}` },
      cache: "no-store",
    });
    if (res.status === 429 && attempt < maxAttempts) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 1500 * 2 ** (attempt - 1); // 1.5s → 3s → 6s
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    return res;
  }
}

async function getJson<T>(path: string): Promise<T | null> {
  const key = apiKey();
  const res = await fetchMassive(`${BASE_URL}${path}`, key);
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new MassiveError(describeStatus(res.status, "", body), res.status);
  }
  return (await res.json()) as T;
}

/**
 * Primer valor POSITIVO de una lista. Massive devuelve `day.c = 0` (no null) temprano en
 * la sesión o por límites del plan, y `x ?? y` NO salta el 0 → mostraba precio $0 o el
 * cierre de ayer. Este helper salta null/undefined Y ceros, así que toma el precio real.
 */
function primerPositivo(...xs: Array<number | null | undefined>): number | null {
  for (const x of xs) if (typeof x === "number" && x > 0) return x;
  return null;
}

/** Detalles de referencia + precio (último cierre EOD), combinados en CompanyInfo. */
export async function fetchCompany(ticker: string): Promise<CompanyInfo> {
  const clean = ticker.trim().toUpperCase();
  const [details, bars] = await Promise.all([
    getJson<{ results?: TickerDetails }>(
      `/v3/reference/tickers/${encodeURIComponent(clean)}`,
    ).catch(() => null),
    // El snapshot en vivo (`/v2/snapshot/...`) ya no está entitled en el plan;
    // tomamos el precio de las dos últimas barras diarias (sí funcionan).
    fetchRecentDaily(clean, 2).catch(() => [] as DailyAggBar[]),
  ]);

  const d = details?.results ?? {};
  const exchangeCode = d.primary_exchange;

  // bars viene más reciente primero: [0] = última sesión, [1] = la anterior.
  // El "precio" es el último cierre de mercado (retrasado) y el cambio es
  // día-sobre-día. No hay intradía en este plan.
  const last = bars[0];
  const prev = bars[1];
  const px = primerPositivo(last?.c);
  const prevC = primerPositivo(prev?.c);
  const derivable = px != null && prevC != null;

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
    price: px,
    change: derivable ? px - prevC : null,
    changePercent: derivable && prevC > 0 ? ((px - prevC) / prevC) * 100 : null,
    dayOpen: last?.o ?? null,
    dayHigh: last?.h ?? null,
    dayLow: last?.l ?? null,
    dayVolume: last?.v ?? null,
    prevClose: prevC,
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
  // Agregado diario del contrato. Massive dejó de exponer last_quote/last_trade
  // en este plan, pero sigue mandando `day` — su close es el último precio
  // (retrasado) del put, respaldo para la prima cuando MarketSnack no cotiza.
  day?: { close?: number; vwap?: number };
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

  let results: WheelRawContract[];
  try {
    const json = await getJson<{ results?: WheelRawContract[] }>(path);
    results = json?.results ?? [];
  } catch (err) {
    // El plan ya no autoriza el snapshot (403): reconstruimos los puts desde el
    // flujo de MarketSnack (preserva bid y OI). Misma forma de salida.
    if (err instanceof MassiveError && err.status === 403) {
      return fetchWheelChainFromFlow(clean, {
        dteMin: opts.dteMin,
        dteMax: opts.dteMax,
        now,
      });
    }
    throw err;
  }

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
      lastTrade: c.last_trade?.price ?? c.day?.close ?? c.day?.vwap ?? null,
      openInterest: c.open_interest ?? 0,
    });
  }

  // Solo puts OTM: los ITM no son cash-secured puts de Wheel, son otra cosa.
  const otm = spot != null ? quotes.filter((q) => q.strike <= spot) : quotes;
  return { spot, quotes: otm };
}

function describeStatus(status: number, ticker: string, body: string): string {
  switch (status) {
    case 401:
      return "Autenticación rechazada por Massive (401). Revisa la API key.";
    case 403:
      return "Tu plan de Massive no incluye estos datos (403). El option chain y los snapshots en vivo (OI, greeks, precio intradía) requieren un plan superior; las barras diarias, los detalles de empresa y las noticias sí funcionan. Para datos de opciones en vivo usa Robinhood en la sesión del agente.";
    case 404:
      return `Massive no encontró datos para "${ticker}".`;
    case 429:
      return "Límite de tasa de Massive alcanzado. Reintenta en unos segundos.";
    default:
      return `Massive respondió ${status}. ${body.slice(0, 200)}`.trim();
  }
}
