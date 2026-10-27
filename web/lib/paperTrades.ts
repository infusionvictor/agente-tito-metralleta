// Mis Trades — bitácora de paper trading CONDICIONAL. Todo esto es SIMULACIÓN:
// nunca coloca una orden real ni promete ganancia. Funciones puras (persistencia
// en `paperTradesStore.ts`).
//
// Modelo de dos niveles, porque son dos cosas distintas:
//   - `entryTrigger` es un nivel del SUBYACENTE (una resistencia/soporte/nodo GEX):
//     el trade sigue "pendiente" hasta que el precio del subyacente lo cruza.
//   - `target`/`stop`/el P&L son en precio de la OPCIÓN (prima): así se calcula
//     P&L = (salida − entrada) × 100 × contratos, como pide la bitácora.
//
// El trailing stop solo APRIETA (nunca baja el piso inicial): el pico de la prima
// desde que el trade está activo define un stop dinámico = pico × (1 − trailingPct),
// y el stop efectivo es el máximo entre ese nivel y el stop fijo original — así un
// stop fijo no se come una ganancia que ya se había alcanzado.

export type ContractType = "call" | "put";
export type Direction = "up" | "down";
export type TradeStatus = "pending" | "active" | "won" | "lost" | "expired";
export type TradeSource = "manual" | "auto";
export type CloseReason = "target" | "stop" | "trailing_stop" | "expiration";
/** Vía del piloto que armó el trade AUTO — null para trades manuales. */
export type TradePath = "intraday" | "swing";

export interface PaperTrade {
  id: string;
  ticker: string;
  contractType: ContractType;
  strike: number;
  expiration: string; // YYYY-MM-DD
  direction: Direction; // qué apuesta el trade sobre el SUBYACENTE
  entryTrigger: number; // nivel del subyacente que activa la entrada
  target: number; // precio de la opción, objetivo
  stop: number; // precio de la opción, stop fijo inicial
  trailingStopPct: number | null; // % de retroceso desde el pico que asegura ganancia
  probability: number | null; // 0-100, si viene de un setup con probabilidad estimada
  contracts: number;
  source: TradeSource;
  path: TradePath | null;
  note: string | null;

  status: TradeStatus;
  entryPrice: number | null; // precio de la opción al activarse
  exitPrice: number | null;
  lastPrice: number | null; // última cotización vista, para el P&L flotante mientras está activa
  peakPrice: number | null; // precio de opción más alto visto desde que está activa
  stopPrice: number | null; // stop EFECTIVO actual (fijo, o el dinámico si ya apretó)
  closeReason: CloseReason | null;
  verdict: string | null;

  createdAt: string;
  triggeredAt: string | null;
  closedAt: string | null;
  updatedAt: string;
}

export interface TradeInput {
  ticker: string;
  contractType: ContractType;
  strike: number;
  expiration: string;
  direction: Direction;
  entryTrigger: number;
  target: number;
  stop: number;
  trailingStopPct?: number | null;
  probability?: number | null;
  contracts: number;
  source?: TradeSource;
  path?: TradePath | null;
  note?: string | null;
}

export interface Quote {
  underlyingPrice: number | null;
  optionPrice: number | null; // mid, o el mejor precio disponible de la opción
}

