"use client";

import { useState } from "react";
import type { AffordableCandidate } from "@/lib/wheelAfford";

const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const money2 = (n: number) => `$${n.toFixed(2)}`;
const pct = (n: number) => `${n.toFixed(1)}%`;

const SOURCE_LABEL: Record<string, string> = {
  bid: "bid real",
  ultimo: "último precio −10%",
  modelo: "modelo −15%",
};

export default function WheelTable({
  rows,
  view,
}: {
  rows: AffordableCandidate[];
  view: "estudiante" | "pro";
}) {
  if (rows.length === 0) {
    return <div className="card wheel-empty">Sin candidatos con este perfil. Prueba otro preset.</div>;
  }
  return (
    <div className="wheel-list">
      {rows.map((c) => (
        <WheelRow key={`${c.ticker}-${c.strike}-${c.expiration}`} c={c} view={view} />
      ))}
    </div>
  );
}

function WheelRow({ c, view }: { c: AffordableCandidate; view: "estudiante" | "pro" }) {
  const [open, setOpen] = useState(false);

  if (c.blocked) {
    return (
      <div className="card wheel-row blocked">
        <div className="wheel-row-head">
          <b>{c.ticker}</b> ${c.strike} · {c.expiration}
          <span className="wheel-tag danger">Ilíquido — no operable</span>
        </div>
        <p className="wheel-blocked-why">
          {c.blockReason === "sin_bid" && "Nadie está poniendo precio de compra: no podrías vender."}
          {c.blockReason === "spread_ancho" && "La horquilla es demasiado ancha: perderías dinero al entrar."}
          {c.blockReason === "oi_bajo" && "Muy pocos contratos abiertos: no hay con quién operar."}
          {c.blockReason === "sin_dato" && "Sin precio ni horquilla del proveedor: no hay con qué calcular la prima."}
        </p>
      </div>
    );
  }

  const m = c.metrics!;
  const s = c.score!;
  const p = c.premium!;

  return (
    <div className={`card wheel-row ${c.afford.affordable ? "" : "unafford"}`}>
      <button className="wheel-row-head" onClick={() => setOpen((v) => !v)} type="button">
        <span><b>{c.ticker}</b> ${c.strike} put · {c.expiration} ({c.dte}d)</span>
        <span className="wheel-score">{s.total}<small>/100</small></span>
      </button>

      {view === "estudiante" ? (
        <p className="wheel-plain">
          Si vendieras este put, cobrarías <b>{money(m.credit)}</b> y necesitas{" "}
          <b>{money(m.collateral)}</b> en efectivo retenido. Empiezas a perder por debajo de{" "}
          <b>{money2(m.breakeven)}</b>. Hay <b>{Math.round(m.probExpireWorthless)}%</b> de que expire sin valor y te quedes la prima.
          {!c.afford.affordable && <> Te faltan <b>{money(c.afford.shortfall)}</b> para poder venderlo.</>}
        </p>
      ) : (
        <div className="wheel-grid">
          <span>Prima <b>{money2(p.price)}</b> <small>({SOURCE_LABEL[p.source]})</small></span>
          <span>Δ <b>{c.delta.toFixed(2)}</b></span>
          <span>IV <b>{pct(c.iv * 100)}</b> <small>{c.ivSource === "estimada" ? "est." : "impl."}</small></span>
          <span>Anualizado <b>{pct(m.annualizedPct)}</b></span>
          <span>Colchón <b>{pct(m.cushionPct)}</b></span>
          <span>OI <b>{c.openInterest.toLocaleString()}</b></span>
          <span>Colateral <b>{money(m.collateral)}</b></span>
          {!c.afford.affordable && <span className="wheel-tag warn">faltan {money(c.afford.shortfall)}</span>}
        </div>
      )}

      {open && (
        <div className="wheel-outcomes">
          <div><b>Si expira sin valor</b> ({Math.round(m.probExpireWorthless)}%): te quedas {money(m.credit)} y se libera tu colateral.</div>
          <div><b>Si te asignan</b>: compras 100 acciones a ${c.strike}. Tu costo real queda en {money2(m.breakeven)} y empiezas a vender calls sobre ellas.</div>
          <div><b>Si se desploma 20%</b>: tendrías las acciones valiendo ~{money2(c.spot * 0.8)}, con pérdida no realizada frente a tu costo de {money2(m.breakeven)}.</div>
          <div className="wheel-why">
            {[s.annualized, s.ivRank, s.cushion, s.liquidity, s.earnings].map((part, i) => (
              <div key={i}>· {part.why}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
