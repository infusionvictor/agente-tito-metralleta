"use client";

import { useState } from "react";

interface TickerSentiment {
  ticker: string;
  sentiment: "bullish" | "bearish" | "neutral";
  unusualCount: number;
  premium: number;
}

interface SectorFlowResult {
  matched: boolean;
  sector?: string | null;
  sectorName?: string;
  ticker?: TickerSentiment;
  peers?: TickerSentiment[];
  agreeingCount?: number;
  label?: "sectorial" | "individual" | "sin_actividad";
}

const SENT_LABEL: Record<TickerSentiment["sentiment"], string> = {
  bullish: "🟢 alcista", bearish: "🔴 bajista", neutral: "⚪ neutral",
};

const LABEL_TEXT: Record<NonNullable<SectorFlowResult["label"]>, string> = {
  sectorial: "Flujo SECTORIAL — el sector completo se mueve junto, no es solo esta empresa.",
  individual: "Flujo INDIVIDUAL — conviction específica en esta empresa, el resto del sector está en calma.",
  sin_actividad: "Sin flujo inusual hoy en este ticker — no hay nada que comparar todavía.",
};

/**
 * Tarea 3 del Proceso Principal: compara el flujo del ticker contra los
 * líderes de su sector (lib/sectors.ts) para saber si la actividad de hoy es
 * sectorial o individual. On-demand (botón) porque cada comparación cuesta
 * varias llamadas más a MarketSnack — no se dispara solo al abrir el ticker.
 */
export default function SectorCard({ ticker }: { ticker: string }) {
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [data, setData] = useState<SectorFlowResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const run = async () => {
    setState("loading"); setErr(null);
    try {
      const r = await fetch(`/api/sector-flow?ticker=${encodeURIComponent(ticker)}`);
      const j: SectorFlowResult & { error?: string } = await r.json();
      if (!r.ok) throw new Error(j?.error ?? `Respondió ${r.status}.`);
      setData(j);
      setState("done");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error al comparar el sector.");
      setState("error");
    }
  };

  return (
    <section className="card">
      <div className="card-title">Comparación sectorial</div>
      <div className="card-sub">
        ¿El flujo de {ticker} es de todo su sector, o algo específico de esta empresa?
      </div>

      {state === "idle" && (
        <button type="button" className="hb-tab" style={{ alignSelf: "flex-start" }} onClick={run}>
          Comparar con el sector
        </button>
      )}
      {state === "loading" && <div className="card-sub">Revisando el flujo de los líderes del sector…</div>}
      {state === "error" && <div className="error">⚠ {err}</div>}

      {state === "done" && data && !data.matched && (
        <div className="card-sub">
          {data.sector
            ? `Sector "${data.sector}" sin un grupo de comparación curado todavía.`
            : "No se pudo determinar el sector de este ticker."}
        </div>
      )}

      {state === "done" && data?.matched && data.label && (
        <>
          <div className="card-sub"><b>Sector:</b> {data.sectorName}</div>
          <div style={{ fontWeight: 600 }}>{LABEL_TEXT[data.label]}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
            <div>
              <b>{ticker}</b> — {data.ticker && SENT_LABEL[data.ticker.sentiment]}
              {data.ticker && data.ticker.unusualCount > 0 && ` (${data.ticker.unusualCount} trades inusuales)`}
            </div>
            {(data.peers ?? []).map((p) => (
              <div key={p.ticker} style={{ color: "#667085" }}>
                {p.ticker} — {SENT_LABEL[p.sentiment]}
                {p.unusualCount > 0 && ` (${p.unusualCount} trades inusuales)`}
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
