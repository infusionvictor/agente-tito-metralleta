"use client";

import { useState } from "react";
import type { TradeInput } from "@/lib/paperTrades";

const EMPTY = {
  ticker: "",
  contractType: "call" as "call" | "put",
  strike: "",
  expiration: "",
  direction: "up" as "up" | "down",
  entryTrigger: "",
  target: "",
  stop: "",
  trailingStopPct: "",
  probability: "",
  contracts: "1",
  note: "",
};

export default function TradeForm({
  onCreate,
  busy,
}: {
  onCreate: (input: TradeInput) => Promise<string | null>;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState(EMPTY);
  const [error, setError] = useState<string | null>(null);

  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setF((prev) => ({ ...prev, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const input: TradeInput = {
      ticker: f.ticker,
      contractType: f.contractType,
      strike: Number(f.strike),
      expiration: f.expiration,
      direction: f.direction,
      entryTrigger: Number(f.entryTrigger),
      target: Number(f.target),
      stop: Number(f.stop),
      trailingStopPct: f.trailingStopPct ? Number(f.trailingStopPct) : null,
      probability: f.probability ? Number(f.probability) : null,
      contracts: Number(f.contracts),
      note: f.note || null,
    };
    const err = await onCreate(input);
    if (err) {
      setError(err);
    } else {
      setF(EMPTY);
      setOpen(false);
    }
  };

  if (!open) {
    return (
      <button className="rescan" onClick={() => setOpen(true)}>
        + Nuevo trade (plan condicional)
      </button>
    );
  }

  return (
    <form className="card trade-form" onSubmit={submit}>
      <div className="card-title">Nuevo plan de trade — SIMULACIÓN</div>
      <p className="muted trade-form-note">
        No entra hasta que el subyacente cruce el gatillo. &quot;Probabilidad&quot; es tu
        estimación del setup, no una garantía.
      </p>

      <div className="trade-form-grid">
        <label>
          <span>Ticker</span>
          <input value={f.ticker} onChange={set("ticker")} placeholder="WULF" required />
        </label>
        <label>
          <span>Tipo</span>
          <select value={f.contractType} onChange={set("contractType")}>
            <option value="call">Call</option>
            <option value="put">Put</option>
          </select>
        </label>
        <label>
          <span>Strike</span>
          <input value={f.strike} onChange={set("strike")} inputMode="decimal" placeholder="20" required />
        </label>
        <label>
          <span>Vencimiento</span>
          <input type="date" value={f.expiration} onChange={set("expiration")} required />
        </label>
        <label>
          <span>Dirección del subyacente</span>
          <select value={f.direction} onChange={set("direction")}>
            <option value="up">Rompe hacia arriba</option>
            <option value="down">Rompe hacia abajo</option>
          </select>
        </label>
        <label>
          <span>Gatillo (nivel del subyacente)</span>
          <input value={f.entryTrigger} onChange={set("entryTrigger")} inputMode="decimal" placeholder="22.50" required />
        </label>
        <label>
          <span>Objetivo (prima de la opción)</span>
          <input value={f.target} onChange={set("target")} inputMode="decimal" placeholder="3.00" required />
        </label>
        <label>
          <span>Stop (prima de la opción)</span>
          <input value={f.stop} onChange={set("stop")} inputMode="decimal" placeholder="1.00" required />
        </label>
        <label>
          <span>Trailing stop % (opcional)</span>
          <input value={f.trailingStopPct} onChange={set("trailingStopPct")} inputMode="decimal" placeholder="20" />
        </label>
        <label>
          <span>Probabilidad % (opcional)</span>
          <input value={f.probability} onChange={set("probability")} inputMode="decimal" placeholder="65" />
        </label>
        <label>
          <span>Contratos</span>
          <input value={f.contracts} onChange={set("contracts")} inputMode="numeric" required />
        </label>
        <label className="trade-form-note-field">
          <span>Nota (opcional)</span>
          <input value={f.note} onChange={set("note")} placeholder="Muro de calls en 25, GEX apoya" />
        </label>
      </div>

      {error && <div className="error">⚠ {error}</div>}

      <div className="trade-form-actions">
        <button type="button" className="tf-btn" onClick={() => setOpen(false)}>
          Cancelar
        </button>
        <button type="submit" className="rescan" disabled={busy}>
          {busy ? "Guardando…" : "Crear plan pendiente"}
        </button>
      </div>
    </form>
  );
}
