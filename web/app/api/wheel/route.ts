// GET /api/wheel?preset=balanceado — Screener de cash-secured puts por SSE.
//
// Orquesta I/O y NADA de criterio: todo lo que decide vive en lib/wheel.ts.
// El saldo NO llega aquí: la ruta devuelve candidatos con métricas y la
// asequibilidad se calcula en el cliente con tito.risk.* de localStorage.

import { fetchWheelChain } from "@/lib/massive";
import { fetchFlow } from "@/lib/marketsnack";
import { liveQuoteMap, liveKey } from "@/lib/wheelLive";
import { cachedDailyBars } from "@/lib/barsStore";
import { findLevels, type LvlBar } from "@/lib/levels";
import { realizedVolSeries, rankWithin } from "@/lib/ivcontext";
import { earningsForTicker } from "@/lib/earnings";
import {
  WHEEL_PRESETS, wheelCandidates,
  type PresetId, type WheelCandidate,
} from "@/lib/wheel";
import { WHEEL_UNIVERSE } from "@/lib/wheelUniverse";
import type { WheelSseEvent } from "@/app/wheel/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Concurrencia baja a propósito: el plan de Massive limita las peticiones por
// minuto. Con el retry/backoff de getJson, 2 en vuelo escanea sin reventar el
// límite (a cambio de tardar más; el SSE va mostrando el progreso).
const CONCURRENCY = 2;

function sse(event: WheelSseEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function isPreset(v: string | null): v is PresetId {
  return v === "conservador" || v === "balanceado" || v === "agresivo";
}

/** Corre `worker` sobre `items` con como mucho `limit` en vuelo a la vez. */
async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  async function run(): Promise<void> {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await worker(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const presetParam = url.searchParams.get("preset");
  const preset = WHEEL_PRESETS[isPreset(presetParam) ? presetParam : "balanceado"];
  const now = new Date();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: WheelSseEvent) => controller.enqueue(encoder.encode(sse(e)));
      let failed = 0;
      const all: WheelCandidate[] = [];

      try {
        send({ type: "step", label: `Escaneando ${WHEEL_UNIVERSE.length} tickers · preset ${preset.label}` });

        await mapLimit(WHEEL_UNIVERSE, CONCURRENCY, async (sym) => {
          try {
            // Precio de la acción: del histórico diario. Massive dejó de mandar
            // el spot en el snapshot de opciones (underlying_asset sin price).
            const bars = await cachedDailyBars(sym.ticker, 365, now);
            const spot = bars.length > 0 ? bars[bars.length - 1].close : null;
            if (spot == null || !(spot > 0)) {
              failed++;
              send({ type: "step", label: `${sym.ticker}: sin precio` });
              return;
            }

            const chain = await fetchWheelChain(sym.ticker, {
              dteMin: preset.dteMin, dteMax: preset.dteMax, now,
            });
            // Solo puts OTM (colateral razonable y son los de la Wheel).
            let quotes = chain.quotes.filter((q) => q.strike <= spot);
            if (quotes.length === 0) {
              failed++;
              send({ type: "step", label: `${sym.ticker}: sin cadena` });
              return;
            }

            // Overlay de bid/ask EN VIVO de MarketSnack donde ese put operó.
            // Massive ya no trae horquilla; sin un bid real la salvaguarda de
            // liquidez bloquea todo. Best-effort: si MarketSnack falla (cookie o
            // límite), se degrada a Massive y esos strikes quedan sin bid.
            try {
              const flow = await fetchFlow(sym.ticker, { period: "5d", maxPages: 2 });
              const live = liveQuoteMap(flow.trades);
              if (live.size > 0) {
                quotes = quotes.map((q) => {
                  const lq = live.get(liveKey(q.strike, q.expiration));
                  return lq ? { ...q, bid: lq.bid, ask: lq.ask } : q;
                });
              }
            } catch {
              // MarketSnack no disponible: se sigue con Massive (sin bid en vivo).
            }

            const lvlBars: LvlBar[] = bars.map((b) => ({ time: b.time, high: b.high, low: b.low, close: b.close }));
            const levels = findLevels({ bars: lvlBars, spot, now });

            // IV Rank propio: proxy de volatilidad realizada (no hay serie de IV).
            const rvSeries = realizedVolSeries(bars.map((b) => b.close), 30);
            const currentRv = rvSeries.length > 0 ? rvSeries[rvSeries.length - 1] : null;
            const ivRank = currentRv != null ? rankWithin(rvSeries, currentRv) : null;

            // Earnings sobre el vencimiento más cercano de la ventana.
            // frontSkew: null a propósito — este escaneo Wheel no computa
            // ivContextScore por ticker (no hay flujo de MarketSnack por
            // símbolo aquí), así que la confirmación por skew de earningsFlag
            // ("dentro_confirmado") queda pendiente y hoy nunca dispara; ver
            // la nota en lib/earnings.ts (earningsForTicker).
            const nearExp = quotes.reduce((a, b) => (b.dte < a.dte ? b : a)).expiration;
            const earnings = await earningsForTicker({
              ticker: sym.ticker, expiration: nearExp, frontSkew: null, now,
            });

            const fallbackIv = currentRv != null ? currentRv / 100 : 0.4;
            const cands = wheelCandidates({
              ticker: sym.ticker, spot, quotes,
              preset, ivRank, supports: levels.supports, earnings, fallbackIv,
            });
            all.push(...cands);
            send({ type: "step", label: `${sym.ticker}: ${cands.filter((c) => !c.blocked).length} candidatos` });
          } catch {
            failed++;
            send({ type: "step", label: `${sym.ticker}: error` });
          }
        });

        all.sort((a, b) => {
          if (a.blocked !== b.blocked) return a.blocked ? 1 : -1;
          return (b.score?.total ?? 0) - (a.score?.total ?? 0);
        });

        const withCandidates = new Set(all.filter((c) => !c.blocked).map((c) => c.ticker)).size;
        send({
          type: "done",
          candidates: all,
          meta: {
            preset: preset.label,
            scanned: WHEEL_UNIVERSE.length,
            failed,
            withCandidates,
            degraded: failed > WHEEL_UNIVERSE.length / 2,
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Error inesperado en el escaneo.";
        send({ type: "error", message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
