// Panel de riesgo — cuánto puede poner el usuario en un flow sin volarse la cuenta.
//
// Dos capas en cascada:
//   1. Calidad del contrato — ¿es operable o es lotería? (`passesQualityFilter`)
//   2. Sizing contra la cuenta — ¿cuántos contratos caben? (`sizeFlow`)
//
// Regla heredada de CLAUDE.md: nunca dimensionar una opción ilíquida. Ante la duda,
// se bloquea y se explica el motivo — el panel devuelve un TECHO ("tu límite es N"),
// nunca una recomendación de compra.
//
// Funciones puras: reciben el FlowRow ya clasificado y el perfil, no tocan red ni disco.

import { unusualTradeScore, type FlowRow } from "./flow";

/** Perfil del usuario. Vive en localStorage: el saldo nunca llega al servidor. */
export interface RiskProfile {
  accountSize: number;
  /** % de la cuenta que acepta arriesgar por trade (el slider). */
  tolerancePct: number;
}

/**
 * Techo de decaimiento diario para considerar un contrato operable, en % de su
 * propia prima. Es la banda de `thetaScore` (SCOREDCARD/Inusualidad.md): por
 * encima del 5% el documento le da 0 puntos — es lotería, no posición.
 */
export const MAX_THETA_PCT_DAILY = 5;

/**
 * Presupuesto de quema de theta, en % de la CUENTA.
 *
 * Va aparte de la tolerancia a propósito. Si compartiera presupuesto con la prima
 * el límite por theta jamás podría frenar: como la quema se topa en el costo del
 * contrato (una opción larga no puede perder más que su prima), `presupuesto/quema`
 * siempre sería ≥ `presupuesto/costo` y el `min` elegiría la prima el 100% de las
 * veces. Con su propio presupuesto —anclado a la banda 3-5% del documento de
 * Inusualidad— el theta frena de verdad cuando la tolerancia sube por encima del 5%.
 */
export const THETA_BUDGET_PCT = 5;

/**
 * Días mínimos al vencimiento para que valga la pena mirarlo. Bajo a propósito
 * (contratos "más cercanos"): permite semanales/near-term, pero sigue tumbando
 * los 0DTE / "expira_hoy" —que van por `expiryStatus`— por ser pura lotería.
 */
export const MIN_DTE = 2;

/**
 * Umbral de inusualidad SOLO para el screener de ideas (`isTradeableIdea`).
 * Más laxo que el institucional (`UNUSUAL_TRADE_THRESHOLD = 7` en flow.ts, que
 * define el scorecard): con un piso de premium más bajo, el puntaje de tamaño ya
 * no basta para llegar a 7, así que aquí basta con un 5 para dejar pasar flujo
 * direccional de tamaño mediano. No toca la definición institucional del dashboard.
 */
export const IDEA_UNUSUAL_THRESHOLD = 5;

/**
 * Cercanía máxima del strike al precio del subyacente, |strike − spot| / spot.
 * Contratos "más cercanos": descarta lo muy OTM (lotería barata) y lo muy ITM
 * (caro y sin apalancamiento). 0.25 = dentro del ±25% del precio actual.
 */
export const MONEYNESS_CAP = 0.25;

/** Un contrato son 100 acciones. */
const MULTIPLIER = 100;

export type BlockReason = "iliquidez" | "theta_alto" | "sin_theta" | "vencido";
export type Binding = "prima" | "theta";

export interface Budgets {
  /** Máximo capital a desplegar (pérdida máxima aceptada), en $. */
  premium: number;
  /** Máxima quema de theta en el horizonte, en $. */
  theta: number;
}

export interface Sizing {
  /** El TECHO de contratos. 0 si algo lo bloquea. */
  maxContracts: number;
  /** Cuál de las dos restricciones produjo el techo. */
  binding: Binding | null;
  costPerContract: number;
  totalCost: number;
  costPctOfAccount: number;
  /** Días sobre los que se calcula la quema: min(dte, horizonte). */
  burnDays: number;
  thetaBurnPerContract: number;
  totalBurn: number;
  burnPctOfAccount: number;
  /** La quema alcanzó el costo: el contrato se consume entero dentro del horizonte. */
  fullyDecays: boolean;
  blocked: { reason: BlockReason; detail: string } | null;
}

