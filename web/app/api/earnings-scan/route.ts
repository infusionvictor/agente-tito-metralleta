// GET /api/earnings-scan — escanea un watchlist de nombres líquidos, calcula el "IV rica"
// (implícito vs histórico) de cada uno y los devuelve ranqueados. SSE con progreso.
// Ver docs/superpowers/specs/2026-07-27-earnings-iv-crush-design.md

import { computeEarnings, type EarningsResult } from "@/lib/earningsServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Nombres líquidos con opciones activas. La IV rica sube sola cuando el earnings se acerca,
// así que ranquear por richness hace flotar a los que reportan pronto.
const WATCHLIST = [
  "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META",
  "TSLA", "AMD", "NFLX", "MU", "PLTR", "BE",
];

const CONCURRENCY = 4;

function sse(e: unknown): string {
  return `data: ${JSON.stringify(e)}\n\n`;
}

export async function GET() {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: unknown) => controller.enqueue(encoder.encode(sse(e)));
      try {
        send({ type: "step", label: `Escaneando ${WATCHLIST.length} tickers por IV rica…` });

        const results: EarningsResult[] = [];
        const queue = [...WATCHLIST];
        let done = 0;

        const worker = async () => {
          while (queue.length) {
            const t = queue.shift();
            if (!t) break;
            try {
              results.push(await computeEarnings(t, { withSpreads: false }));
            } catch {
              /* se salta este ticker */
            }
            done++;
            send({ type: "step", label: `${done}/${WATCHLIST.length} — ${t}` });
          }
        };

        await Promise.all(Array.from({ length: CONCURRENCY }, worker));

        // Ranking: PRIORIDAD a IV alta (>100%), luego por richness (IV rica).
        results.sort((a, b) => {
          if (a.ivHigh !== b.ivHigh) return a.ivHigh ? -1 : 1;
          return (b.richness ?? -1) - (a.richness ?? -1);
        });

        send({ type: "done", results });
        controller.close();
      } catch {
        send({ type: "error", message: "No se pudo correr el escáner de earnings." });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
