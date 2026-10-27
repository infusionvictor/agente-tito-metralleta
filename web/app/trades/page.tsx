"use client";

import { useCallback, useEffect, useState } from "react";
import AlertsFeed from "@/app/components/AlertsFeed";
import NavTabs from "@/app/components/NavTabs";
import TradeForm from "@/app/components/TradeForm";
import TradesTable from "@/app/components/TradesTable";
import type { Alert } from "@/lib/alerts";
import type { PaperTrade, TradeInput, TradeStats } from "@/lib/paperTrades";

export default function TradesPage() {
  const [trades, setTrades] = useState<PaperTrade[]>([]);
  const [stats, setStats] = useState<TradeStats | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);

  const loadAlerts = useCallback(async () => {
    const res = await fetch("/api/alerts");
    const data = await res.json();
    setAlerts(data.alerts ?? []);
  }, []);

  const load = useCallback(async () => {
    const res = await fetch("/api/trades");
    const data = await res.json();
    setTrades(data.trades);
    setStats(data.stats);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    loadAlerts();
  }, [load, loadAlerts]);

  const scan = useCallback(async () => {
    setScanning(true);
    setError(null);
    setRefreshNote(null);
    try {
      const res = await fetch("/api/autopilot/scan", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "No se pudo escanear.");
        return;
      }
      const bits = [`${data.scanned} tickers escaneados`, `${data.createdTrades} trade(s) AUTO nuevo(s)`];
      if (data.degraded?.marketsnack) bits.push("vía swing degradada (sin flujo de MarketSnack)");
      if (data.errors?.length) bits.push(`${data.errors.length} ticker(s) con error`);
      setRefreshNote(bits.join(" · "));
      await Promise.all([load(), loadAlerts()]);
    } finally {
      setScanning(false);
    }
  }, [load, loadAlerts]);

  const createTrade = useCallback(
    async (input: TradeInput): Promise<string | null> => {
      setBusy(true);
      try {
        const res = await fetch("/api/trades", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        });
        const data = await res.json();
        if (!res.ok) return data.error ?? "No se pudo crear el trade.";
        setTrades(data.trades);
        setStats(data.stats);
        return null;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const editContracts = useCallback(async (id: string, contracts: number) => {
    const res = await fetch(`/api/trades/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contracts }),
    });
    const data = await res.json();
    if (res.ok) {
      setTrades(data.trades);
      setStats(data.stats);
    } else {
      setError(data.error ?? "No se pudo editar.");
    }
  }, []);

  const cancelTrade = useCallback(async (id: string) => {
    const res = await fetch(`/api/trades/${id}`, { method: "DELETE" });
    const data = await res.json();
    if (res.ok) {
      setTrades(data.trades);
      setStats(data.stats);
    } else {
      setError(data.error ?? "No se pudo cancelar.");
    }
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    setRefreshNote(null);
    try {
      const res = await fetch("/api/trades/refresh", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "No se pudo actualizar.");
        return;
      }
      setTrades(data.trades);
      setStats(data.stats);
      setRefreshNote(
        data.updated === 0
          ? "Sin cambios de estado."
          : `${data.updated} trade(s) actualizado(s).${data.errors?.length ? ` ${data.errors.length} con error de cotización.` : ""}`,
      );
    } finally {
      setRefreshing(false);
    }
  }, []);

  return (
    <main className="ideas-page">
      <div className="hb">
        <div className="hb-brand">
          <div className="hb-logo">T</div>
          <div className="hb-name">Tito Metralleta</div>
          <div className="hb-chip">Mis Trades · paper trading condicional</div>
        </div>
        <NavTabs />
      </div>

      <div className="ideas-body">
        <div className="card trades-disclaimer">
          <strong>⚠ SIMULACIÓN.</strong> Esto es una bitácora de paper trading — nunca coloca
          una orden real ni es consejo de inversión. &quot;Probabilidad&quot; describe un setup,
          no una promesa de ganancia. Ejecutás a mano en tu bróker si querés.
        </div>

        <div className="ideas-controls">
          <TradeForm onCreate={createTrade} busy={busy} />
          <button className="rescan" onClick={refresh} disabled={refreshing}>
            {refreshing ? "Actualizando…" : "↻ Actualizar precios"}
          </button>
          <button className="rescan" onClick={scan} disabled={scanning} title="Piloto automático — SIMULACIÓN, escanea el universo de la Wheel">
            {scanning ? "Escaneando…" : "🤖 Escanear ahora (piloto)"}
          </button>
        </div>

        {refreshNote && <p className="muted">{refreshNote}</p>}
        {error && <div className="error">⚠ {error}</div>}

        <AlertsFeed alerts={alerts} />

        {loading || !stats ? (
          <div className="card wheel-empty">Cargando tus trades…</div>
        ) : (
          <TradesTable trades={trades} stats={stats} onEditContracts={editContracts} onCancel={cancelTrade} />
        )}
      </div>
    </main>
  );
}
