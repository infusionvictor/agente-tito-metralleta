"use client";

import { useEffect, useState } from "react";
import type { CompanyInfo } from "@/lib/types";
import { pct, px } from "../format";
import NavTabs from "./NavTabs";

const QUICK = ["TSLA", "NVDA", "SPY", "AAPL"];

/**
 * Botón de vigilancia proactiva de niveles (ver /api/watch/scan): avisa por
 * Discord si el precio cruza de verdad un soporte/resistencia real de este
 * ticker, sin que tengas que estar mirando la pantalla. Complementa el
 * escaneo de todo el mercado (/ideas, resumen matutino) — es la "lupa" para
 * lo que ya decidiste que te importa.
 */
function WatchToggle({ ticker }: { ticker: string }) {
  const [watched, setWatched] = useState<boolean | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setErr(null);
    fetch("/api/watch")
      .then((r) => r.json())
      .then((j) => { if (!cancelled) setWatched((j.tickers ?? []).includes(ticker)); })
      .catch(() => { if (!cancelled) setWatched(false); });
    return () => { cancelled = true; };
  }, [ticker]);

  const toggle = async () => {
    setErr(null);
    try {
      if (watched) {
        const r = await fetch(`/api/watch?ticker=${encodeURIComponent(ticker)}`, { method: "DELETE" });
        const j = await r.json();
        setWatched((j.tickers ?? []).includes(ticker));
      } else {
        const r = await fetch("/api/watch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ticker }),
        });
        const j = await r.json();
        if (!r.ok) { setErr(j?.error ?? "No se pudo agregar."); return; }
        setWatched((j.tickers ?? []).includes(ticker));
      }
    } catch {
      setErr("Error de red.");
    }
  };

  if (watched == null) return null;
  return (
    <button
      type="button"
      className="hb-tab"
      title={err ?? (watched ? `Dejar de vigilar ${ticker}` : `Avisar por Discord si ${ticker} rompe un nivel real`)}
      style={watched ? { background: "#eef2ff", color: "#4338ca" } : undefined}
      onClick={toggle}
    >
      {watched ? "👁 Vigilando" : "👁 Vigilar"}
    </button>
  );
}

export default function HeaderBar({
  ticker,
  company,
  busy,
  onSearch,
}: {
  ticker: string | null;
  company: CompanyInfo | null;
  busy: boolean;
  onSearch: (t: string) => void;
}) {
  const [q, setQ] = useState("");

  const submit = () => {
    const t = q.trim().toUpperCase();
    if (!t || busy) return;
    setQ("");
    onSearch(t);
  };

  return (
    <div className="hb">
      <div className="hb-brand">
        <div className="hb-logo">T</div>
        <div className="hb-name">Tito Metralleta</div>
        <div className="hb-chip">AI Options Agent</div>
      </div>
      <NavTabs />
      <div className="hb-tabs">
        {QUICK.map((s) => (
          <button
            key={s}
            type="button"
            className={`hb-tab ${ticker === s ? "on" : ""}`}
            onClick={() => !busy && onSearch(s)}
          >
            {s}
          </button>
        ))}
      </div>
      <input
        className="hb-search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
        placeholder="Buscar ticker…"
        spellCheck={false}
      />
      <div className="hb-right">
        {company && (
          <>
            <div className="hb-ticker-name">{company.name ?? company.ticker}</div>
            {company.price != null && <div className="hb-price">${px.format(company.price)}</div>}
            {company.changePercent != null && (
              <div className="hb-chg" style={{ color: company.changePercent >= 0 ? "#12b76a" : "#f04438" }}>
                {pct.format(company.changePercent)}%
              </div>
            )}
          </>
        )}
        {ticker && <WatchToggle ticker={ticker} />}
      </div>
    </div>
  );
}
