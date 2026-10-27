// Piloto automático — decide QUÉ abrir en paper trading, no CÓMO conseguir los datos
// (eso vive en la orquestación de app/api/autopilot/scan/route.ts). Funciones puras,
// testeadas, para que los umbrales y la lógica de selección se puedan verificar sin
// red ni disco.
//
// Dos vías, igual que pide el spec:
//   - intradía: confianza del mapa GEX + dirección + DOS niveles reales de
//     findLevels — uno como gatillo de ruptura, el otro como stop (el nivel que
//     invalida la ruptura si el precio vuelve a cruzarlo) — y el nodo GEX
//     (kingStrike) como objetivo. Sin ambos niveles reales, no hay plan.
//   - swing: flujo institucional inusual CON acierto histórico verificado
//     (validation.ts) — sin historial, el piloto no entra: no hay forma de
//     sostener "alta probabilidad". El objetivo/stop salen de la excursión
//     histórica REAL del ticker (avgMfe/avgMae de validationScore), no de un
//     múltiplo inventado.
//
// En ambas vías, los niveles del SUBYACENTE (gatillo/objetivo/stop) se traducen
// a precio de OPCIÓN con Black-Scholes (bsPrice) sobre el contrato elegido —
// nunca una heurística de "+X% de la prima". Si a algún candidato le falta un
// insumo real (nivel, IV, excursión histórica), se descarta: no se inventa nada.
//
// SIMULACIÓN siempre: esto solo decide qué trade PAPER crear, nunca coloca una orden.

import { bsPrice } from "./blackScholes";
import type { ContractType, Direction, TradeInput, TradePath } from "./paperTrades";

/** Confianza mínima del mapa GEX (0-100, `gexAnalysis().confidence`) para autopilotear. */
export const MIN_INTRADAY_CONFIDENCE = 55;

/** Acierto histórico mínimo (0-100, `validationScore().hitRate.value`) para autopilotear swing. */
export const MIN_SWING_HITRATE = 50;

/** Casos resueltos mínimos para confiar en el acierto histórico de un ticker. */
export const MIN_SWING_SAMPLES = 3;

/** Ventana de vencimiento aceptable para el contrato que arma el piloto. */
export const MIN_CONTRACT_DTE = 7;
export const MAX_CONTRACT_DTE = 30;

/** Asegura ganancia si la prima retrocede 25% desde su pico (mecánica de riesgo, no un nivel de precio). */
export const AUTO_TRAILING_PCT = 25;

/** Confirmación para el gatillo del swing: cuánto debe seguir el subyacente al flow. */
export const SWING_CONFIRM_PCT = 0.3;

export interface ContractCandidate {
  strike: number;
  expiration: string;
  dte: number;
  bid: number | null;
  ask: number | null;
  lastTrade: number | null;
}

/** Precio de referencia de un contrato: mid si hay bid/ask, si no el último trade. */
export function refPrice(c: ContractCandidate): number | null {
  if (c.bid != null && c.ask != null && c.bid > 0 && c.ask > 0) return (c.bid + c.ask) / 2;
  return c.lastTrade != null && c.lastTrade > 0 ? c.lastTrade : null;
}

/** El contrato con precio disponible más cercano al strike objetivo, dentro de la ventana de DTE. */
export function pickNearestContract(
  candidates: ContractCandidate[],
  targetStrike: number,
): ContractCandidate | null {
  const usable = candidates.filter(
    (c) => c.dte >= MIN_CONTRACT_DTE && c.dte <= MAX_CONTRACT_DTE && refPrice(c) != null,
  );
  if (usable.length === 0) return null;
  return usable.sort(
    (a, b) => Math.abs(a.strike - targetStrike) - Math.abs(b.strike - targetStrike),
  )[0];
}

/** Alias local: la vía del piloto ES el `TradePath` que termina guardado en el trade. */
export type AutoPath = TradePath;

