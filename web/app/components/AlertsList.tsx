"use client";

import type { Alert } from "@/lib/alerts";

const PATH_LABEL: Record<Alert["path"], string> = {
  intraday: "Intradía · GEX+niveles",
  swing: "Swing · flujo institucional",
};

function contractLabel(a: Alert): string {
  const side = a.contractType === "call" ? "C" : "P";
  return `$${a.strike.toFixed(2)}${side} · ${a.expiration}`;
}

function timeLabel(ts: string): string {
  try {
    return new Date(ts).toLocaleString("es-ES", {
      day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return ts;
  }
}

/** Fila cruda de alertas — la usan tanto el feed compacto de /trades como el panel de /alerts. */
export default function AlertsList({ alerts }: { alerts: Alert[] }) {
  if (alerts.length === 0) {
    return (
      <p className="muted empty-note">
        El piloto todavía no abrió ningún trade AUTO. Corré un escaneo o esperá a la
        próxima corrida programada.
      </p>
    );
  }

  return (
    <div className="tf-list">
      {alerts.map((a) => (
        <div key={a.id} className="tf-row">
          <div className="tf-body">
            <div className="tf-title">
              <a className={`pill ${a.direction === "up" ? "call" : "put"}`} href={`/trades#trade-${a.tradeId}`}>
                {a.ticker} {a.direction === "up" ? "↑" : "↓"}
              </a>{" "}
              <span className="chip chip-neutral">{PATH_LABEL[a.path]}</span>{" "}
              probabilidad {a.probability}%
            </div>
            <div className="tf-sub">
              {contractLabel(a)} — gatillo ${a.entryTrigger.toFixed(2)} · compra objetivo ${a.target.toFixed(2)} ·
              stop ${a.stop.toFixed(2)}
            </div>
            <div className="tf-sub">{a.reasoning}</div>
          </div>
          <div className="tf-prem muted">{timeLabel(a.createdAt)}</div>
        </div>
      ))}
    </div>
  );
}
