// Overlay de bid/ask EN VIVO de MarketSnack sobre la cadena de Massive.
//
// PURO — no toca red. La ruta baja el flow y aquí solo se cruza. Massive dejó
// de exponer el bid/ask en su snapshot de opciones; MarketSnack sí lo trae,
// pero solo de los contratos que OPERARON. Este módulo arma un índice
// strike|vencimiento → bid/ask del trade más reciente de cada put, para que la
// ruta pueda rellenar la cadena donde MarketSnack tenga cotización viva.

import { parseOcc } from "./occ";
import type { RawTrade } from "./flow";

export interface LiveQuote {
  bid: number;
  ask: number;
}

/** Clave de contrato: strike a 2 decimales + vencimiento YYYY-MM-DD. */
export function liveKey(strike: number, expiration: string): string {
  return `${strike.toFixed(2)}|${expiration}`;
}

/**
 * Índice de bid/ask en vivo por PUT, quedándose con el trade MÁS RECIENTE de
 * cada contrato. Descarta trades sin horquilla válida (bid o ask ≤ 0, o
 * cruzada). Los calls se ignoran: la Wheel solo vende puts.
 */
export function liveQuoteMap(trades: RawTrade[]): Map<string, LiveQuote> {
  const best = new Map<string, { q: LiveQuote; ts: number }>();

  for (const t of trades) {
    const occ = parseOcc(t.symbol);
    if (!occ || occ.type !== "put") continue;

    const bid = t.bid_price;
    const ask = t.ask_price;
    if (!(bid > 0) || !(ask > 0) || ask < bid) continue;

    const key = liveKey(occ.strike, occ.expiration);
    const ts = Date.parse(t.timestamp);
    const prev = best.get(key);
    if (!prev || (Number.isFinite(ts) && ts > prev.ts)) {
      best.set(key, { q: { bid, ask }, ts: Number.isFinite(ts) ? ts : 0 });
    }
  }

  const out = new Map<string, LiveQuote>();
  for (const [k, v] of best) out.set(k, v.q);
  return out;
}
