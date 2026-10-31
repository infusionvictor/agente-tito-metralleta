// Earnings IV-Crush — move implícito vs histórico. PURO y testeable.
// El edge de vender prima en earnings NO es "la IV está alta", sino:
//   ¿el move que precia la IV hoy (implícito) es MAYOR que el que la acción
//    realmente hace en sus earnings (histórico)?  Si sí → la IV está rica → vender.
// Ver docs/superpowers/specs/2026-07-27-earnings-iv-crush-design.md

export interface DailyBar {
  time: string; // "YYYY-MM-DD"
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface StraddleInput {
  /** Precio del call ATM del primer vencimiento POST-earnings. */
  callPrice?: number;
  /** Precio del put ATM del primer vencimiento POST-earnings. */
  putPrice?: number;
  spot: number;
  /** IV del ATM en decimal (0.68 = 68%), como respaldo si no hay straddle. */
  atmIv?: number;
  /** Días al vencimiento, para el método IV·√(T). */
  dteDays?: number;
}

export type Verdict = "rica" | "justa" | "barata" | "sin_datos";

export interface Richness {
  impliedMovePct: number | null;
  histAvgMovePct: number | null;
  histMedianPct: number | null;
  histMaxPct: number | null;
  /** implícito ÷ histórico promedio. >1 = la IV precia más de lo que suele moverse. */
  richness: number | null;
  /** nº de earnings pasados con dato usable. */
  sample: number;
  verdict: Verdict;
}

const MIN_SAMPLE = 4; // menos de esto → no confiamos en el histórico
const RICH = 1.15; // implícito ≥ 15% sobre el histórico → rica
const CHEAP = 0.85; // implícito ≤ 85% del histórico → barata

/**
 * Move implícito del evento. Preferimos el **straddle ATM** (call+put)/spot, que es la
 * aproximación estándar del movimiento esperado; si no hay precios, caemos a IV·√(T/365).
 */
export function impliedEarningsMove(
  s: StraddleInput,
): { impliedMovePct: number; method: "straddle" | "iv" } | null {
  if (s.spot > 0 && (s.callPrice ?? 0) > 0 && (s.putPrice ?? 0) > 0) {
    return {
      impliedMovePct: ((s.callPrice! + s.putPrice!) / s.spot) * 100,
      method: "straddle",
    };
  }
  if (s.spot > 0 && s.atmIv && s.dteDays && s.dteDays > 0) {
    return {
      impliedMovePct: s.atmIv * Math.sqrt(s.dteDays / 365) * 100,
      method: "iv",
    };
  }
  return null;
}

export interface QuoteLite {
  strike: number;
  type: "call" | "put";
  price: number;
}

/**
 * Straddle ATM: el strike más cercano al spot que tenga call Y put con precio, y sus
 * precios. Puro para poder derivar el move implícito desde una cadena ya obtenida.
 */
export function atmStraddle(
  quotes: QuoteLite[],
  spot: number,
): { strike: number; callPrice: number; putPrice: number } | null {
  if (!(spot > 0)) return null;
  const strikes = [...new Set(quotes.map((q) => q.strike))].sort(
    (a, b) => Math.abs(a - spot) - Math.abs(b - spot),
  );
  for (const k of strikes) {
    const c = quotes.find((q) => q.strike === k && q.type === "call" && q.price > 0);
    const p = quotes.find((q) => q.strike === k && q.type === "put" && q.price > 0);
    if (c && p) return { strike: k, callPrice: c.price, putPrice: p.price };
  }
  return null;
}

/**
 * IV del ATM (decimal): el strike más cercano al spot CON IV, exigiendo que esté dentro
 * del ±7% del spot. El guardarraíl evita el bug de tomar un strike lejano mal-priced
 * (que inflaba el "move implícito"); si no hay ATM con IV, devuelve null → sin datos.
 */
export function atmIv(
  quotes: { strike: number; type: "call" | "put"; iv?: number | null }[],
  spot: number,
): number | null {
  if (!(spot > 0)) return null;
  const near = quotes.filter(
    (q) => q.iv != null && q.iv > 0 && Math.abs(q.strike - spot) / spot <= 0.07,
  );
  if (near.length === 0) return null;
  const k = [...new Set(near.map((q) => q.strike))].sort(
    (a, b) => Math.abs(a - spot) - Math.abs(b - spot),
  )[0];
  const ivs = near.filter((q) => q.strike === k).map((q) => q.iv as number);
  // Por put-call parity, call IV ≈ put IV en el ATM. Si divergen mucho, un lado está
  // corrupto (data stale/mal-solveada, ej. un put con IV 480%). Usamos el MÍNIMO para
  // no dejar que el lado inflado arrastre el resultado.
  return Math.min(...ivs);
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Move histórico de cada earnings pasado. Para cada fecha, tomamos el **mayor** movimiento
 * absoluto close-a-close entre el día del reporte y el siguiente — así captura tanto los
 * reportes "after market close" (reacción al día siguiente) como los "before open" (mismo día),
 * sin necesitar la hora exacta.
 */
export function historicalEarningsMoves(
  bars: DailyBar[],
  earningsDates: string[],
): { moves: number[]; avg: number; median: number; max: number; sample: number } {
  const sorted = [...bars].sort((a, b) => (a.time < b.time ? -1 : 1));
  const moves: number[] = [];

  for (const date of earningsDates) {
    // primer bar en o después de la fecha del reporte
    const i = sorted.findIndex((b) => b.time >= date);
    if (i <= 0 || i >= sorted.length) continue; // sin bar previo o sin datos → se salta
    const prev = sorted[i - 1];
    const day = sorted[i];
    const next = i + 1 < sorted.length ? sorted[i + 1] : null;

    const mDay =
      prev.close > 0 ? Math.abs((day.close - prev.close) / prev.close) * 100 : 0;
    const mNext =
      next && day.close > 0
        ? Math.abs((next.close - day.close) / day.close) * 100
        : 0;
    const move = Math.max(mDay, mNext);
    if (move > 0) moves.push(move);
  }

  const avg = moves.length ? moves.reduce((a, b) => a + b, 0) / moves.length : 0;
  const max = moves.length ? Math.max(...moves) : 0;
  return { moves, avg, median: median(moves), max, sample: moves.length };
}

/** Junta implícito + histórico en el veredicto de "IV rica / justa / barata". */
export function earningsRichness(
  impliedMovePct: number | null,
  hist: { avg: number; median: number; max: number; sample: number },
): Richness {
  const base: Richness = {
    impliedMovePct,
    histAvgMovePct: hist.sample ? hist.avg : null,
    histMedianPct: hist.sample ? hist.median : null,
    histMaxPct: hist.sample ? hist.max : null,
    richness: null,
    sample: hist.sample,
    verdict: "sin_datos",
  };

  if (hist.sample < MIN_SAMPLE || impliedMovePct == null || hist.avg <= 0) {
    return base;
  }

  const richness = impliedMovePct / hist.avg;
  const verdict: Verdict =
    richness >= RICH ? "rica" : richness <= CHEAP ? "barata" : "justa";
  return { ...base, richness, verdict };
}
