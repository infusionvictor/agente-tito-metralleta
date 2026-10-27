// /api/watch — lista de tickers vigilados para alertas proactivas de nivel.
//   GET            → { tickers }
//   POST { ticker } → agrega (tope MAX_WATCHED)
//   DELETE ?ticker= → quita

import { addWatchedTicker, loadWatchedTickers, removeWatchedTicker } from "@/lib/watchStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const tickers = await loadWatchedTickers();
  return Response.json({ tickers });
}

export async function POST(request: Request) {
  let body: { ticker?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Cuerpo inválido." }, { status: 400 });
  }
  if (typeof body.ticker !== "string" || !body.ticker.trim()) {
    return Response.json({ error: "Falta el ticker." }, { status: 400 });
  }
  const { tickers, error } = await addWatchedTicker(body.ticker);
  if (error) return Response.json({ error, tickers }, { status: 400 });
  return Response.json({ tickers });
}

export async function DELETE(request: Request) {
  const ticker = new URL(request.url).searchParams.get("ticker");
  if (!ticker) return Response.json({ error: "Falta el ticker." }, { status: 400 });
  const tickers = await removeWatchedTicker(ticker);
  return Response.json({ tickers });
}
