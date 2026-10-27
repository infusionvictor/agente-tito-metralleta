"use client";

import { useCallback, useEffect, useState } from "react";
import AlertsList from "@/app/components/AlertsList";
import CertaintyPanel from "@/app/components/CertaintyPanel";
import NavTabs from "@/app/components/NavTabs";
import type { Alert } from "@/lib/alerts";
import type { StatsBreakdown } from "@/lib/paperTrades";

const ALERTS_LIMIT = 200;

export default function AlertsPage() {
  const [breakdown, setBreakdown] = useState<StatsBreakdown | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const [tradesRes, alertsRes] = await Promise.all([
      fetch("/api/trades"),
      fetch(`/api/alerts?limit=${ALERTS_LIMIT}`),
    ]);
    const tradesData = await tradesRes.json();
    const alertsData = await alertsRes.json();
    setBreakdown(tradesData.breakdown);
    setAlerts(alertsData.alerts ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <main className="ideas-page">
      <div className="hb">
        <div className="hb-brand">
          <div className="hb-logo">T</div>
          <div className="hb-name">Tito Metralleta</div>
          <div className="hb-chip">Certeza · piloto vs. manual</div>
        </div>
        <NavTabs />
      </div>

      <div className="ideas-body">
        <div className="card trades-disclaimer">
          <strong>⚠ SIMULACIÓN.</strong> Todo lo que ves acá es paper trading — el win rate mide
          qué tan seguido el setup se cumplió en la simulación, nunca una promesa de ganancia real.
        </div>

        {loading || !breakdown ? (
          <div className="card wheel-empty">Cargando…</div>
        ) : (
          <CertaintyPanel breakdown={breakdown} />
        )}

        <div className="card">
          <div className="card-title">Historial de alertas</div>
          <div className="card-sub">Cada alerta linkea al trade que abrió en Mis Trades.</div>
          <div className="certainty-alerts-list">
            <AlertsList alerts={alerts} />
          </div>
        </div>
      </div>
    </main>
  );
}
