// Sugeridor de spreads de crédito para venta de prima. PURO y testeable.
// Automatiza el cálculo manual: elige el short strike por delta objetivo (fuera del move
// esperado), compra el ala a `width`, y reporta crédito / máx pérdida / break-even / R/R /
// prob OTM / fuerza del muro más cercano.
// Ver docs/superpowers/specs/2026-07-27-earnings-iv-crush-design.md

export interface OptionQuote {
  strike: number;
  type: "call" | "put";
  /** último precio o mid, por acción. */
  price: number;
  /** delta firmado (puts negativo). |delta| ≈ prob. de terminar ITM. */
  delta: number;
  oi: number;
}

export interface LevelLite {
  price: number;
  strength: number; // 0-100
}

export type SpreadKind = "bull_put" | "bear_call";

export interface Spread {
  kind: SpreadKind;
  shortStrike: number;
  longStrike: number;
  width: number;
  /** crédito neto por acción. */
  credit: number;
  /** máxima pérdida por spread, en $. */
  maxLoss: number;
  breakeven: number;
  /** crédito ÷ riesgo (0.20 = arriesgas 5 para ganar 1). */
  riskReward: number;
  /** prob. de quedar OTM (te quedas el crédito), en %. */
  probOTM: number;
  /** fuerza del muro (soporte/resistencia) más cercano al short strike, si hay. */
  shortWallStrength: number | null;
}

export interface SuggestOpts {
  targetDelta?: number; // delta |Δ| objetivo del short (default 0.20)
  width?: number; // ancho deseado del spread en $ (default 5)
  /** múltiplo de σ que el short debe superar como mínimo (default 1 = fuera de 1σ). */
  minSigma?: number;
}

function nearestStrength(levels: LevelLite[], strike: number): number | null {
  if (levels.length === 0) return null;
  let best = levels[0];
  for (const l of levels) {
    if (Math.abs(l.price - strike) < Math.abs(best.price - strike)) best = l;
  }
  // solo cuenta si el muro está razonablemente cerca (±3% del strike)
  return Math.abs(best.price - strike) / strike <= 0.03 ? best.strength : null;
}

function closestStrike(strikes: number[], target: number): number | null {
  if (strikes.length === 0) return null;
  return strikes.reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a));
}

