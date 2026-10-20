// Cliente del API interno de MarketSnack (app.marketsnack.com). Solo servidor.
// Auth por cookie de sesión (MARKETSNACK_COOKIE en .env.local). Ver SCOREDCARD/Scoredcard.md.

import type { RawTrade } from "./flow";
import type { RawContract } from "./types";
import { parseOcc, marketDateStr } from "./occ";

const BASE_URL = "https://app.marketsnack.com";

export class MarketSnackError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "MarketSnackError";
    this.status = status;
  }
}

function cookie(): string {
  const c = process.env.MARKETSNACK_COOKIE;
  if (!c || !c.trim()) {
    throw new MarketSnackError(
      "Falta MARKETSNACK_COOKIE en .env.local. Copia tu cookie de sesión de app.marketsnack.com.",
    );
  }
  return c.trim();
}

export interface FetchFlowOptions {
  period?: string; // "1d" | "5d" | "1m"
  maxPages?: number;
  minPremium?: number; // filtro server-side: solo trades con premium ≥ este valor ($)
  targetDays?: number; // detener la paginación al cubrir N días hacia atrás
  onPage?: (page: number, accumulated: number) => void | Promise<void>;
}

export interface FlowResult {
  trades: RawTrade[];
  pages: number;
  truncated: boolean;
}

/**
 * Descarga el flujo (Time & Sales) de un ticker desde MarketSnack, paginando por
 * `next_page_token`. Endpoint: /api/flow_feed?filter[scope]=all&filter[symbol][]=TICKER&period=…
 */
export async function fetchFlow(
  ticker: string,
  opts: FetchFlowOptions = {},
): Promise<FlowResult> {
  const clean = ticker.trim().toUpperCase();
  if (!clean) throw new MarketSnackError("Ticker vacío.");
  return paginate(clean, opts);
}

/**
 * Igual que `fetchFlow` pero SIN filtro de símbolo: devuelve el flujo de todo el
 * mercado. Es lo que alimenta el screener de /ideas — el piso de premium
 * (`minPremium`) filtra server-side, así que el payload se mantiene chico.
 */
export async function fetchMarketFlow(opts: FetchFlowOptions = {}): Promise<FlowResult> {
  return paginate(null, opts);
}

export interface FlowChainResult {
  contracts: RawContract[];
  underlyingPrice: number | null;
  pages: number;
  truncated: boolean;
}

/**
 * Reconstruye una option chain a partir del flujo (Time & Sales) de MarketSnack,
 * con la MISMA forma que `fetchOptionChain` de Massive, para usarse como respaldo
 * cuando el plan de Massive ya no autoriza el snapshot de opciones (403).
 *
 * Diferencia clave vs. Massive: aquí solo aparecen contratos que **operaron** en
 * la ventana (período), no la cadena estática completa. Para análisis de flujo,
 * OI y muros eso es justo lo relevante — los strikes sin operar no tienen flujo
 * que interpretar.
 *
 * Por contrato nos quedamos con la fila MÁS RECIENTE (OI, precio, volumen y bid
 * del momento más actual). MarketSnack trae `open_interest` por fila, así que el
 * OI — que es lo que Massive nos quitó — vuelve por aquí.
 */
export async function fetchChainFromFlow(
  ticker: string,
  opts: { period?: string; maxPages?: number; onPage?: FetchFlowOptions["onPage"] } = {},
): Promise<FlowChainResult> {
  const clean = ticker.trim().toUpperCase();
  if (!clean) throw new MarketSnackError("Ticker vacío.");

  const { trades, pages, truncated } = await paginate(clean, {
    period: opts.period ?? "5d",
    maxPages: opts.maxPages ?? 25,
    onPage: opts.onPage,
  });

  // Fila más reciente por contrato (el OI/precio más actual gana).
  const latest = new Map<string, RawTrade>();
  let underlyingPrice: number | null = null;
  for (const t of trades) {
    if (!parseOcc(t.symbol)) continue;
    const prev = latest.get(t.symbol);
    if (!prev || Date.parse(t.timestamp) > Date.parse(prev.timestamp)) {
      latest.set(t.symbol, t);
    }
    if (typeof t.asset_price === "number" && t.asset_price > 0) {
      underlyingPrice = t.asset_price; // el último visto; trades vienen recientes→viejos
    }
  }

  const contracts: RawContract[] = [];
  for (const [symbol, t] of latest) {
    const occ = parseOcc(symbol)!;
    const price = t.price > 0 ? t.price : (t.bid_price > 0 ? t.bid_price : undefined);
    contracts.push({
      details: {
        contract_type: occ.type,
        expiration_date: occ.expiration,
        strike_price: occ.strike,
        shares_per_contract: 100,
        ticker: symbol,
      },
      open_interest: t.open_interest ?? 0,
      day: { volume: t.volume ?? 0, close: price, vwap: undefined },
      last_trade: { price },
      underlying_asset: { price: t.asset_price, ticker: clean },
    });
  }

  return { contracts, underlyingPrice, pages, truncated };
}