function genId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `pt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createTrade(input: TradeInput, now: Date = new Date()): PaperTrade {
  const nowIso = now.toISOString();
  return {
    id: genId(),
    ticker: input.ticker.trim().toUpperCase(),
    contractType: input.contractType,
    strike: input.strike,
    expiration: input.expiration,
    direction: input.direction,
    entryTrigger: input.entryTrigger,
    target: input.target,
    stop: input.stop,
    trailingStopPct: input.trailingStopPct ?? null,
    probability: input.probability ?? null,
    contracts: input.contracts,
    source: input.source ?? "manual",
    path: input.path ?? null,
    note: input.note ?? null,

    status: "pending",
    entryPrice: null,
    exitPrice: null,
    lastPrice: null,
    peakPrice: null,
    stopPrice: null,
    closeReason: null,
    verdict: null,

    createdAt: nowIso,
    triggeredAt: null,
    closedAt: null,
    updatedAt: nowIso,
  };
}

/** P&L en dólares: (salida − entrada) × 100 × contratos. */
export function computePnl(entryPrice: number, exitPrice: number, contracts: number): number {
  return (exitPrice - entryPrice) * 100 * contracts;
}

function isPastExpiration(expiration: string, now: Date): boolean {
  return Date.parse(`${expiration}T23:59:59Z`) < now.getTime();
}

const money = (n: number) => `$${n.toFixed(2)}`;

function verdictFor(
  reason: CloseReason,
  won: boolean,
  entryPrice: number,
  exitPrice: number,
  peakPrice: number | null,
  target: number,
  stop: number,
): string {
  switch (reason) {
    case "target":
      return `Llegó al objetivo: la opción tocó ${money(target)}, cerrada en ${money(exitPrice)}.`;
    case "stop":
      return `Tocó el stop: la opción cayó a ${money(exitPrice)} (stop en ${money(stop)}).`;
    case "trailing_stop":
      return won
        ? `Aseguró ganancia con el stop dinámico: subió hasta ${money(peakPrice ?? exitPrice)} y cerró en ${money(exitPrice)} (entrada ${money(entryPrice)}).`
        : `El stop dinámico cerró la posición en ${money(exitPrice)} tras un pico de ${money(peakPrice ?? exitPrice)}.`;
    case "expiration":
      return won
        ? `Expiró en cartera con ganancia: ${money(exitPrice)} vs. entrada ${money(entryPrice)}, sin llegar al objetivo ni al stop.`
        : `Expiró en cartera sin llegar al objetivo ni al stop: cerró en ${money(exitPrice)} (entrada ${money(entryPrice)}).`;
  }
}

function closeActive(
  trade: PaperTrade,
  exitPrice: number,
  reason: CloseReason,
  now: Date,
): PaperTrade {
  const entryPrice = trade.entryPrice ?? exitPrice;
  const pnl = computePnl(entryPrice, exitPrice, trade.contracts);
  const won = pnl >= 0;
  return {
    ...trade,
    status: won ? "won" : "lost",
    exitPrice,
    closeReason: reason,
    closedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    verdict: verdictFor(reason, won, entryPrice, exitPrice, trade.peakPrice, trade.target, trade.stop),
  };
}

function closeExpiredPending(trade: PaperTrade, now: Date): PaperTrade {
  return {
    ...trade,
    status: "expired",
    closeReason: "expiration",
    closedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    verdict: "Expiró sin activarse: el subyacente nunca cruzó el gatillo de entrada.",
  };
}

/**
 * Avanza un trade un paso según la cotización actual. PURA — no toca red ni disco.
 * Trades que no están `pending` ni `active` se devuelven sin cambios.
 */
export function evaluateTrade(trade: PaperTrade, quote: Quote, now: Date = new Date()): PaperTrade {
  if (trade.status !== "pending" && trade.status !== "active") return trade;
  const expired = isPastExpiration(trade.expiration, now);

  if (trade.status === "pending") {
    const crossed =
      quote.underlyingPrice != null &&
      (trade.direction === "up"
        ? quote.underlyingPrice >= trade.entryTrigger
        : quote.underlyingPrice <= trade.entryTrigger);

    if (!crossed) {
      return expired ? closeExpiredPending(trade, now) : trade;
    }

    const entryPrice = quote.optionPrice;
    return {
      ...trade,
      status: "active",
      entryPrice,
      lastPrice: entryPrice,
      peakPrice: entryPrice,
      stopPrice: trade.stop,
      triggeredAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
  }

  // status === "active"
  if (quote.optionPrice == null) {
    if (expired) {
      const last = trade.peakPrice ?? trade.entryPrice ?? trade.stop;
      return closeActive(trade, last, "expiration", now);
    }
    return trade;
  }

  const price = quote.optionPrice;
  const peak = Math.max(trade.peakPrice ?? trade.entryPrice ?? price, price);
  let stopPrice = trade.stop;
  if (trade.trailingStopPct != null && trade.entryPrice != null) {
    const trailingLevel = peak * (1 - trade.trailingStopPct / 100);
    stopPrice = Math.max(trade.stop, trailingLevel);
  }
  const advancing = { ...trade, peakPrice: peak, stopPrice, lastPrice: price };

  if (price >= trade.target) {
    return closeActive(advancing, price, "target", now);
  }
  if (price <= stopPrice) {
    const reason: CloseReason = stopPrice > trade.stop ? "trailing_stop" : "stop";
    return closeActive(advancing, price, reason, now);
  }
  if (expired) {
    return closeActive(advancing, price, "expiration", now);
  }
  return { ...advancing, updatedAt: now.toISOString() };
}

export interface TradeStats {
  netPnl: number;
  wins: number;
  losses: number;
  winRate: number | null; // 0-100, null si no hay cerrados con P&L
  pending: number;
  active: number;
  expired: number;
}

/** Estadísticas agregadas. `expired` (nunca se activaron) no cuentan como W/L. */
export function computeStats(trades: PaperTrade[]): TradeStats {
  let netPnl = 0;
  let wins = 0;
  let losses = 0;
  let pending = 0;
  let active = 0;
  let expired = 0;

  for (const t of trades) {
    if (t.status === "pending") pending++;
    else if (t.status === "active") active++;
    else if (t.status === "expired") expired++;
    else if (t.status === "won" || t.status === "lost") {
      if (t.entryPrice != null && t.exitPrice != null) {
        netPnl += computePnl(t.entryPrice, t.exitPrice, t.contracts);
      }
      if (t.status === "won") wins++;
      else losses++;
    }
  }

  const closed = wins + losses;
  return {
    netPnl,
    wins,
    losses,
    winRate: closed > 0 ? (wins / closed) * 100 : null,
    pending,
    active,
    expired,
  };
}

export interface StatsBreakdown {
  overall: TradeStats;
  manual: TradeStats;
  auto: TradeStats;
  autoIntraday: TradeStats;
  autoSwing: TradeStats;
}

/**
 * Certeza por segmento — separa lo que decidiste vos de lo que decidió el piloto,
 * y dentro del piloto, por vía (intradía vs swing), para poder juzgar cada una por
 * su propio historial en vez de mezclarlas en un solo número.
 */
export function computeStatsBreakdown(trades: PaperTrade[]): StatsBreakdown {
  const manual = trades.filter((t) => t.source === "manual");
  const auto = trades.filter((t) => t.source === "auto");
  return {
    overall: computeStats(trades),
    manual: computeStats(manual),
    auto: computeStats(auto),
    autoIntraday: computeStats(auto.filter((t) => t.path === "intraday")),
    autoSwing: computeStats(auto.filter((t) => t.path === "swing")),
  };
}
