"use client";

import { useEffect, useState } from "react";

// Earnings IV-Crush: ¿la IV precia MÁS de lo que la acción suele moverse en earnings?
// Se auto-obtiene de /api/earnings para no engordar page.tsx.
// Ver docs/superpowers/specs/2026-07-27-earnings-iv-crush-design.md

type Verdict = "rica" | "justa" | "barata" | "sin_datos";

interface Spread {
  kind: "bull_put" | "bear_call";
  shortStrike: number;
  longStrike: number;
  width: number;
  credit: number;
  maxLoss: number;
  breakeven: number;
  riskReward: number;
  probOTM: number;
  shortWallStrength: number | null;
}

interface EarningsData {
  spreads: { putSpread: Spread | null; callSpread: Spread | null } | null;
  impliedMovePct: number | null;
  histAvgMovePct: number | null;
  histMedianPct: number | null;
  histMaxPct: number | null;
  richness: number | null;
  sample: number;
  verdict: Verdict;
  moves: number[];
  spot: number | null;
  nextEarnings: string | null;
  method: "straddle" | "iv" | null;
  ivPct: number | null;
  ivHigh: boolean;
  sigmaPct: number | null;
  sigmaAbs: number | null;
  flow: { callPct: number; putPct: number } | null;
  stale: boolean;
  straddle: { strike: number; expiration: string; dte: number } | null;
  spreadsExtremos: {
    byDelta: { putSpread: Spread | null; callSpread: Spread | null };
    bySigma: { putSpread: Spread | null; callSpread: Spread | null };
  } | null;
}

const VERDICT: Record<Verdict, { label: string; sub: string; color: string }> = {
  rica: { label: "IV RICA", sub: "vender prima tiene ventaja", color: "#12b76a" },
  justa: { label: "IV JUSTA", sub: "sin edge claro", color: "#667085" },
  barata: { label: "IV BARATA", sub: "no conviene vender prima", color: "#f04438" },
  sin_datos: { label: "Sin datos", sub: "histórico insuficiente (<4 earnings)", color: "#98a2b3" },
};

function SpreadRow({ s, onSave, saved }: { s: Spread; onSave?: (s: Spread) => void; saved?: boolean }) {
  const isPut = s.kind === "bull_put";
  return (
    <div
      style={{
        border: "1px solid #eceff3",
        borderRadius: 8,
        padding: "8px 10px",
        fontSize: "0.85em",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, gap: 8 }}>
        <b>{isPut ? "🔻 Vender PUT spread" : "🔺 Vender CALL spread"}</b>
        <span className="muted">
          ${s.shortStrike} / ${s.longStrike} · ancho ${s.width}
        </span>
        {onSave && (
          <button
            onClick={() => onSave(s)}
            disabled={saved}
            style={{
              marginLeft: "auto",
              border: "1px solid #d0d5dd",
              borderRadius: 6,
              background: saved ? "#ecfdf3" : "#fff",
              color: saved ? "#12b76a" : "#344054",
              cursor: saved ? "default" : "pointer",
              fontSize: "0.9em",
              padding: "1px 8px",
            }}
          >
            {saved ? "✓ Guardado" : "⭐ Guardar"}
          </button>
        )}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px" }}>
        <span>
          Crédito <b style={{ color: "#12b76a" }}>${Math.round(s.credit * 100)}</b>
        </span>
        <span>
          Máx pérdida <b style={{ color: "#f04438" }}>${s.maxLoss}</b>
        </span>
        <span>
          Break-even <b>${s.breakeven}</b>
        </span>
        <span>
          R/R <b>1:{s.riskReward.toFixed(2)}</b>
        </span>
        <span>
          ProbOTM <b>{s.probOTM}%</b>
        </span>
      </div>
    </div>
  );
}

interface TradeLite {
  id: string;
  savedAt: string;
  kind: "bull_put" | "bear_call";
  shortStrike: number;
  longStrike: number;
  credit: number;
  spotAtEntry: number | null;
  ivAtEntry: number | null;
  richnessAtEntry: number | null;
}

