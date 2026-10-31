// GET  /api/earnings-trades?ticker=XXX  → historial de trades de earnings del usuario
// POST /api/earnings-trades  { ...EarningsTrade }  → guarda un trade
// Ver docs/superpowers/specs/2026-07-27-earnings-iv-crush-design.md

import { loadEarningsTrades, saveEarningsTrade, type EarningsTrade } from "@/lib/earningsTradeStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = (searchParams.get("ticker") ?? "").trim().toUpperCase();
  if (!ticker) return Response.json({ trades: [] });
  const trades = await loadEarningsTrades(ticker);
  return Response.json({ trades });
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Partial<EarningsTrade>;
    const ticker = (body.ticker ?? "").trim().toUpperCase();
    if (!ticker || body.shortStrike == null || body.longStrike == null || body.credit == null) {
      return Response.json({ error: "Faltan datos del trade." }, { status: 400 });
    }
    const trade: EarningsTrade = {
      id: `${ticker}-${Date.now()}`,
      ticker,
      savedAt: new Date().toISOString(),
      earningsDate: body.earningsDate ?? null,
      kind: body.kind === "bear_call" ? "bear_call" : "bull_put",
      shortStrike: body.shortStrike,
      longStrike: body.longStrike,
      width: body.width ?? Math.abs(body.shortStrike - body.longStrike),
      credit: body.credit,
      expiration: body.expiration ?? null,
      spotAtEntry: body.spotAtEntry ?? null,
      ivAtEntry: body.ivAtEntry ?? null,
      richnessAtEntry: body.richnessAtEntry ?? null,
      flowAtEntry: body.flowAtEntry ?? null,
      note: body.note,
    };
    const trades = await saveEarningsTrade(trade);
    return Response.json({ trades });
  } catch {
    return Response.json({ error: "No se pudo guardar el trade." }, { status: 500 });
  }
}
