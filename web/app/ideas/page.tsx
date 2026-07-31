"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HORIZONS } from "@/lib/prediction";
import { sizeFlow, type RiskProfile } from "@/lib/risk";
import RiskProfileCard, { DEFAULT_PROFILE, loadProfile } from "@/app/components/RiskProfileCard";
import IdeasTable, { type SizedIdea } from "@/app/components/IdeasTable";
import WatchlistCard from "@/app/components/WatchlistCard";
import NavTabs from "@/app/components/NavTabs";
import {
  brokerById,
  buildEntry,
  remove,
  upsert,
  type OutboxItem,
  type OutboxTarget,
  type WatchlistEntry,
} from "@/lib/watchlist";
import {
  hasMigrated,
  loadBroker,
  loadEntries,
  markMigrated,
  saveBroker,
  saveEntries,
} from "@/lib/watchlistLocal";
import type { Idea, IdeasEvent, IdeasMeta } from "./types";

const KEY_VIEW = "tito.view";
const KEY_HORIZON = "tito.ideas.horizon";

const HORIZON_LABELS: Record<number, string> = {
  10: "Esta semana",
  20: "2 semanas",
  30: "1 mes",
};

export default function IdeasPage() {
  const [profile, setProfile] = useState<RiskProfile>(DEFAULT_PROFILE);
  const [view, setView] = useState<"estudiante" | "pro">("estudiante");
  const [horizonDays, setHorizonDays] = useState(20);

  const [ideas, setIdeas] = useState<Idea[] | null>(null);
  const [meta, setMeta] = useState<IdeasMeta | null>(null);
  const [steps, setSteps] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const [watchlist, setWatchlist] = useState<WatchlistEntry[]>([]);
  const [broker, setBroker] = useState("none");
  const [pending, setPending] = useState<OutboxItem[]>([]);
  const [failed, setFailed] = useState<OutboxItem[]>([]);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);

  /** Toda respuesta de /api/watchlist trae el mismo trío; se aplica en un sitio. */
  const applySync = useCallback(
    (d: { pending?: OutboxItem[]; failed?: OutboxItem[]; lastSyncedAt?: string | null }) => {
      setPending(d.pending ?? []);
      setFailed(d.failed ?? []);
      setLastSyncedAt(d.lastSyncedAt ?? null);
    },
    [],
  );

  // El perfil y las preferencias viven en localStorage: se leen tras montar
  // para no romper la hidratación del servidor.
  useEffect(() => {
    setProfile(loadProfile());
    const v = window.localStorage.getItem(KEY_VIEW);
    if (v === "pro" || v === "estudiante") setView(v);
    const h = Number(window.localStorage.getItem(KEY_HORIZON));
    if (HORIZONS.some((o) => o.days === h)) setHorizonDays(h);
  }, []);

  // El watchlist vive en el navegador, no en el servidor: guarda tu saldo y tu sizing,
  // igual que el perfil de riesgo. Al servidor solo sube el ticker, y solo si el broker
  // elegido sincroniza por MCP.
  //
  // `wlRef` es la copia siempre-fresca. Sin ella, marcar una estrella mientras la carga
  // inicial sigue en vuelo escribía sobre un estado vacío y se perdía lo ya guardado
  // —pasó de verdad: el WULF migrado desapareció al marcar el siguiente contrato—.
  const wlRef = useRef<WatchlistEntry[]>([]);

  const applyWatchlist = useCallback((next: WatchlistEntry[]) => {
    wlRef.current = next;
    setWatchlist(next);
    saveEntries(next);
  }, []);

  useEffect(() => {
    const b = loadBroker();
    setBroker(b);
    applyWatchlist(loadEntries());

    // Importación única del viejo data/watchlist.json, para no perder lo ya marcado.
    fetch(`/api/watchlist?broker=${encodeURIComponent(b)}`)
      .then((r) => r.json())
      .then((d: {
        pending: OutboxItem[];
        failed?: OutboxItem[];
        lastSyncedAt?: string | null;
        legacy?: { entries: WatchlistEntry[]; broker: string };
      }) => {
        applySync(d);
        if (hasMigrated() || !d.legacy?.entries?.length) return;
        // Se fusiona sobre lo que haya AHORA, no sobre lo que había al empezar el fetch.
        applyWatchlist(d.legacy.entries.reduce((acc, e) => upsert(acc, e), wlRef.current));
        if (d.legacy.broker && d.legacy.broker !== "none" && b === "none") {
          setBroker(d.legacy.broker);
          saveBroker(d.legacy.broker);
        }
        markMigrated();
      })
      .catch(() => null); // sin red el watchlist local ya está cargado
  }, [applyWatchlist]);

  const starred = useMemo(
    () => new Set(watchlist.map((e) => e.symbol)),
    [watchlist],
  );

  /**
   * Encola el contrato solo si el broker escribe de verdad (MCP). Los demás usan enlace.
   * Se manda entero y es el servidor quien lo recorta según la granularidad del broker,
   * para que la regla de qué viaja viva en un solo sitio (`addToOutbox`).
   */
  const enqueue = useCallback(async (contract: OutboxTarget, brokerId: string) => {
    if (brokerById(brokerId)?.kind !== "mcp") return;
    try {
      const res = await fetch("/api/watchlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contract, broker: brokerId }),
      });
      if (res.ok) applySync(await res.json());
    } catch {
      // el watchlist local ya quedó guardado; la cola se reintenta al recargar
    }
  }, []);

  const toggleStar = useCallback(
    async ({ idea, sizing }: SizedIdea) => {
      const current = wlRef.current;
      const isOn = current.some((e) => e.symbol === idea.symbol);
      applyWatchlist(
        isOn
          ? remove(current, idea.symbol)
          : upsert(
              current,
              buildEntry(
                {
                  symbol: idea.symbol, ticker: idea.ticker, type: idea.type,
                  strike: idea.strike, expiration: idea.expiration, dte: idea.dte,
                  price: idea.price, assetPrice: idea.assetPrice,
                  premium: idea.premium, thetaPctDaily: idea.thetaPctDaily,
                },
                sizing,
                profile,
                new Date(),
              ),
            ),
      );
      if (!isOn) {
        await enqueue(
          {
            symbol: idea.symbol, ticker: idea.ticker, type: idea.type,
            strike: idea.strike, expiration: idea.expiration,
          },
          broker,
        );
      }
    },
    [profile, broker, enqueue, applyWatchlist],
  );

  const changeBroker = useCallback(
    async (id: string) => {
      setBroker(id);
      saveBroker(id);
      // Al estrenar un broker por MCP hay que encolar lo ya marcado, no solo lo futuro.
      // Se recorren los contratos, no los tickers: si el broker es `underlying_only`,
      // `addToOutbox` colapsa los del mismo subyacente en una sola entrada.
      if (brokerById(id)?.kind === "mcp") {
        for (const e of wlRef.current) {
          await enqueue(
            {
              symbol: e.symbol, ticker: e.ticker, type: e.type,
              strike: e.strike, expiration: e.expiration,
            },
            id,
          );
        }
      } else {
        setPending([]);
        setFailed([]);
      }
    },
    [enqueue],
  );

  const unstar = useCallback(
    async (symbol: string) => {
      const gone = wlRef.current.find((e) => e.symbol === symbol);
      const next = remove(wlRef.current, symbol);
      applyWatchlist(next);

      // Cómo se desencola depende de lo que el broker tenga encolado. Con `contracts`
      // la cola guarda este contrato, así que se quita él. Con `underlying_only` guarda
      // el subyacente, y ese solo sobra cuando ya no queda ningún contrato del ticker.
      if (!gone) return;
      // Con `contracts` van símbolo Y ticker: el ticker es lo único que alcanza a las
      // filas viejas de solo-tickers, que con el símbolo a secas quedaban imborrables
      // (ver `removeFromOutbox`). No arrastra los strikes hermanos.
      const granularity = brokerById(broker)?.granularity;
      const query =
        granularity === "contracts"
          ? `symbol=${encodeURIComponent(gone.symbol)}&ticker=${encodeURIComponent(gone.ticker)}`
          : next.some((e) => e.ticker === gone.ticker)
            ? null
            : `ticker=${encodeURIComponent(gone.ticker)}`;
      if (!query) return;

      try {
        const res = await fetch(
          `/api/watchlist?${query}&broker=${encodeURIComponent(broker)}`,
          { method: "DELETE" },
        );
        if (res.ok) applySync(await res.json());
      } catch {
        // sin red no pasa nada: la cola se recalcula al recargar
      }
    },
    [broker, applyWatchlist],
  );

  const pickView = (v: "estudiante" | "pro") => {
    setView(v);
    window.localStorage.setItem(KEY_VIEW, v);
  };
  const pickHorizon = (d: number) => {
    setHorizonDays(d);
    window.localStorage.setItem(KEY_HORIZON, String(d));
  };

  // quiet=true (auto-refresco): no borra la tabla actual mientras rescanea, así
  // los datos viejos se mantienen visibles hasta que llegan los nuevos.
  const scan = useCallback((quiet = false) => {
    esRef.current?.close();
    setBusy(true);
    setError(null);
    if (!quiet) {
      setSteps([]);
      setIdeas(null);
      setMeta(null);
    }

    const es = new EventSource("/api/ideas");
    esRef.current = es;

    es.onmessage = (ev) => {
      const data = JSON.parse(ev.data) as IdeasEvent;
      if (data.type === "step") {
        setSteps((s) => [...s, data.label]);
      } else if (data.type === "done") {
        setIdeas(data.ideas);
        setMeta(data.meta);
        setLastUpdated(new Date());
        setBusy(false);
        es.close();
      } else if (data.type === "error") {
        setError(data.message);
        setBusy(false);
        es.close();
      }
    };
    es.onerror = () => {
      setError("Se cortó la conexión con el escáner.");
      setBusy(false);
      es.close();
    };
  }, []);

  // Escaneo al montar + AUTO-REFRESCO cada 15 min mientras la pestaña está
  // visible (silencioso). También refresca al volver a la pestaña si pasó rato.
  useEffect(() => {
    scan();
    const REFRESH_MS = 15 * 60 * 1000;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") scan(true);
    }, REFRESH_MS);
    return () => {
      window.clearInterval(id);
      esRef.current?.close();
    };
  }, [scan]);

  // El sizing se calcula aquí, en el cliente: el servidor nunca ve el saldo.
  const rows: SizedIdea[] = useMemo(() => {
    if (!ideas) return [];
    return ideas
      .map((idea) => ({
        idea,
        sizing: sizeFlow(
          {
            price: idea.price, theta: idea.theta, thetaPctDaily: idea.thetaPctDaily,
            dte: idea.dte, expiryStatus: "vigente",
          } as Parameters<typeof sizeFlow>[0],
          profile,
          horizonDays,
        ),
      }))
      .sort((a, b) => {
        // Primero lo que sí puedes operar, y dentro de eso el dinero más grande.
        const ok = (s: SizedIdea) => (s.sizing.blocked || s.sizing.maxContracts === 0 ? 1 : 0);
        return ok(a) - ok(b) || b.idea.premium - a.idea.premium;
      });
  }, [ideas, profile, horizonDays]);

  const operables = rows.filter((r) => !r.sizing.blocked && r.sizing.maxContracts > 0).length;

  return (
    <main className="ideas-page">
      <div className="hb">
        <div className="hb-brand">
          <div className="hb-logo">T</div>
          <div className="hb-name">Tito Metralleta</div>
          <div className="hb-chip">Ideas del mercado</div>
        </div>
        <NavTabs />
      </div>

      <div className="ideas-body">
        <RiskProfileCard profile={profile} onChange={setProfile} />

        <WatchlistCard
          entries={watchlist}
          broker={broker}
          pending={pending}
          failed={failed}
          lastSyncedAt={lastSyncedAt}
          onBrokerChange={changeBroker}
          onRemove={unstar}
        />

        <div className="ideas-controls">
          <div className="view-toggle">
            <button className={view === "estudiante" ? "active" : ""} onClick={() => pickView("estudiante")}>
              👤 Estudiante
            </button>
            <button className={view === "pro" ? "active" : ""} onClick={() => pickView("pro")}>
              ⚡ Pro
            </button>
          </div>

          <div className="horizon-toggle">
            {HORIZONS.map((o) => (
              <button
                key={o.days}
                className={horizonDays === o.days ? "active" : ""}
                onClick={() => pickHorizon(o.days)}
              >
                {HORIZON_LABELS[o.days] ?? o.label}
              </button>
            ))}
          </div>

          <button className="rescan" onClick={() => scan()} disabled={busy}>
            {busy ? "Escaneando…" : "↻ Volver a escanear"}
          </button>

          {lastUpdated && (
            <span className="ideas-updated muted" title="Se refresca solo cada 15 minutos mientras la pestaña esté abierta">
              {busy ? "Actualizando…" : `Actualizado ${lastUpdated.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" })} · auto cada 15 min`}
            </span>
          )}
        </div>

        {busy && (
          <section className="loader-box">
            <h2>Escaneando el mercado…</h2>
            <ul className="steps">
              {steps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </section>
        )}

        {error && (
          <section className="error-box">
            <strong>No se pudo escanear.</strong>
            <p>{error}</p>
            <p className="muted">
              Si menciona la sesión de MarketSnack, hay que refrescar
              <code> MARKETSNACK_COOKIE</code> en <code>web/.env.local</code>.
            </p>
          </section>
        )}

        {ideas && meta && !busy && (
          <>
            <div className="ideas-summary">
              <h1>
                {operables} {operables === 1 ? "idea operable" : "ideas operables"}
                {rows.length > operables && (
                  <span className="muted"> · {rows.length - operables} descartadas</span>
                )}
              </h1>
              <p className="muted">
                Escaneadas {meta.scanned.toLocaleString("en-US")} operaciones de ≥$
                {(meta.minPremium / 1000).toFixed(0)}K en {meta.tickers} tickers.
                Historial disponible en {meta.withHistory} de ellos.
              </p>
              {meta.rejected && (
                <p className="muted filter-note">
                  El filtro de calidad tumbó{" "}
                  <strong>{meta.rejected.theta_alto}</strong> contratos por theta alto (lotería),{" "}
                  <strong>{meta.rejected.vencido}</strong> por vencer demasiado pronto,{" "}
                  <strong>{meta.rejected.sin_theta}</strong> sin theta en el feed y{" "}
                  <strong>{meta.rejected.no_inusual}</strong> por no ser flujo inusual.
                </p>
              )}
            </div>

            <IdeasTable
              rows={rows}
              profile={profile}
              view={view}
              horizonDays={horizonDays}
              starred={starred}
              onStar={toggleStar}
            />

            <p className="disclaimer muted">
              El tamaño se calcula sobre el precio al que se ejecutó cada flow, no sobre la
              cotización viva del contrato — el feed no la entrega. Los flows son del día, así
              que la diferencia es pequeña, pero el número es una referencia, no una orden.
              Material educativo: <strong>no es consejo financiero</strong>.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