export default function EarningsCard({ ticker }: { ticker: string }) {
  const [data, setData] = useState<EarningsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [trades, setTrades] = useState<TradeLite[]>([]);
  const [savedKeys, setSavedKeys] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!ticker) return;
    let alive = true;
    setLoading(true);
    setData(null);
    setSavedKeys({});
    fetch(`/api/earnings?ticker=${encodeURIComponent(ticker)}`)
      .then((r) => r.json())
      .then((d) => {
        if (alive && d && !d.error) setData(d as EarningsData);
      })
      .catch(() => {})
      .finally(() => alive && setLoading(false));
    fetch(`/api/earnings-trades?ticker=${encodeURIComponent(ticker)}`)
      .then((r) => r.json())
      .then((d) => {
        if (alive) setTrades(d.trades ?? []);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [ticker]);

  const spreadKey = (s: Spread) => `${s.kind}-${s.shortStrike}-${s.longStrike}`;

  const saveTrade = (s: Spread) => {
    if (!data) return;
    fetch("/api/earnings-trades", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ticker,
        kind: s.kind,
        shortStrike: s.shortStrike,
        longStrike: s.longStrike,
        width: s.width,
        credit: s.credit,
        expiration: data.straddle?.expiration ?? null,
        earningsDate: data.nextEarnings ?? null,
        spotAtEntry: data.spot,
        ivAtEntry: data.ivPct,
        richnessAtEntry: data.richness,
        flowAtEntry: data.flow,
      }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.trades) setTrades(d.trades);
        setSavedKeys((k) => ({ ...k, [spreadKey(s)]: true }));
      })
      .catch(() => {});
  };

  if (loading) {
    return (
      <section className="scorecard">
        <div className="muted" style={{ padding: "8px 4px" }}>
          Calculando move implícito vs histórico de earnings…
        </div>
      </section>
    );
  }
  if (!data) return null;

  const v = VERDICT[data.verdict];
  const implied = data.impliedMovePct;
  const avg = data.histAvgMovePct;
  const scale = Math.max(implied ?? 0, data.histMaxPct ?? 0, 1);

  const Bar = ({ pct, color }: { pct: number | null; color: string }) => (
    <div style={{ height: 10, background: "#eceff3", borderRadius: 5, overflow: "hidden" }}>
      <div
        style={{
          width: `${Math.min(((pct ?? 0) / scale) * 100, 100)}%`,
          height: "100%",
          background: color,
          borderRadius: 5,
        }}
      />
    </div>
  );

  return (
    <section className="scorecard">
      <div className="score-main">
        <div className="score-cat">Earnings · IV Crush</div>
        <div className="score-q">¿La IV precia más de lo que la acción suele moverse?</div>
      </div>

      <div className="score-detail">
        {data.stale && (
          <div
            style={{
              background: "#fef3f2",
              color: "#b42318",
              border: "1px solid #fecdca",
              borderRadius: 8,
              padding: "8px 10px",
              marginBottom: 10,
              fontSize: "0.85em",
              fontWeight: 600,
            }}
          >
            ⚠ Data de opciones SIN ACTUALIZAR (de una sesión anterior). Si la acción ya
            reportó o el mercado recién abrió, la IV y el veredicto de abajo <b>NO son
            fiables</b> — espera a que las opciones operen hoy.
          </div>
        )}
        <div
          className="score-verdict"
          style={{ color: v.color, display: "flex", alignItems: "baseline", gap: 8 }}
        >
          {v.label}
          {data.richness != null && (
            <span style={{ fontWeight: 800 }}>· {data.richness.toFixed(2)}×</span>
          )}
          <span className="muted" style={{ fontWeight: 400, fontSize: "0.85em" }}>
            {v.sub}
          </span>
        </div>

        {/* IV del ATM + σ del frente + flag de IV alta */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", fontSize: "0.85em", marginTop: 6 }}>
          {data.ivPct != null && (
            <span>
              IV ATM <b style={{ color: data.ivHigh ? "#f04438" : undefined }}>{data.ivPct.toFixed(0)}%</b>
              {data.ivHigh && (
                <span
                  style={{ marginLeft: 6, background: "#fee4e2", color: "#f04438", borderRadius: 6, padding: "1px 6px", fontWeight: 700, fontSize: "0.85em" }}
                >
                  🔥 IV &gt;100%
                </span>
              )}
            </span>
          )}
          {data.sigmaPct != null && (
            <span className="muted">
              σ (1σ, vto. cercano) <b>±{data.sigmaPct.toFixed(1)}%</b>
              {data.sigmaAbs != null && ` (±$${data.sigmaAbs.toFixed(0)})`}
            </span>
          )}
          {data.flow && (
            <span>
              Flujo{" "}
              <b style={{ color: "#12b76a" }}>{data.flow.callPct}%C</b>
              {" / "}
              <b style={{ color: "#f04438" }}>{data.flow.putPct}%P</b>
              {Math.abs(data.flow.callPct - data.flow.putPct) >= 20 && (
                <span className="muted">
                  {" "}
                  — cargado a {data.flow.callPct >= data.flow.putPct ? "calls 🟢" : "puts 🔴"}
                </span>
              )}
            </span>
          )}
        </div>

        {trades.length > 0 && (
          <div
            style={{
              marginTop: 10,
              background: "#f8f9fc",
              border: "1px solid #eaecf0",
              borderRadius: 8,
              padding: "8px 10px",
            }}
          >
            <div style={{ fontWeight: 700, fontSize: "0.85em", marginBottom: 4 }}>
              📌 Tus trades anteriores en {ticker} ({trades.length}) —{" "}
              <span className="muted">referencia para este earnings</span>
            </div>
            <div style={{ display: "grid", gap: 3, fontSize: "0.8em" }}>
              {trades.slice(0, 5).map((t) => (
                <div key={t.id} className="muted">
                  {new Date(t.savedAt).toLocaleDateString()} ·{" "}
                  <b>{t.kind === "bull_put" ? "PUT" : "CALL"} ${t.shortStrike}/${t.longStrike}</b> ·
                  crédito ${Math.round(t.credit * 100)}
                  {t.spotAtEntry != null && ` · spot $${t.spotAtEntry.toFixed(0)}`}
                  {t.ivAtEntry != null && ` · IV ${t.ivAtEntry.toFixed(0)}%`}
                  {t.richnessAtEntry != null && ` · rich ${t.richnessAtEntry.toFixed(2)}×`}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Barras comparativas implícito vs histórico */}
        <div style={{ display: "grid", gap: 10, margin: "12px 0" }}>
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.85em" }}>
              <span>
                Move <b>implícito</b>
                {data.straddle && (
                  <span className="muted">
                    {" "}
                    (straddle ${data.straddle.strike} · {data.straddle.expiration})
                  </span>
                )}
              </span>
              <b style={{ color: "#2e6be6" }}>
                {implied != null ? `±${implied.toFixed(1)}%` : "—"}
              </b>
            </div>
            <Bar pct={implied} color="#2e6be6" />
          </div>
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.85em" }}>
              <span>
                Move <b>histórico</b> (prom.){" "}
                <span className="muted">— {data.sample} earnings</span>
              </span>
              <b>{avg != null ? `±${avg.toFixed(1)}%` : "—"}</b>
            </div>
            <Bar pct={avg} color="#98a2b3" />
          </div>
        </div>

        {data.sample > 0 && (
          <div className="muted" style={{ fontSize: "0.85em" }}>
            Histórico: mediana ±{data.histMedianPct?.toFixed(1)}% · máx ±{data.histMaxPct?.toFixed(1)}%
            {data.moves.length > 0 && ` · [${data.moves.map((m) => `${m.toFixed(1)}%`).join(" · ")}]`}
          </div>
        )}

        {data.spreads && (data.spreads.putSpread || data.spreads.callSpread) && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontWeight: 700, fontSize: "0.9em", marginBottom: 6 }}>
              Credit spread — elige UN lado{" "}
              <span className="muted">— |Δ|≈0.20 · fuera de 1σ · vende el extremo, no condor</span>
            </div>
            <div style={{ display: "grid", gap: 8 }}>
              {data.spreads.putSpread && (
                <SpreadRow
                  s={data.spreads.putSpread}
                  onSave={saveTrade}
                  saved={savedKeys[spreadKey(data.spreads.putSpread)]}
                />
              )}
              {data.spreads.callSpread && (
                <SpreadRow
                  s={data.spreads.callSpread}
                  onSave={saveTrade}
                  saved={savedKeys[spreadKey(data.spreads.callSpread)]}
                />
              )}
            </div>
          </div>
        )}

        {data.spreadsExtremos &&
          (data.spreadsExtremos.byDelta.putSpread ||
            data.spreadsExtremos.byDelta.callSpread ||
            data.spreadsExtremos.bySigma.putSpread ||
            data.spreadsExtremos.bySigma.callSpread) && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontWeight: 700, fontSize: "0.9em", marginBottom: 6 }}>
                Ventas en los extremos <span className="muted">— más OTM, ideal con IV alta</span>
              </div>
              <div style={{ fontSize: "0.8em", color: "#667085", margin: "2px 0 4px" }}>
                Delta ≈ 0.10 (≈90% OTM)
              </div>
              <div style={{ display: "grid", gap: 8, marginBottom: 8 }}>
                {data.spreadsExtremos.byDelta.putSpread && (
                  <SpreadRow
                    s={data.spreadsExtremos.byDelta.putSpread}
                    onSave={saveTrade}
                    saved={savedKeys[spreadKey(data.spreadsExtremos.byDelta.putSpread)]}
                  />
                )}
                {data.spreadsExtremos.byDelta.callSpread && (
                  <SpreadRow
                    s={data.spreadsExtremos.byDelta.callSpread}
                    onSave={saveTrade}
                    saved={savedKeys[spreadKey(data.spreadsExtremos.byDelta.callSpread)]}
                  />
                )}
              </div>
              <div style={{ fontSize: "0.8em", color: "#667085", margin: "2px 0 4px" }}>
                ±2σ (las colas)
              </div>
              <div style={{ display: "grid", gap: 8 }}>
                {data.spreadsExtremos.bySigma.putSpread && (
                  <SpreadRow
                    s={data.spreadsExtremos.bySigma.putSpread}
                    onSave={saveTrade}
                    saved={savedKeys[spreadKey(data.spreadsExtremos.bySigma.putSpread)]}
                  />
                )}
                {data.spreadsExtremos.bySigma.callSpread && (
                  <SpreadRow
                    s={data.spreadsExtremos.bySigma.callSpread}
                    onSave={saveTrade}
                    saved={savedKeys[spreadKey(data.spreadsExtremos.bySigma.callSpread)]}
                  />
                )}
              </div>
            </div>
          )}

        <div
          className="iv-special"
          style={{ marginTop: 12, background: "#fff7ed", padding: 10, borderRadius: 8 }}
        >
          ⚠ <b>Riesgo de gap:</b> el delta/probabilidad <b>subestima</b> el riesgo en earnings
          (colas gordas). Vende con <b>riesgo definido</b> (spreads), no desnudo. Fechas de
          earnings por proxy de filing. Esto es data del agente, no consejo financiero.
        </div>
      </div>
    </section>
  );
}
