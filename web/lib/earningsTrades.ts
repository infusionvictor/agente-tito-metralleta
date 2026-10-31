// Tracking post-earnings de trades de venta de prima. PURO y testeable.
// Revisa cada spread contra el precio real al vencimiento (¿ganó?, ¿P&L?) y agrega tus
// estadísticas: win rate, crédito promedio capturado, y si la richness al entrar predice
// el resultado. Convierte la experiencia del usuario en datos.
// Ver docs/superpowers/specs/2026-07-27-earnings-iv-crush-design.md

import type { DailyBar } from "./earningsMove";

export interface EarningsTrade {
  id: string;
  ticker: string;
  kind: "bull_put" | "bear_call";
  shortStrike: number;
  longStrike: number;
  width: number;
  /** crédito por acción cobrado al abrir. */
  credit: number;
  /** máxima pérdida por spread, en $. */
  maxLoss: number;
  contracts: number;
  entryDate: string; // YYYY-MM-DD
  entrySpot: number;
  expiration: string; // YYYY-MM-DD
  richnessAtEntry: number | null;
  impliedAtEntry: number | null;
}

export type Outcome = "win" | "loss" | "open";

export interface TradeReview {
  id: string;
  ticker: string;
  outcome: Outcome;
  /** P&L realizado de la posición completa, en $. null si sigue abierto. */
  pnl: number | null;
  /** P&L como % del riesgo (maxLoss·contratos). */
  pnlPct: number | null;
  finalSpot: number | null;
  /** ¿el precio cruzó el short strike? */
  breached: boolean;
  /** movimiento real del subyacente entrada→vencimiento, en %. */
  actualMovePct: number | null;
  daysHeld: number | null;
}

/** Valor del spread al vencimiento (lo que costaría recomprarlo), por acción. */
function spreadValueAtExpiry(t: EarningsTrade, s: number): number {
  const intrinsic = t.kind === "bull_put" ? t.shortStrike - s : s - t.shortStrike;
  return Math.min(Math.max(intrinsic, 0), t.width);
}

/**
 * Revisa un trade contra las barras diarias. Si el vencimiento aún no llegó → "open".
 */
export function reviewTrade(t: EarningsTrade, bars: DailyBar[]): TradeReview {
  const sorted = [...bars].sort((a, b) => (a.time < b.time ? -1 : 1));
  const expBar = sorted.find((b) => b.time >= t.expiration);

  const base: TradeReview = {
    id: t.id,
    ticker: t.ticker,
    outcome: "open",
    pnl: null,
    pnlPct: null,
    finalSpot: null,
    breached: false,
    actualMovePct: null,
    daysHeld: null,
  };

  if (!expBar) return base; // aún no vence

  const s = expBar.close;
  const perShare = t.credit - spreadValueAtExpiry(t, s);
  const pnl = perShare * 100 * t.contracts;
  const risk = t.maxLoss * t.contracts;
  const breached = t.kind === "bull_put" ? s < t.shortStrike : s > t.shortStrike;
  const daysHeld = Math.round(
    (Date.parse(`${expBar.time}T00:00:00Z`) - Date.parse(`${t.entryDate}T00:00:00Z`)) /
      86_400_000,
  );

  return {
    ...base,
    outcome: pnl >= 0 ? "win" : "loss",
    pnl: Math.round(pnl),
    pnlPct: risk > 0 ? Math.round((pnl / risk) * 100) : null,
    finalSpot: s,
    breached,
    actualMovePct:
      t.entrySpot > 0 ? Math.abs((s - t.entrySpot) / t.entrySpot) * 100 : null,
    daysHeld,
  };
}

export interface TradeStats {
  total: number;
  closed: number;
  open: number;
  wins: number;
  losses: number;
  winRate: number | null; // %
  totalPnl: number;
  avgCreditCaptured: number | null; // crédito promedio cobrado ($/spread)
  /** richness promedio de entrada de los ganadores vs perdedores (¿predice?). */
  avgRichnessWin: number | null;
  avgRichnessLoss: number | null;
}

function avg(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export function aggregateStats(trades: EarningsTrade[], reviews: TradeReview[]): TradeStats {
  const byId = new Map(reviews.map((r) => [r.id, r]));
  const closed = reviews.filter((r) => r.outcome !== "open");
  const wins = closed.filter((r) => r.outcome === "win");
  const losses = closed.filter((r) => r.outcome === "loss");

  const richOf = (rs: TradeReview[]) =>
    rs
      .map((r) => trades.find((t) => t.id === r.id)?.richnessAtEntry)
      .filter((x): x is number => x != null);

  return {
    total: trades.length,
    closed: closed.length,
    open: reviews.length - closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length ? Math.round((wins.length / closed.length) * 100) : null,
    totalPnl: Math.round(closed.reduce((a, r) => a + (r.pnl ?? 0), 0)),
    avgCreditCaptured: avg(
      trades.filter((t) => byId.get(t.id)?.outcome === "win").map((t) => t.credit * 100),
    ),
    avgRichnessWin: avg(richOf(wins)),
    avgRichnessLoss: avg(richOf(losses)),
  };
}