function buildSpread(
  kind: SpreadKind,
  quotes: OptionQuote[],
  shortStrike: number,
  width: number,
  walls: LevelLite[],
): Spread | null {
  const isPut = kind === "bull_put";
  const legType = isPut ? "put" : "call";
  const byStrike = new Map(
    quotes.filter((q) => q.type === legType).map((q) => [q.strike, q]),
  );
  const short = byStrike.get(shortStrike);
  if (!short) return null;

  // El ala protectora va MÁS OTM: puts hacia abajo, calls hacia arriba.
  const strikes = [...byStrike.keys()];
  const longTarget = isPut ? shortStrike - width : shortStrike + width;
  const longStrike = closestStrike(
    strikes.filter((s) => (isPut ? s < shortStrike : s > shortStrike)),
    longTarget,
  );
  if (longStrike == null) return null;
  const long = byStrike.get(longStrike);
  if (!long) return null;

  const realWidth = Math.abs(shortStrike - longStrike);
  const credit = short.price - long.price;
  if (credit <= 0 || realWidth <= 0) return null;

  const maxLoss = Math.max((realWidth - credit) * 100, 0);
  const breakeven = isPut ? shortStrike - credit : shortStrike + credit;
  const probOTM = Math.max(0, Math.min(100, (1 - Math.abs(short.delta)) * 100));
  const riskReward = maxLoss > 0 ? (credit * 100) / maxLoss : Infinity;

  return {
    kind,
    shortStrike,
    longStrike,
    width: realWidth,
    credit: round2(credit),
    maxLoss: Math.round(maxLoss),
    breakeven: round2(breakeven),
    riskReward: round2(riskReward),
    probOTM: Math.round(probOTM),
    shortWallStrength: nearestStrength(walls, shortStrike),
  };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/**
 * Elige el short strike por delta objetivo, exigiendo que quede fuera del move de 1σ.
 * Para puts busca hacia abajo (strike < spot); para calls hacia arriba.
 */
function pickShort(
  quotes: OptionQuote[],
  type: "put" | "call",
  spot: number,
  sigmaAbs: number,
  targetDelta: number,
): number | null {
  const isPut = type === "put";
  const floorCeil = isPut ? spot - sigmaAbs : spot + sigmaAbs; // borde del move 1σ
  const cands = quotes
    .filter((q) => q.type === type && q.price > 0)
    .filter((q) => (isPut ? q.strike < spot : q.strike > spot)) // OTM
    .filter((q) => (isPut ? q.strike <= floorCeil : q.strike >= floorCeil)) // fuera de 1σ
    .filter((q) => Math.abs(q.delta) <= targetDelta);
  if (cands.length === 0) return null;
  // el más cercano al dinero dentro de lo permitido = mayor prima al riesgo objetivo
  // (put: mayor strike; call: menor strike)
  cands.sort((a, b) => (isPut ? b.strike - a.strike : a.strike - b.strike));
  return cands[0].strike;
}

/** Short en ±Nσ (la cola), sin importar el delta: el strike más cercano al nivel Nσ. */
function pickShortAtSigma(
  quotes: OptionQuote[],
  type: "put" | "call",
  spot: number,
  sigma1Abs: number,
  sigmaMult: number,
): number | null {
  const isPut = type === "put";
  const target = isPut ? spot - sigmaMult * sigma1Abs : spot + sigmaMult * sigma1Abs;
  const cands = quotes.filter(
    (q) => q.type === type && q.price > 0 && (isPut ? q.strike < spot : q.strike > spot),
  );
  if (cands.length === 0) return null;
  return cands.reduce((a, b) =>
    Math.abs(b.strike - target) < Math.abs(a.strike - target) ? b : a,
  ).strike;
}

/**
 * Spreads con el short en ±Nσ (las colas), para venta de prima en los extremos.
 * A diferencia del modo delta, aquí el strike lo fija la desviación estándar.
 */
export function suggestSpreadsAtSigma(
  quotes: OptionQuote[],
  spot: number,
  walls: { supports: LevelLite[]; resistances: LevelLite[] },
  expectedMove1SigmaPct: number,
  opts: { sigmaMult?: number; width?: number } = {},
): { putSpread: Spread | null; callSpread: Spread | null } {
  const sigmaMult = opts.sigmaMult ?? 2;
  const width = opts.width ?? 5;
  const sigma1Abs = (expectedMove1SigmaPct / 100) * spot;

  const putShort = pickShortAtSigma(quotes, "put", spot, sigma1Abs, sigmaMult);
  const callShort = pickShortAtSigma(quotes, "call", spot, sigma1Abs, sigmaMult);

  return {
    putSpread:
      putShort != null ? buildSpread("bull_put", quotes, putShort, width, walls.supports) : null,
    callSpread:
      callShort != null
        ? buildSpread("bear_call", quotes, callShort, width, walls.resistances)
        : null,
  };
}

export function suggestCreditSpreads(
  quotes: OptionQuote[],
  spot: number,
  walls: { supports: LevelLite[]; resistances: LevelLite[] },
  expectedMove1SigmaPct: number,
  opts: SuggestOpts = {},
): { putSpread: Spread | null; callSpread: Spread | null; ironCondor: { put: Spread; call: Spread } | null } {
  const targetDelta = opts.targetDelta ?? 0.2;
  const width = opts.width ?? 5;
  const minSigma = opts.minSigma ?? 1;
  const sigmaAbs = (expectedMove1SigmaPct / 100) * spot * minSigma;

  const putShort = pickShort(quotes, "put", spot, sigmaAbs, targetDelta);
  const callShort = pickShort(quotes, "call", spot, sigmaAbs, targetDelta);

  const putSpread =
    putShort != null ? buildSpread("bull_put", quotes, putShort, width, walls.supports) : null;
  const callSpread =
    callShort != null ? buildSpread("bear_call", quotes, callShort, width, walls.resistances) : null;

  const ironCondor = putSpread && callSpread ? { put: putSpread, call: callSpread } : null;

  return { putSpread, callSpread, ironCondor };
}
