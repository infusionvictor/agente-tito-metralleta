"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import NavTabs from "@/app/components/NavTabs";
import type { EarningsResult } from "@/lib/earningsServer";

type ScanEvent =
  | { type: "step"; label: string }
  | { type: "done"; results: EarningsResult[] }
  | { type: "error"; message: string };

const VERDICT: Record<string, { label: string; color: string }> = {
  rica: { label: "IV RICA", color: "#12b76a" },
  justa: { label: "Justa", color: "#667085" },
  barata: { label: "Barata", color: "#f04438" },
  sin_datos: { label: "Sin datos", color: "#98a2b3" },
};

export default function EarningsPage() {
  const [results, setResults] = useState<EarningsResult[] | null>(null);
  const [steps, setSteps] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const scan = useCallback(() => {
    esRef.current?.close();
    setBusy(true);
    setError(null);
    setSteps([]);
    setResults(null);

    const es = new EventSource("/api/earnings-scan");
    esRef.current = es;
    es.onmessage = (ev) => {
      const d = JSON.parse(ev.data) as ScanEvent;
      if (d.type === "step") setSteps((s) => [...s.slice(-6), d.label]);
      else if (d.type === "done") {
        setResults(d.results);
        setBusy(false);
        es.close();
      } else if (d.type === "error") {
        setError(d.message);
        setBusy(false);
        es.close();
      }
    };
    es.onerror = () => {
      setError("Se cortó la conexión con el escáner.");
      setBusy(false);
      es.close();
    };
  }, []);

  useEffect(() => {
    scan();
    return () => esRef.current?.close();
  }, [scan]);

  return (
    <main className="ideas-page">
      <div className="hb">
        <div className="hb-brand">
          <div className="hb-logo">T</div>
          <div className="hb-name">Tito Metralleta</div>
          <div className="hb-chip">Earnings · IV Crush</div>
        </div>
        <NavTabs />
      </div>

      <div className="ideas-body">
        <section className="scorecard">
          <div className="score-main">
            <div className="score-cat">Escáner de Earnings — IV rica para vender prima</div>
            <div className="score-q">
              Ranquea nombres líquidos por qué tan cara está su IV frente a cuánto suelen
              moverse en earnings. Arriba = mejor candidato para vender prima (IV crush).
            </div>
          </div>
        </section>

        <div style={{ display: "flex", justifyContent: "flex-end", margin: "10px 0" }}>
          <button className="rescan" onClick={scan} disabled={busy}>
            {busy ? "Escaneando…" : "↻ Volver a escanear"}
          </button>
        </div>

        {busy && (
          <section className="scorecard">
            <h2 style={{ margin: 0 }}>Escaneando…</h2>
            <div className="muted" style={{ marginTop: 6 }}>
              {steps.map((s, i) => (
                <div key={i}>{s}</div>
              ))}
            </div>
          </section>
        )}

        {error && (
          <section className="scorecard" style={{ color: "#f04438" }}>
            ⚠ {error}
          </section>
        )}

        {results && results.length > 0 && (
          <div className="clusters">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Ticker</th>
                    <th>Veredicto</th>
                    <th className="num">IV ATM</th>
                    <th className="num">Richness</th>
                    <th>Flujo C/P</th>
                    <th className="num">Implícito</th>
                    <th className="num">Histórico</th>
                    <th className="num">Muestra</th>
                    <th>Próx. earnings*</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((r) => {
                    const v = VERDICT[r.verdict] ?? VERDICT.sin_datos;
                    return (
                      <tr key={r.ticker}>
                        <td>
                          <b>{r.ticker}</b>
                          {r.stale && (
                            <span title="data de opciones sin actualizar — no fiable" style={{ color: "#b42318" }}>
                              {" "}⚠
                            </span>
                          )}
                        </td>
                        <td>
                          <span style={{ color: v.color, fontWeight: 700 }}>{v.label}</span>
                        </td>
                        <td className="num" style={{ color: r.ivHigh ? "#f04438" : undefined, fontWeight: r.ivHigh ? 700 : undefined }}>
                          {r.ivPct != null ? `${r.ivPct.toFixed(0)}%${r.ivHigh ? " 🔥" : ""}` : "—"}
                        </td>
                        <td className="num">
                          <b>{r.richness != null ? `${r.richness.toFixed(2)}×` : "—"}</b>
                        </td>
                        <td>
                          {r.flow
                            ? (() => {
                                const skew = Math.abs(r.flow.callPct - r.flow.putPct);
                                const bull = r.flow.callPct >= r.flow.putPct;
                                return (
                                  <span style={{ fontWeight: skew >= 20 ? 700 : 400 }}>
                                    <span style={{ color: "#12b76a" }}>{r.flow.callPct}%C</span>
                                    {" / "}
                                    <span style={{ color: "#f04438" }}>{r.flow.putPct}%P</span>
                                    {skew >= 20 && (bull ? " 🟢" : " 🔴")}
                                  </span>
                                );
                              })()
                            : "—"}
                        </td>
                        <td className="num">
                          {r.impliedMovePct != null ? `±${r.impliedMovePct.toFixed(1)}%` : "—"}
                        </td>
                        <td className="num muted">
                          {r.histAvgMovePct != null ? `±${r.histAvgMovePct.toFixed(1)}%` : "—"}
                        </td>
                        <td className="num muted">{r.sample}</td>
                        <td className="muted">{r.nextEarnings ?? "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="muted" style={{ fontSize: "0.8em", marginTop: 8 }}>
              *Fecha estimada por cadencia de filing (proxy). Richness = implícito ÷ histórico;
              &gt;1.15 = IV rica (vender tiene ventaja). Con earnings el riesgo de gap es real:
              usa riesgo definido. No es consejo financiero.
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
