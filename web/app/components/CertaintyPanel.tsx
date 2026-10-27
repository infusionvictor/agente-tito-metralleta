"use client";

import type { StatsBreakdown, TradeStats } from "@/lib/paperTrades";

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

function SegmentCard({ title, sub, s }: { title: string; sub: string; s: TradeStats }) {
  const total = s.wins + s.losses + s.pending + s.active + s.expired;
  return (
    <div className="card certainty-card">
      <div className="card-title">{title}</div>
      <div className="card-sub">{sub}</div>
      {total === 0 ? (
        <p className="muted empty-note certainty-empty">Sin trades todavía.</p>
      ) : (
        <div className="stats certainty-stats">
          <div className="stat">
            <div className="stat-label">P&L neto</div>
            <div className={`stat-value ${s.netPnl >= 0 ? "up" : "down"}`}>
              {s.netPnl >= 0 ? "+" : ""}
              {money.format(s.netPnl)}
            </div>
          </div>
          <div className="stat">
            <div className="stat-label">Win rate</div>
            <div className="stat-value">{s.winRate != null ? `${s.winRate.toFixed(0)}%` : "—"}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Aciertos</div>
            <div className="stat-value">
              {s.wins}–{s.losses}
            </div>
          </div>
          <div className="stat">
            <div className="stat-label">En curso</div>
            <div className="stat-value">{s.pending + s.active}</div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Certeza por segmento: separa lo tuyo (manual) de lo del piloto, y dentro del piloto por vía. */
export default function CertaintyPanel({ breakdown }: { breakdown: StatsBreakdown }) {
  return (
    <div className="certainty-grid">
      <SegmentCard title="Tus trades manuales" sub="Lo que armaste vos" s={breakdown.manual} />
      <SegmentCard title="Piloto — todo" sub="Todo lo que abrió el piloto, cualquier vía" s={breakdown.auto} />
      <SegmentCard title="Piloto · Intradía" sub="GEX + dirección + niveles" s={breakdown.autoIntraday} />
      <SegmentCard title="Piloto · Swing" sub="Flujo institucional + acierto histórico" s={breakdown.autoSwing} />
    </div>
  );
}
