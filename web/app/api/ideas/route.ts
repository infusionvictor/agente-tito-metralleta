// GET /api/ideas — Screener de flows inusuales tradeables en TODO el mercado, por SSE.
//
// Escanea el flujo sin filtro de ticker, se queda con lo operable (capa 1 de lib/risk.ts)
// y le adjunta el historial del ticker (sub-agente 6) como evidencia de si ese patrón
// se ha desarrollado antes.
//
// El sizing NO se calcula aquí: el tamaño de cuenta vive en localStorage del navegador
// y nunca llega al servidor. Esta ruta devuelve los griegos; el cliente aplica sizeFlow.

import { classifyFlow, type FlowRow } from "@/lib/flow";
import { fetchMarketFlow, MarketSnackError } from "@/lib/marketsnack";
import { isTradeableIdea, passesQualityFilter, withinMoneyness, MONEYNESS_CAP } from "@/lib/risk";
import { loadTrades, saveTrades } from "@/lib/store";
import { fetchDailyBars } from "@/lib/massive";
import { validationScore, type FlowLite } from "@/lib/validation";
import type { Idea, IdeaHistory } from "@/app/ideas/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Parámetros del escaneo (ajustables).
const MIN_PREMIUM = 100_000; // piso server-side: flujo grande, ya no solo institucional puro
const MAX_PAGES = 8;
const PERIOD = "1d"; // el sizing usa el precio del trade → cuanto más fresco, mejor
const MAX_IDEAS = 60; // tope de filas devueltas
const MAX_HISTORY_TICKERS = 25; // tope de llamadas a Massive por escaneo

interface SseEvent {
  type: "step" | "done" | "error";
  [k: string]: unknown;
}
function sse(event: SseEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** Se queda con un solo trade por contrato: el de mayor premium. */
function dedupeByContract(rows: FlowRow[]): FlowRow[] {
  const best = new Map<string, FlowRow>();
  for (const r of rows) {
    const prev = best.get(r.symbol);
    if (!prev || r.premium > prev.premium) best.set(r.symbol, r);
  }
  return [...best.values()];
}

function toFlowLite(t: FlowRow): FlowLite {
  return {
    id: t.id, timestamp: t.timestamp, type: t.type, strike: t.strike,
    expiration: t.expiration, assetPrice: t.assetPrice, premium: t.premium,
    aggression: t.aggression,
  };
}

export async function GET() {
  const encoder = new TextEncoder();
  const now = new Date();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: SseEvent) => controller.enqueue(encoder.encode(sse(e)));

      try {
        send({ type: "step", label: "Escaneando el flujo de todo el mercado…" });

        const { trades, pages, truncated } = await fetchMarketFlow({
          period: PERIOD,
          minPremium: MIN_PREMIUM,
          maxPages: MAX_PAGES,
          onPage: (page, accumulated) => {
            send({
              type: "step",
              label: `Página ${page} — ${accumulated} operaciones grandes`,
            });
          },
        });

        send({ type: "step", label: `Clasificando ${trades.length} operaciones…` });
        const { rows } = classifyFlow(trades, now);

        // Por qué se cae cada contrato — hace visible el trabajo de la capa 1.
        const rejected = { theta_alto: 0, vencido: 0, sin_theta: 0, no_inusual: 0, lejano: 0 };
        for (const r of dedupeByContract(rows)) {
          const q = passesQualityFilter(r);
          if (!q.ok) rejected[q.reason as keyof typeof rejected]++;
          else if (!isTradeableIdea(r)) rejected.no_inusual++;
          else if (!withinMoneyness(r)) rejected.lejano++;
        }

        // Capa 1: operable de verdad (theta sano, no vencido, inusual) y con el
        // strike cerca del precio — "contratos más cercanos".
        const tradeable = dedupeByContract(
          rows.filter((r) => isTradeableIdea(r) && withinMoneyness(r)),
        )
          .sort((a, b) => b.premium - a.premium)
          .slice(0, MAX_IDEAS);

        const tickers = [...new Set(tradeable.map((r) => r.underlying))];
        send({
          type: "step",
          label: `${tradeable.length} ideas operables en ${tickers.length} tickers`,
        });

        // Historial: solo para tickers que YA tienen flows guardados. Los demás
        // salen como "sin historial" sin gastar una llamada a Massive.
        const history = new Map<string, IdeaHistory>();
        const withStored: { ticker: string; flows: FlowLite[] }[] = [];
        for (const ticker of tickers) {
          const stored = await loadTrades(ticker);
          const flows = (stored?.trades ?? [])
            .filter((t) => t.assetPrice > 0 && t.timestamp)
            .map(toFlowLite);
          if (flows.length > 0) withStored.push({ ticker, flows });
        }

        const toReview = withStored.slice(0, MAX_HISTORY_TICKERS);
        if (toReview.length > 0) {
          send({
            type: "step",
            label: `Revisando el historial de ${toReview.length} tickers…`,
          });
        }
        for (const { ticker, flows } of toReview) {
          const bars = await fetchDailyBars(ticker, 200).catch(() => []);
          if (bars.length === 0) continue;
          const report = validationScore({ flows, bars, now });
          history.set(ticker, {
            hitRate: report.hitRate.value,
            medianSessions: report.speed.medianSessions,
            resolved: report.hitRate.resolved,
          });
        }

        const ideas: Idea[] = tradeable.map((r) => ({
          id: r.id,
          ticker: r.underlying,
          symbol: r.symbol,
          type: r.type === "unknown" ? "call" : r.type,
          strike: r.strike,
          expiration: r.expiration,
          dte: r.dte,
          price: r.price,
          theta: r.theta,
          thetaPctDaily: r.thetaPctDaily,
          delta: r.delta,
          premium: r.premium,
          size: r.size,
          aggression: r.aggression,
          assetPrice: r.assetPrice,
          iv: r.iv,
          openInterest: r.openInterest,
          timestamp: r.timestamp,
          unusualScore: r.scores?.total ?? 0,
          repeated: Boolean(r.flags?.repeated),
          history: history.get(r.underlying) ?? null,
        }));

        // La cobertura del historial crece sola: cada escaneo guarda lo que vio,
        // igual que ya hacen chainStore e ivStore.
        let savedTickers = 0;
        for (const ticker of tickers) {
          const own = rows.filter((r) => r.underlying === ticker);
          if (own.length === 0) continue;
          await saveTrades(ticker, own).catch(() => null);
          savedTickers++;
        }

        send({
          type: "done",
          ideas,
          meta: {
            scanned: trades.length,
            pages,
            truncated,
            tickers: tickers.length,
            withHistory: history.size,
            savedTickers,
            rejected,
            minPremium: MIN_PREMIUM,
            moneynessCap: MONEYNESS_CAP,
            period: PERIOD,
            generatedAt: now.toISOString(),
          },
        });
      } catch (err) {
        const message =
          err instanceof MarketSnackError
            ? err.message
            : "Error inesperado al escanear el mercado.";
        send({ type: "error", message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
