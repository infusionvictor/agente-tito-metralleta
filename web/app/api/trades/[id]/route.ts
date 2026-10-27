// /api/trades/[id] — editar un trade vivo o borrar uno que nunca se activó.
//
//   PATCH { contracts?, target?, stop?, trailingStopPct?, note? } → edita campos del plan
//   DELETE                                                        → solo si status === "pending"

import { computeStats } from "@/lib/paperTrades";
import { deletePendingTrade, loadAllTrades, upsertTrade } from "@/lib/paperTradesStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Cuerpo inválido." }, { status: 400 });
  }

  const trades = await loadAllTrades();
  const trade = trades.find((t) => t.id === id);
  if (!trade) return Response.json({ error: "Trade no encontrado." }, { status: 404 });
  if (trade.status !== "pending" && trade.status !== "active") {
    return Response.json({ error: "Un trade cerrado ya no se puede editar." }, { status: 400 });
  }

  const next = { ...trade };

  if (body.contracts !== undefined) {
    const n = Number(body.contracts);
    if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
      return Response.json({ error: "contracts debe ser un entero positivo." }, { status: 400 });
    }
    next.contracts = n;
  }
  if (body.target !== undefined) {
    const n = Number(body.target);
    if (!Number.isFinite(n) || n <= 0) return Response.json({ error: "target inválido." }, { status: 400 });
    next.target = n;
  }
  if (body.stop !== undefined) {
    const n = Number(body.stop);
    if (!Number.isFinite(n) || n < 0) return Response.json({ error: "stop inválido." }, { status: 400 });
    next.stop = n;
  }
  if (body.trailingStopPct !== undefined) {
    if (body.trailingStopPct === null || body.trailingStopPct === "") {
      next.trailingStopPct = null;
    } else {
      const n = Number(body.trailingStopPct);
      if (!Number.isFinite(n) || n <= 0 || n >= 100) {
        return Response.json({ error: "trailingStopPct debe estar entre 0 y 100." }, { status: 400 });
      }
      next.trailingStopPct = n;
    }
  }
  if (body.note !== undefined) {
    next.note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;
  }
  next.updatedAt = new Date().toISOString();

  const saved = await upsertTrade(next);
  return Response.json({ trade: next, trades: saved, stats: computeStats(saved) });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { trades, deleted } = await deletePendingTrade(id);
  if (!deleted) {
    return Response.json(
      { error: "Solo se puede borrar un trade pendiente (que nunca se activó)." },
      { status: 400 },
    );
  }
  return Response.json({ trades, stats: computeStats(trades) });
}