/** Número finito y no negativo, o 0. Blinda contra NaN/Infinity de inputs de UI. */
function safe(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function budgetsOf(profile: RiskProfile): Budgets {
  const account = safe(profile?.accountSize);
  const tolerance = safe(profile?.tolerancePct);
  return {
    premium: (account * tolerance) / 100,
    theta: (account * THETA_BUDGET_PCT) / 100,
  };
}

export interface QualityResult {
  ok: boolean;
  reason?: BlockReason;
  detail?: string;
}

/**
 * Capa 1 — ¿el contrato es operable? Filtra antes de que el sizing lo toque.
 * No estima theta: si MarketSnack no lo trajo, el flow no se dimensiona.
 */
export function passesQualityFilter(row: FlowRow): QualityResult {
  if (row.thetaPctDaily == null) {
    return { ok: false, reason: "sin_theta", detail: "El feed no trajo theta para este contrato." };
  }
  if (row.expiryStatus === "expirado" || row.expiryStatus === "expira_hoy") {
    return { ok: false, reason: "vencido", detail: "El contrato ya venció o vence hoy." };
  }
  if (row.dte == null || row.dte < MIN_DTE) {
    return {
      ok: false,
      reason: "vencido",
      detail: `Vence en menos de ${MIN_DTE} días: no da tiempo a que el movimiento se desarrolle.`,
    };
  }
  if (row.thetaPctDaily > MAX_THETA_PCT_DAILY) {
    return {
      ok: false,
      reason: "theta_alto",
      detail: `Pierde ${row.thetaPctDaily.toFixed(1)}% de su valor al día (máximo ${MAX_THETA_PCT_DAILY}%): es lotería, no posición.`,
    };
  }
  return { ok: true };
}

/** ¿El flow merece salir en el screener? Capa 1 + el umbral de inusualidad del screener. */
export function isTradeableIdea(row: FlowRow): boolean {
  return (
    passesQualityFilter(row).ok &&
    unusualTradeScore(row).total >= IDEA_UNUSUAL_THRESHOLD
  );
}

/**
 * ¿El strike está cerca del precio actual? Filtro de "contratos más cercanos".
 * Ante datos faltantes (sin strike o sin precio del subyacente) NO filtra: la
 * cercanía es una preferencia, no una salvaguarda, así que no tira filas por
 * falta de datos.
 */
export function withinMoneyness(row: FlowRow, cap = MONEYNESS_CAP): boolean {
  const spot = safe(row.assetPrice);
  if (spot === 0 || row.strike == null) return true;
  return Math.abs(row.strike - spot) / spot <= cap;
}

function blockedSizing(reason: BlockReason, detail: string): Sizing {
  return {
    maxContracts: 0, binding: null,
    costPerContract: 0, totalCost: 0, costPctOfAccount: 0,
    burnDays: 0, thetaBurnPerContract: 0, totalBurn: 0, burnPctOfAccount: 0,
    fullyDecays: false,
    blocked: { reason, detail },
  };
}

export interface SizingContext {
  /** Salvaguarda de CLAUDE.md: cadena ilíquida → no se dimensiona, punto. */
  lowLiquidity?: boolean;
}

/**
 * Capa 2 — cuántos contratos caben. Gana la restricción más estricta entre
 * prima (pérdida máxima) y quema de theta, y se reporta cuál fue.
 */
export function sizeFlow(
  row: FlowRow,
  profile: RiskProfile,
  horizonDays: number,
  ctx: SizingContext = {},
): Sizing {
  // La iliquidez manda sobre todo lo demás, por buena que sea la estructura.
  if (ctx.lowLiquidity) {
    return blockedSizing(
      "iliquidez",
      "Cadena ilíquida: el agente no calcula tamaño cuando no confía en los datos.",
    );
  }

  const quality = passesQualityFilter(row);
  if (!quality.ok) return blockedSizing(quality.reason!, quality.detail!);

  const account = safe(profile?.accountSize);
  const budgets = budgetsOf(profile);
  const costPerContract = safe(row.price) * MULTIPLIER;
  if (costPerContract === 0) {
    return blockedSizing("sin_theta", "El contrato no tiene precio utilizable.");
  }

  // No se quema theta más allá del vencimiento.
  const burnDays = Math.max(0, Math.min(row.dte ?? 0, safe(horizonDays)));
  // Tope: una opción larga no puede perder más que su prima.
  const rawBurn = Math.abs(safe(Math.abs(row.theta))) * MULTIPLIER * burnDays;
  const thetaBurnPerContract = Math.min(rawBurn, costPerContract);
  const fullyDecays = rawBurn >= costPerContract && rawBurn > 0;

  const byPremium = Math.floor(budgets.premium / costPerContract);
  const byTheta =
    thetaBurnPerContract > 0
      ? Math.floor(budgets.theta / thetaBurnPerContract)
      : byPremium; // sin quema medible, la prima decide

  const maxContracts = Math.max(0, Math.min(byPremium, byTheta));
  // Empate → lo atribuimos a la prima: es la restricción de pérdida real.
  const binding: Binding | null =
    maxContracts === 0 ? null : byTheta < byPremium ? "theta" : "prima";

  const totalCost = maxContracts * costPerContract;
  const totalBurn = maxContracts * thetaBurnPerContract;
  const pct = (v: number) => (account > 0 ? (v / account) * 100 : 0);

  return {
    maxContracts,
    binding,
    costPerContract,
    totalCost,
    costPctOfAccount: pct(totalCost),
    burnDays,
    thetaBurnPerContract,
    totalBurn,
    burnPctOfAccount: pct(totalBurn),
    fullyDecays,
    blocked: null,
  };
}
