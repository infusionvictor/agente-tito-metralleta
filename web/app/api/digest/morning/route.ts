// POST /api/digest/morning — Resumen matutino de oportunidades reales, por Discord.
//
// Corre antes de la apertura (ver .github/workflows/morning-digest.yml). Reusa
// EXACTAMENTE el mismo escaneo y filtro de calidad que /api/ideas (lib/risk.ts):
// flujo de TODO el mercado, capa 1 (theta sano, no vencido, inusual, cerca del
// spot). No inventa objetivos ni direcciones — solo reporta lo que el escaneo
// real encontró, con el historial verificado (validationScore) cuando existe.
//
// Nunca crea trades ni coloca órdenes — es puramente informativo.

import { isAuthorized, isVercelCronAuthorized } from "@/lib/cronAuth";
import { sendMorningDigest, type DigestIdea } from "@/lib/discord";
import { classifyFlow, type FlowRow } from "@/lib/flow";
import { fetchDailyBars } from "@/lib/massive";
import { fetchMarketFlow, MarketSnackError } from "@/lib/marketsnack";
import { isTradeableIdea, withinMoneyness } from "@/lib/risk";
import { loadTrades } from "@/lib/store";
import { validationScore, type FlowLite } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Mismos umbrales que /api/ideas — un escaneo real de todo el mercado.
const MIN_PREMIUM = 100_000;
const MAX_PAGES = 8;
const PERIOD = "1d";
const TOP_N = 8; // cuántas ideas entran al resumen de Discord

function toFlowLite(t: FlowRow): FlowLite {
  return {
    id: t.id, timestamp: t.timestamp, type: t.type, strike: t.strike,
    expiration: t.expiration, assetPrice: t.assetPrice, premium: t.premium,
    aggression: t.aggression,
  };
}

function dedupeByContract(rows: FlowRow[]): FlowRow[] {
  const best = new Map<string, FlowRow>();
  for (const r of rows) {
    const prev = best.get(r.symbol);
    if (!prev || r.premium > prev.premium) best.set(r.symbol, r);
  }
  return [...best.values()];
}

async function handle(request: Request) {
  const authorized =
    isAuthorized(request.headers.get("x-cron-secret"), process.env.CRON_SECRET) ||
    isVercelCronAuthorized(request.headers.get("authorization"), process.env.CRON_SECRET);
  if (!authorized) {
    return Response.json({ error: "No autorizado." }, { status: 401 });
  }

  const now = new Date();

  try {
    const { trades } = await fetchMarketFlow({ period: PERIOD, minPremium: MIN_PREMIUM, maxPages: MAX_PAGES });
    const { rows } = classifyFlow(trades, now);

    const tradeable = dedupeByContract(rows.filter((r) => isTradeableIdea(r) && withinMoneyness(r)))
      .sort((a, b) => b.premium - a.premium)
      .slice(0, TOP_N);

    const tickers = [...new Set(tradeable.map((r) => r.underlying))];
    const allTickers = new Set(rows.map((r) => r.underlying));

    // Historial verificado solo para los tickers que de verdad entran al resumen.
    const history = new Map<string, { hitRate: number | null; resolved: number }>();
    for (const ticker of tickers) {
      const stored = await loadTrades(ticker);
      const flows = (stored?.trades ?? []).filter((t) => t.assetPrice > 0 && t.timestamp).map(toFlowLite);
      if (flows.length === 0) continue;
      const bars = await fetchDailyBars(ticker, 200).catch(() => []);
      if (bars.length === 0) continue;
      const report = validationScore({ flows, bars, now });
      history.set(ticker, { hitRate: report.hitRate.value, resolved: report.hitRate.resolved });
    }

    const ideas: DigestIdea[] = tradeable.map((r) => ({
      ticker: r.underlying,
      type: r.type === "unknown" ? "call" : r.type,
      strike: r.strike,
      expiration: r.expiration,
      assetPrice: r.assetPrice,
      premium: r.premium,
      unusualScore: r.scores?.total ?? 0,
      history: history.get(r.underlying) ?? null,
    }));

    const meta = { scanned: trades.length, tickers: allTickers.size };
    await sendMorningDigest(ideas, meta, null, now);

    return Response.json({ sent: true, ideas: ideas.length, ...meta });
  } catch (err) {
    const message =
      err instanceof MarketSnackError ? err.message : "Error inesperado al escanear el mercado.";
    await sendMorningDigest([], { scanned: 0, tickers: 0 }, message, now);
    return Response.json({ sent: true, ideas: 0, error: message }, { status: 200 });
  }
}

// POST: GitHub Actions / disparo manual (header x-cron-secret).
// GET: Vercel Cron (vercel.json) — Vercel solo invoca por GET y manda el
// secret como `Authorization: Bearer`, sin dejar mandar headers propios.
export const POST = handle;
export const GET = handle;
