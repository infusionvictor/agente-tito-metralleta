// GET /api/chain?ticker=XXX — transmite los pasos del proceso por SSE y al final los datos.

import { countExpirations, sortByOpenInterestDesc, toRow } from "@/lib/compute";
import { structureScore } from "@/lib/structure";
import { saveChainSnapshot, type ChainSnapshot } from "@/lib/chainStore";
import { fetchCompany, fetchOptionChain, MassiveError } from "@/lib/massive";
import type { ChainEvent, ChainMeta, Row } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sse(event: ChainEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

// Caché read-through en memoria (por proceso). La cadena cambia poco intradía y
// el plan de Massive limita fuerte; re-paginar 40 páginas en cada visita es lo
// que hacía la app lenta. Guardamos los eventos finales por ticker y los
// servimos al instante mientras estén frescos.
const CHAIN_TTL_MS = 10 * 60 * 1000;
const chainCache = new Map<string, { at: number; events: ChainEvent[] }>();

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = (searchParams.get("ticker") ?? "").trim().toUpperCase();

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ChainEvent) =>
        controller.enqueue(encoder.encode(sse(event)));

      try {
        if (!ticker) {
          send({ type: "error", message: "Escribe un ticker (p. ej. AAPL)." });
          return;
        }

        // Cache hit: servir al instante sin re-consultar Massive.
        const cached = chainCache.get(ticker);
        if (cached && Date.now() - cached.at < CHAIN_TTL_MS) {
          const mins = Math.round((Date.now() - cached.at) / 60000);
          send({ type: "step", label: `Cadena en caché de ${ticker} (hace ${mins} min)…` });
          for (const e of cached.events) send(e);
          return;
        }

        send({ type: "step", label: `Buscando información de ${ticker}…` });
        const company = await fetchCompany(ticker);
        send({ type: "company", company });

        send({ type: "step", label: "Conectando con Massive…" });

        const { contracts, underlyingPrice, pages, truncated } =
          await fetchOptionChain(ticker, {
            onPage: (page, accumulated) => {
              send({
                type: "step",
                label: `Descargando option chain de ${ticker} — página ${page}`,
                detail: `${accumulated} contratos`,
              });
            },
          });

        if (contracts.length === 0) {
          send({ type: "error", message: `Sin contratos para "${ticker}".` });
          return;
        }

        let rows: Row[] = contracts.map(toRow);
        const expirations = countExpirations(rows);
        send({
          type: "step",
          label: `Consolidando ${rows.length} contratos en ${expirations} vencimientos…`,
        });

        send({ type: "step", label: "Calculando Open Premium por strike…" });
        send({ type: "step", label: "Calculando Valor Nocional…" });

        send({ type: "step", label: "Ordenando por Open Interest (mayor → menor)…" });
        rows = sortByOpenInterestDesc(rows);

        send({ type: "step", label: "Analizando acumulación por strike y vencimiento…" });
        const structure = structureScore(rows);

        // Foto diaria de la cadena: el historial de 45 días se acumula hacia adelante.
        send({ type: "step", label: "Guardando foto diaria de la cadena…" });
        let history: ChainSnapshot[] = [];
        try {
          history = (await saveChainSnapshot(ticker, structure)).snapshots;
        } catch {
          // el guardado no debe romper el reporte
        }

        const meta: ChainMeta = {
          ticker,
          underlyingPrice,
          contractCount: rows.length,
          expirationCount: expirations,
          pages,
          truncated,
        };
        const doneEvent: ChainEvent = { type: "done", rows, meta, structure, history };
        // Guardar en caché los eventos que un cache-hit debe reproducir (company + done).
        chainCache.set(ticker, {
          at: Date.now(),
          events: [{ type: "company", company }, doneEvent],
        });
        send(doneEvent);
      } catch (err) {
        const message =
          err instanceof MassiveError
            ? err.message
            : "Error inesperado al consultar Massive.";
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
