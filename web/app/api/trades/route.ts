// /api/trades — Mis Trades (SIMULACIÓN / paper trading, nunca una orden real).
//
//   GET               → { trades, stats }
//   POST { ...input } → crea un trade pendiente y lo persiste

import {
  computeStats,
  computeStatsBreakdown,
  createTrade,
  type ContractType,
  type Direction,
  type TradeInput,
} from "@/lib/paperTrades";
import { loadAllTrades, upsertTrade } from "@/lib/paperTradesStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const trades = await loadAllTrades();
  return Response.json({ trades, stats: computeStats(trades), breakdown: computeStatsBreakdown(trades) });
}

function readInput(raw: unknown): TradeInput | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "Cuerpo inválido." };
  const b = raw as Record<string, unknown>;

  const ticker = typeof b.ticker === "string" ? b.ticker.trim() : "";
  if (!ticker) return { error: "Falta el ticker." };

  if (b.contractType !== "call" && b.contractType !== "put") {
    return { error: "contractType debe ser call o put." };
  }
  if (b.direction !== "up" && b.direction !== "down") {
    return { error: "direction debe ser up o down." };
  }

  const nums: Record<string, number> = {};
  for (const key of ["strike", "entryTrigger", "target", "stop", "contracts"] as const) {
    const n = Number(b[key]);
    if (!Number.isFinite(n)) return { error: `${key} debe ser un número.` };
    nums[key] = n;
  }
  if (nums.contracts <= 0 || !Number.isInteger(nums.contracts)) {
    return { error: "contracts debe ser un entero positivo." };
  }
  if (nums.strike <= 0) return { error: "strike debe ser positivo." };

  const expiration = typeof b.expiration === "string" ? b.expiration : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiration)) {
    return { error: "expiration debe ser YYYY-MM-DD." };
  }

  let trailingStopPct: number | null = null;
  if (b.trailingStopPct != null && b.trailingStopPct !== "") {
    const n = Number(b.trailingStopPct);
    if (!Number.isFinite(n) || n <= 0 || n >= 100) {
      return { error: "trailingStopPct debe estar entre 0 y 100." };
    }
    trailingStopPct = n;
  }

  let probability: number | null = null;
  if (b.probability != null && b.probability !== "") {
    const n = Number(b.probability);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      return { error: "probability debe estar entre 0 y 100." };
    }
    probability = n;
  }

  return {
    ticker,
    contractType: b.contractType as ContractType,
    strike: nums.strike,
    expiration,
    direction: b.direction as Direction,
    entryTrigger: nums.entryTrigger,
    target: nums.target,
    stop: nums.stop,
    trailingStopPct,
    probability,
    contracts: nums.contracts,
    source: b.source === "auto" ? "auto" : "manual",
    note: typeof b.note === "string" && b.note.trim() ? b.note.trim() : null,
  };
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Cuerpo inválido." }, { status: 400 });
  }

  const input = readInput(body);
  if ("error" in input) {
    return Response.json({ error: input.error }, { status: 400 });
  }

  const trade = createTrade(input);
  const trades = await upsertTrade(trade);
  return Response.json({ trade, trades, stats: computeStats(trades) }, { status: 201 });
}
