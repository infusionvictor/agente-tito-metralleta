"use client";

import { useState } from "react";
import type { PaperTrade, TradeStats } from "@/lib/paperTrades";

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const px = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function contractLabel(t: PaperTrade): string {
  return `${t.ticker} $${px.format(t.strike)}${t.contractType === "call" ? "C" : "P"}`;
}

function expiryLabel(exp: string): string {
  const d = new Date(`${exp}T00:00:00Z`);
  return d.toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}

function pnlOf(t: PaperTrade): number | null {
  if (t.entryPrice == null) return null;
  const exit = t.exitPrice ?? t.lastPrice;
  if (exit == null) return null;
  return (exit - t.entryPrice) * 100 * t.contracts;
}

function StatusPill({ t }: { t: PaperTrade }) {
  const map: Record<PaperTrade["status"], string> = {
    pending: "st-vigente",
    active: "st-vigente",
    won: "st-vigente",
    lost: "st-expirado",
    expired: "st-expirado",
  };
  const label: Record<PaperTrade["status"], string> = {
    pending: "Pendiente",
    active: "Activa",
    won: "Ganada",
    lost: "Perdida",
    expired: "Expirada",
  };
  return <span className={`pill ${map[t.status]}`}>{label[t.status]}</span>;
}

function ContractsCell({
  t,
  onEdit,
}: {
  t: PaperTrade;
  onEdit: (id: string, contracts: number) => void;
}) {
  const [draft, setDraft] = useState(String(t.contracts));
  const editable = t.status === "pending" || t.status === "active";

  if (!editable) return <span className="num">{t.contracts}</span>;

  return (
    <input
      className="trades-contracts-input"
      inputMode="numeric"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const n = Number(draft);
        if (Number.isFinite(n) && n > 0 && Number.isInteger(n) && n !== t.contracts) {
          onEdit(t.id, n);
        } else {
          setDraft(String(t.contracts));
        }
      }}
      aria-label={`Contratos de ${contractLabel(t)}`}
    />
  );
}

function Row({
  t,
  onEditContracts,
  onCancel,
}: {
  t: PaperTrade;
  onEditContracts: (id: string, contracts: number) => void;
  onCancel: (id: string) => void;
}) {
  const pnl = pnlOf(t);
  const stopShown = t.stopPrice ?? t.stop;
  const trailing = t.stopPrice != null && t.stopPrice > t.stop;

  return (
    <tr id={`trade-${t.id}`}>
      <td>
        <span className="idea-ticker">{contractLabel(t)}</span>
        {t.source === "auto" && <span className="chip chip-neutral" title="Abierto por el piloto automático"> AUTO</span>}
        <div className="muted trades-exp">{expiryLabel(t.expiration)}</div>
      </td>
      <td>
        {t.direction === "up" ? "↑" : "↓"} {px.format(t.entryTrigger)}
      </td>
      <td className="num">{t.entryPrice != null ? `$${px.format(t.entryPrice)}` : "—"}</td>
      <td className="num">${px.format(t.target)}</td>
      <td className="num">
        ${px.format(stopShown)}
        {trailing && <span title="Stop dinámico ya apretado por el trailing"> 🔒</span>}
      </td>
      <td>
        <ContractsCell t={t} onEdit={onEditContracts} />
      </td>
      <td className="num">{t.probability != null ? `${t.probability}%` : "—"}</td>
      <td className={`num ${pnl == null ? "" : pnl >= 0 ? "up" : "down"}`}>
        {pnl == null ? "—" : `${pnl >= 0 ? "+" : ""}${money.format(pnl)}`}
        {t.status === "active" && pnl != null && <span className="muted"> (flotante)</span>}
      </td>
      <td>
        <StatusPill t={t} />
      </td>
      <td className="muted trades-verdict">{t.verdict ?? (t.note ? t.note : "—")}</td>
      <td>
        {t.status === "pending" && (
          <button className="star" title="Cancelar plan pendiente" onClick={() => onCancel(t.id)}>
            ✕
          </button>
        )}
      </td>
    </tr>
  );
}

function Group({
  title,
  rows,
  onEditContracts,
  onCancel,
}: {
  title: string;
  rows: PaperTrade[];
  onEditContracts: (id: string, contracts: number) => void;
  onCancel: (id: string) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <>
      <tr className="trades-group-head">
        <td colSpan={11}>
          {title} <span className="muted">({rows.length})</span>
        </td>
      </tr>
      {rows.map((t) => (
        <Row key={t.id} t={t} onEditContracts={onEditContracts} onCancel={onCancel} />
      ))}
    </>
  );
}

export default function TradesTable({
  trades,
  stats,
  onEditContracts,
  onCancel,
}: {
  trades: PaperTrade[];
  stats: TradeStats;
  onEditContracts: (id: string, contracts: number) => void;
  onCancel: (id: string) => void;
}) {
  const pending = trades.filter((t) => t.status === "pending");
  const active = trades.filter((t) => t.status === "active");
  const closed = trades
    .filter((t) => t.status === "won" || t.status === "lost" || t.status === "expired")
    .sort((a, b) => Date.parse(b.closedAt ?? "") - Date.parse(a.closedAt ?? ""));

  return (
    <>
      <div className="stats">
        <div className="stat">
          <div className="stat-label">P&L neto</div>
          <div className={`stat-value ${stats.netPnl >= 0 ? "up" : "down"}`}>
            {stats.netPnl >= 0 ? "+" : ""}
            {money.format(stats.netPnl)}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Aciertos</div>
          <div className="stat-value">
            {stats.wins}–{stats.losses}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Win rate</div>
          <div className="stat-value">{stats.winRate != null ? `${stats.winRate.toFixed(0)}%` : "—"}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Pendientes</div>
          <div className="stat-value">{stats.pending}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Activas</div>
          <div className="stat-value">{stats.active}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Expiradas</div>
          <div className="stat-value">{stats.expired}</div>
        </div>
      </div>

      {trades.length === 0 ? (
        <p className="muted empty-note">
          Todavía no hay trades. Creá un plan condicional arriba — no entra hasta que el
          subyacente cruce tu gatillo.
        </p>
      ) : (
        <div className="table-wrap">
          <table className="ideas-table trades-table">
            <thead>
              <tr>
                <th>Contrato</th>
                <th>Gatillo</th>
                <th className="num">Entrada</th>
                <th className="num">Objetivo</th>
                <th className="num">Stop</th>
                <th>Contratos</th>
                <th className="num">Prob.</th>
                <th className="num">P&L</th>
                <th>Estado</th>
                <th>Veredicto / nota</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <Group title="Pendientes" rows={pending} onEditContracts={onEditContracts} onCancel={onCancel} />
              <Group title="Activas" rows={active} onEditContracts={onEditContracts} onCancel={onCancel} />
              <Group title="Cerradas" rows={closed} onEditContracts={onEditContracts} onCancel={onCancel} />
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
