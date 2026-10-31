// GET /api/earnings?ticker=XXX — Earnings IV-Crush de UN ticker (con spreads sugeridos).
// Ver docs/superpowers/specs/2026-07-27-earnings-iv-crush-design.md

import { computeEarnings } from "@/lib/earningsServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = (searchParams.get("ticker") ?? "").trim().toUpperCase();
  if (!ticker) return Response.json({ error: "Falta el ticker." }, { status: 400 });

  try {
    const result = await computeEarnings(ticker, { withSpreads: true });
    return Response.json(result);
  } catch {
    return Response.json({ error: "No se pudo calcular el earnings move." }, { status: 502 });
  }
}