export interface FlowWheelQuote {
  strike: number;
  expiration: string;
  dte: number;
  bid: number | null;
  ask: number | null;
  lastTrade: number | null;
  openInterest: number;
}

export interface FlowWheelResult {
  spot: number | null;
  quotes: FlowWheelQuote[];
}

/**
 * Cadena de PUTS para el screener de Wheel, reconstruida desde el flujo de
 * MarketSnack cuando Massive ya no autoriza su snapshot (403). Preserva el
 * **bid** (lo que cobras al vender el cash-secured put) y el OI.
 *
 * Cobertura: solo puts que operaron en la ventana y caen en [dteMin, dteMax].
 * Puede ser más rala que la cadena completa de Massive — por eso el Wheel la
 * marca como respaldo. Filtra a OTM (strike ≤ spot), igual que la ruta Massive.
 */
export async function fetchWheelChainFromFlow(
  ticker: string,
  opts: { dteMin: number; dteMax: number; now?: Date },
): Promise<FlowWheelResult> {
  const clean = ticker.trim().toUpperCase();
  if (!clean) throw new MarketSnackError("Ticker vacío.");
  const now = opts.now ?? new Date();
  const day = 24 * 60 * 60 * 1000;
  const todayETMs = Date.parse(`${marketDateStr(now)}T00:00:00Z`);

  const { trades } = await paginate(clean, { period: "5d", maxPages: 25 });

  const latest = new Map<string, RawTrade>();
  let spot: number | null = null;
  for (const t of trades) {
    const occ = parseOcc(t.symbol);
    if (!occ || occ.type !== "put") continue;
    const prev = latest.get(t.symbol);
    if (!prev || Date.parse(t.timestamp) > Date.parse(prev.timestamp)) {
      latest.set(t.symbol, t);
    }
    if (typeof t.asset_price === "number" && t.asset_price > 0) spot = t.asset_price;
  }

  const quotes: FlowWheelQuote[] = [];
  for (const [symbol, t] of latest) {
    const occ = parseOcc(symbol)!;
    const dte = Math.round((Date.parse(`${occ.expiration}T00:00:00Z`) - todayETMs) / day);
    if (dte < opts.dteMin || dte > opts.dteMax) continue;
    quotes.push({
      strike: occ.strike,
      expiration: occ.expiration,
      dte,
      bid: t.bid_price > 0 ? t.bid_price : null,
      ask: t.ask_price > 0 ? t.ask_price : null,
      lastTrade: t.price > 0 ? t.price : null,
      openInterest: t.open_interest ?? 0,
    });
  }

  // Solo puts OTM (strike ≤ spot), igual que la ruta de Massive.
  const otm = spot != null ? quotes.filter((q) => q.strike <= spot!) : quotes;
  return { spot, quotes: otm };
}

/** Cuerpo de paginación compartido. `symbol === null` → escaneo de todo el mercado. */
async function paginate(
  symbol: string | null,
  opts: FetchFlowOptions = {},
): Promise<FlowResult> {
  const clean = symbol;
  const period = opts.period ?? "5d";
  const maxPages = opts.maxPages ?? 10;
  const cookieHeader = cookie();

  const trades: RawTrade[] = [];
  let token: string | null = null;
  let page = 0;
  let truncated = false;
  // La paginación del feed camina hacia atrás en el tiempo; con targetDays paramos
  // al cubrir la ventana pedida.
  const cutoffMs = opts.targetDays ? Date.now() - opts.targetDays * 86_400_000 : null;

  do {
    page += 1;
    const params = new URLSearchParams();
    params.set("filter[scope]", "all");
    if (clean) params.append("filter[symbol][]", clean);
    params.set("period", period);
    if (opts.minPremium && opts.minPremium > 0) {
      params.set("filter[premium][gte]", String(Math.floor(opts.minPremium)));
    }
    if (token) params.set("next_page_token", token);
    const url = `${BASE_URL}/api/flow_feed?${params.toString()}`;

    const res = await fetch(url, {
      headers: { Accept: "application/json", Cookie: cookieHeader },
      cache: "no-store",
      redirect: "manual",
    });

    // Sesión inválida/expirada → MarketSnack redirige a /login o responde 401.
    if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)) {
      throw new MarketSnackError(
        "Sesión de MarketSnack inválida o expirada. Actualiza MARKETSNACK_COOKIE en .env.local.",
        res.status,
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new MarketSnackError(
        `MarketSnack respondió ${res.status}. ${body.slice(0, 200)}`.trim(),
        res.status,
      );
    }

    const json: { list?: RawTrade[]; meta?: { next_page_token?: string } } =
      await res.json();
    const list = json.list ?? [];
    trades.push(...list);
    await opts.onPage?.(page, trades.length);

    token = json.meta?.next_page_token ?? null;
    if (list.length === 0) break;
    if (cutoffMs != null) {
      const oldest = list[list.length - 1]?.timestamp;
      if (oldest && Date.parse(oldest) < cutoffMs) break; // ventana cubierta
    }
    if (page >= maxPages) {
      truncated = Boolean(token);
      break;
    }
  } while (token);

  return { trades, pages: page, truncated };
}