export interface AutoCandidate {
  ticker: string;
  path: AutoPath;
  direction: Direction;
  contractType: ContractType;
  strike: number;
  expiration: string;
  entryTrigger: number; // nivel real del SUBYACENTE
  target: number; // precio de OPCIÓN, proyectado con Black-Scholes sobre un nivel real
  stop: number; // ídem, sobre el nivel real que invalida el plan
  probability: number; // 0-100
  reasoning: string;
  entryPriceRef: number; // cotización actual del contrato — solo informativa/liquidez
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Vía intradía — GEX + dirección + DOS niveles reales (gatillo y stop) + nodo
// GEX como objetivo, todo traducido a prima con Black-Scholes.
// ---------------------------------------------------------------------------

export interface KeyLevel {
  price: number;
  strength: number;
}

export interface IntradaySignal {
  ticker: string;
  spot: number;
  iv: number; // IV estimada por gexAnalysis (volatilidad realizada, anclada donde hay trades reales)
  gexDirection: "up" | "down" | "flat" | null;
  gexConfidence: number;
  kingStrike: number | null; // nodo GEX principal — el objetivo real
  lowLiquidity: boolean;
  keySupport: KeyLevel | null;
  keyResistance: KeyLevel | null;
  contracts: ContractCandidate[];
}

export function evaluateIntraday(sig: IntradaySignal): AutoCandidate | null {
  if (sig.lowLiquidity) return null;
  if (sig.gexConfidence < MIN_INTRADAY_CONFIDENCE) return null;
  if (sig.kingStrike == null) return null; // sin nodo GEX no hay objetivo real que proyectar
  if (!(sig.iv > 0)) return null;

  let direction: Direction;
  let contractType: ContractType;
  let entryTrigger: number;
  let stopUnderlying: number;
  let levelWhy: string;

  // Ambos niveles reales tienen que existir: uno es el gatillo, el otro invalida
  // el plan si el precio vuelve a cruzarlo (el stop del SUBYACENTE).
  if (sig.gexDirection === "up" && sig.keyResistance && sig.keySupport) {
    direction = "up";
    contractType = "call";
    entryTrigger = sig.keyResistance.price;
    stopUnderlying = sig.keySupport.price;
    levelWhy =
      `ruptura de resistencia en $${sig.keyResistance.price.toFixed(2)} (fuerza ${sig.keyResistance.strength}), ` +
      `objetivo en el nodo GEX $${sig.kingStrike.toFixed(2)}, stop bajo el soporte real en $${sig.keySupport.price.toFixed(2)}`;
  } else if (sig.gexDirection === "down" && sig.keySupport && sig.keyResistance) {
    direction = "down";
    contractType = "put";
    entryTrigger = sig.keySupport.price;
    stopUnderlying = sig.keyResistance.price;
    levelWhy =
      `ruptura de soporte en $${sig.keySupport.price.toFixed(2)} (fuerza ${sig.keySupport.strength}), ` +
      `objetivo en el nodo GEX $${sig.kingStrike.toFixed(2)}, stop sobre la resistencia real en $${sig.keyResistance.price.toFixed(2)}`;
  } else {
    return null; // solo un nivel real (o ninguno) no alcanza para armar gatillo + stop
  }

  const contract = pickNearestContract(sig.contracts, sig.spot);
  if (!contract) return null;
  const entryPriceRef = refPrice(contract);
  if (entryPriceRef == null) return null;

  const T = contract.dte / 365;
  const target = bsPrice(sig.kingStrike, contract.strike, T, sig.iv, contractType);
  const stop = bsPrice(stopUnderlying, contract.strike, T, sig.iv, contractType);
  // Si la proyección no da precios válidos, o el objetivo no queda por encima
  // del stop (contratos muy OTM/lejanos pueden colapsar ambos cerca de 0), no
  // hay plan coherente que armar con estos niveles.
  if (!(target > 0) || !(stop > 0) || !(target > stop)) return null;

  return {
    ticker: sig.ticker,
    path: "intraday",
    direction,
    contractType,
    strike: contract.strike,
    expiration: contract.expiration,
    entryTrigger: round2(entryTrigger),
    target: round2(target),
    stop: round2(stop),
    probability: sig.gexConfidence,
    reasoning: `GEX confianza ${sig.gexConfidence}% + ${levelWhy}.`,
    entryPriceRef,
  };
}

// ---------------------------------------------------------------------------
// Vía swing — flujo institucional inusual + acierto histórico + excursión
// histórica REAL (avgMfe/avgMae de validationScore) como objetivo/stop.
// ---------------------------------------------------------------------------

export interface SwingSignal {
  ticker: string;
  type: ContractType;
  strike: number;
  expiration: string;
  dte: number;
  iv: number; // IV real del flow (MarketSnack)
  assetPrice: number; // spot del subyacente cuando ocurrió el flow
  price: number; // prima del flow — solo informativa/liquidez
  hitRate: number | null; // acierto histórico 0-100 (validationScore)
  resolved: number; // casos pasados usados para calcular el acierto
  avgMfePct: number | null; // excursión favorable histórica promedio (%, validationScore.avgMfe)
  avgMaePct: number | null; // excursión adversa histórica promedio (%, validationScore.avgMae)
}

export function evaluateSwing(sig: SwingSignal): AutoCandidate | null {
  // Sin historial suficiente no hay forma honesta de sostener "acierto histórico":
  // el piloto se abstiene en vez de inventar una probabilidad.
  if (sig.hitRate == null || sig.resolved < MIN_SWING_SAMPLES) return null;
  if (sig.hitRate < MIN_SWING_HITRATE) return null;
  if (!(sig.price > 0) || !(sig.iv > 0) || !(sig.dte > 0)) return null;
  // Sin excursión histórica real no hay de dónde sacar objetivo/stop — no se
  // inventa un múltiplo arbitrario en su lugar.
  if (sig.avgMfePct == null || sig.avgMaePct == null || sig.avgMfePct <= 0 || sig.avgMaePct <= 0) return null;

  const direction: Direction = sig.type === "put" ? "down" : "up";
  const entryTrigger =
    direction === "up"
      ? sig.assetPrice * (1 + SWING_CONFIRM_PCT / 100)
      : sig.assetPrice * (1 - SWING_CONFIRM_PCT / 100);

  const targetUnderlying =
    direction === "up"
      ? sig.assetPrice * (1 + sig.avgMfePct / 100)
      : sig.assetPrice * (1 - sig.avgMfePct / 100);
  const stopUnderlying =
    direction === "up"
      ? sig.assetPrice * (1 - sig.avgMaePct / 100)
      : sig.assetPrice * (1 + sig.avgMaePct / 100);

  const T = sig.dte / 365;
  const target = bsPrice(targetUnderlying, sig.strike, T, sig.iv, sig.type);
  const stop = bsPrice(stopUnderlying, sig.strike, T, sig.iv, sig.type);
  if (!(target > 0) || !(stop > 0) || !(target > stop)) return null;

  return {
    ticker: sig.ticker,
    path: "swing",
    direction,
    contractType: sig.type,
    strike: sig.strike,
    expiration: sig.expiration,
    entryTrigger: round2(entryTrigger),
    target: round2(target),
    stop: round2(stop),
    probability: sig.hitRate,
    reasoning:
      `Flujo institucional inusual — acierto histórico ${sig.hitRate.toFixed(0)}% sobre ${sig.resolved} casos. ` +
      `Objetivo/stop de la excursión histórica real del ticker: +${sig.avgMfePct.toFixed(1)}% / −${sig.avgMaePct.toFixed(1)}% del subyacente.`,
    entryPriceRef: sig.price,
  };
}

// ---------------------------------------------------------------------------
// Candidato → plan de paper trade (pass-through: los niveles ya vienen calculados)
// ---------------------------------------------------------------------------

export function buildAutoTradeInput(c: AutoCandidate): TradeInput {
  const pathLabel = c.path === "intraday" ? "Intradía · GEX + niveles" : "Swing · flujo institucional";
  return {
    ticker: c.ticker,
    contractType: c.contractType,
    strike: c.strike,
    expiration: c.expiration,
    direction: c.direction,
    entryTrigger: c.entryTrigger,
    target: c.target,
    stop: c.stop,
    trailingStopPct: AUTO_TRAILING_PCT,
    probability: Math.round(c.probability),
    contracts: 1,
    source: "auto",
    path: c.path,
    note: `[${pathLabel}] ${c.reasoning}`,
  };
}
