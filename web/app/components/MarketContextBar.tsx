"use client";

import { useEffect, useState } from "react";

interface MarketSentiment {
  callPct: number;
  putPct: number;
  callPremium: number;
  putPremium: number;
  avgCallPremium: number;
  avgPutPremium: number;
}

function fmtM(n: number): string {
  return `$${(n / 1_000_000).toFixed(0)}M`;
}

/**
 * Contexto macro (no depende del ticker elegido): % de premium en calls vs puts
 * de TODO el mercado hoy, desde MarketSnack. Sirve para leer si el flujo de un
 * ticker específico va a favor o en contra de la corriente general — no toca
 * el scorecard por ticker, es un dato aparte.
 */
export default function MarketContextBar() {
  const [data, setData] = useState<MarketSentiment | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/sentiment")
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j?.error ?? `Respondió ${r.status}.`);
        return j as MarketSentiment;
      })
      .then((j) => { if (!cancelled) setData(j); })
      .catch((e) => { if (!cancelled) setErr(e instanceof Error ? e.message : "Error al cargar."); });
    return () => { cancelled = true; };
  }, []);

  if (err) return null; // contexto opcional: si falla, no bloquea el resto de la app
  if (!data) return null;

  const bullish = data.callPct >= data.putPct;
  const label = bullish ? "sesgo alcista" : "sesgo bajista";
  const color = bullish ? "#12b76a" : "#f04438";
  const vsAvgCall = data.avgCallPremium > 0 ? ((data.callPremium - data.avgCallPremium) / data.avgCallPremium) * 100 : null;

  return (
    <div className="card" style={{ padding: "12px 16px", flexDirection: "row", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      <div style={{ fontSize: 12, color: "#667085", fontWeight: 600 }}>MERCADO GENERAL HOY</div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <div style={{ width: 90, height: 8, borderRadius: 4, overflow: "hidden", display: "flex", background: "#f2f4f7" }}>
          <div style={{ width: `${data.putPct}%`, background: "#f04438" }} />
          <div style={{ width: `${data.callPct}%`, background: "#12b76a" }} />
        </div>
        <span style={{ fontSize: 13, fontWeight: 600, color }}>
          {data.callPct.toFixed(0)}% calls · {data.putPct.toFixed(0)}% puts — {label}
        </span>
      </div>
      <div style={{ fontSize: 12, color: "#667085" }}>
        Premium en calls hoy: {fmtM(data.callPremium)}
        {vsAvgCall != null && (
          <> ({vsAvgCall >= 0 ? "+" : ""}{vsAvgCall.toFixed(0)}% vs. promedio reciente)</>
        )}
      </div>
    </div>
  );
}
