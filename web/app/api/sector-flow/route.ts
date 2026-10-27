// GET /api/sector-flow?ticker=XXX — Tarea 3 del Proceso Principal: compara el
// flujo del ticker contra los líderes de su sector (lib/sectors.ts) para
// etiquetar si la actividad de hoy es SECTORIAL (rota el sector completo) o
// INDIVIDUAL (conviction específica en esta empresa). On-demand (no se llama
// solo al cargar un ticker) porque cada comparación cuesta hasta 5 llamadas
// más a MarketSnack — ver el rate-limit que ya sufrimos con /api/flow.

import { classifyFlow } from "@/lib/flow";
import { fetchCompany } from "@/lib/massive";
import { fetchFlow, MarketSnackError } from "@/lib/marketsnack";
import { sectorFor, sectorPeers } from "@/lib/sectors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIN_PREMIUM = 100_000;

interface TickerSentiment {
  ticker: string;
  sentiment: "bullish" | "bearish" | "neutral";
  unusualCount: number;
  premium: number;
}

/** Sentimiento dominante del día: suma premium de trades inusuales por sentimiento, gana el mayor. */
async function dominantSentiment(ticker: string, now: Date): Promise<TickerSentiment> {
  const { trades } = await fetchFlow(ticker, { period: "1d", minPremium: MIN_PREMIUM, maxPages: 3 });
  const { rows } = classifyFlow(trades, now);
  const unusual = rows.filter((r) => r.unusual);

  const bySentiment = { bullish: 0, bearish: 0, neutral: 0 };
  for (const r of unusual) {
    const s = r.sentiment === "bullish" || r.sentiment === "bearish" ? r.sentiment : "neutral";
    bySentiment[s] += r.premium;
  }
  const sentiment = (Object.entries(bySentiment).sort((a, b) => b[1] - a[1])[0]?.[0] ??
    "neutral") as TickerSentiment["sentiment"];

  return {
    ticker,
    sentiment: unusual.length > 0 ? sentiment : "neutral",
    unusualCount: unusual.length,
    premium: bySentiment[sentiment] ?? 0,
  };
}

export async function GET(request: Request) {
  const ticker = (new URL(request.url).searchParams.get("ticker") ?? "").trim().toUpperCase();
  if (!ticker) return Response.json({ error: "ticker requerido" }, { status: 400 });

  const now = new Date();

  const company = await fetchCompany(ticker).catch(() => null);
  const group = sectorFor(company?.sector ?? null);
  if (!group) {
    return Response.json({ matched: false, sector: company?.sector ?? null });
  }

  const peers = sectorPeers(company?.sector ?? null, ticker);
  if (peers.length === 0) {
    return Response.json({ matched: false, sector: company?.sector ?? null });
  }

  try {
    const [own, ...peerResults] = await Promise.all([
      dominantSentiment(ticker, now),
      ...peers.map((p) => dominantSentiment(p, now).catch(() => null)),
    ]);
    const peerSentiments = peerResults.filter((p): p is TickerSentiment => p != null);

    const agreeing = own.sentiment !== "neutral"
      ? peerSentiments.filter((p) => p.sentiment === own.sentiment)
      : [];

    const label: "sectorial" | "individual" | "sin_actividad" =
      own.unusualCount === 0 ? "sin_actividad" : agreeing.length >= 2 ? "sectorial" : "individual";

    return Response.json({
      matched: true,
      sectorName: group.name,
      ticker: own,
      peers: peerSentiments,
      agreeingCount: agreeing.length,
      label,
    });
  } catch (err) {
    const message = err instanceof MarketSnackError ? err.message : "Error al comparar el sector.";
    return Response.json({ error: message }, { status: 502 });
  }
}
