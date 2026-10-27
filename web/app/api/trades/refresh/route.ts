// /api/trades/refresh — pasa cada trade pendiente/activo por el motor de evaluación
// con la cotización más reciente de Massive. Lo usa el botón "Actualizar precios" de
// la UI y, más adelante, el piloto automático corriendo en su tarea programada.

import { fetchContractQuote, MassiveError } from "@/lib/massive";
import { computeStats, evaluateTrade, type PaperTrade } from "@/lib/paperTrades";
import { loadAllTrades, upsertMany } from "@/lib/paperTradesStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function contractKey(t: PaperTrade): string {
  return `${t.ticker}|${t.contractType}|${t.strike}|${t.expiration}`;
}

export async function POST() {
  const trades = await loadAllTrades();
  const live = trades.filter((t) => t.status === "pending" || t.status === "active");

  if (live.length === 0) {
    return Response.json({ trades, stats: computeStats(trades), updated: 0, errors: [] });
  }

  // Un contrato repetido en varios trades (p. ej. agregaste más contratos con otro
  // plan) solo se cotiza una vez.
  const uniqueContracts = new Map<string, PaperTrade>();
  for (const t of live) uniqueContracts.set(contractKey(t), t);

  const errors: string[] = [];
  const quotes = new Map<string, { underlyingPrice: number | null; optionPrice: number | null }>();

  await Promise.all(
    [...uniqueContracts.entries()].map(async ([key, t]) => {
      try {
        const q = await fetchContractQuote(t.ticker, t.contractType, t.strike, t.expiration);
        quotes.set(key, { underlyingPrice: q?.underlyingPrice ?? null, optionPrice: q?.mid ?? null });
      } catch (err) {
        const msg = err instanceof MassiveError ? err.message : "Error consultando Massive.";
        errors.push(`${t.ticker} ${t.strike}${t.contractType === "call" ? "C" : "P"}: ${msg}`);
        quotes.set(key, { underlyingPrice: null, optionPrice: null });
      }
    }),
  );

  const now = new Date();
  const updated: PaperTrade[] = [];
  for (const t of live) {
    const q = quotes.get(contractKey(t)) ?? { underlyingPrice: null, optionPrice: null };
    const next = evaluateTrade(t, q, now);
    if (next !== t) updated.push(next);
  }

  const saved = updated.length > 0 ? await upsertMany(updated) : trades;
  return Response.json({ trades: saved, stats: computeStats(saved), updated: updated.length, errors });
}
