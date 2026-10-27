// GET /api/sentiment — sentimiento de TODO el mercado (no un ticker), desde MarketSnack.
// Contexto macro: si el flujo de un ticker específico va a favor o en contra de la
// corriente general del mercado. Independiente del scorecard por ticker.

import { fetchMarketSentiment, MarketSnackError } from "@/lib/marketsnack";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const sentiment = await fetchMarketSentiment();
    return Response.json(sentiment);
  } catch (err) {
    const message = err instanceof MarketSnackError ? err.message : "Error al cargar el sentimiento de mercado.";
    return Response.json({ error: message }, { status: 502 });
  }
}
