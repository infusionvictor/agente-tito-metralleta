"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AggressionScore, ConvictionScore, FlowRow } from "@/lib/flow";
import type { ChainEvent, ChainMeta, CompanyInfo, DailyBar, Row } from "@/lib/types";
import type { StructureScore } from "@/lib/structure";
import type { IvContextScore } from "@/lib/ivcontext";
import type { ValidationScore } from "@/lib/validation";
import type { ChainSnapshot } from "@/lib/chainStore";
import { gexAnalysis, type TradeLite } from "@/lib/gex";
import { gexHeatmap, type HeatTrade } from "@/lib/gexHeatmap";
import { predictPro } from "@/lib/prediction";
import { findLevels, type ChainLevel, type FlowLevel } from "@/lib/levels";
import { int } from "./format";
import HeaderBar from "./components/HeaderBar";
import MarketContextBar from "./components/MarketContextBar";
import AnalysisLoader from "./components/AnalysisLoader";
import VeredictoCard from "./components/VeredictoCard";
import EscenariosCard from "./components/EscenariosCard";
import SimpleChart from "./components/SimpleChart";
import NivelesSimples from "./components/NivelesSimples";
import ContextoLinea from "./components/ContextoLinea";
import MemoriaCard from "./components/MemoriaCard";
import SentimentCard, { type SentimentPart } from "./components/SentimentCard";
import PredictionCard from "./components/PredictionCard";
import ActivityCard from "./components/ActivityCard";
import MoneyFlowCard from "./components/MoneyFlowCard";
import NewsCard from "./components/NewsCard";
import SectorCard from "./components/SectorCard";
import LevelsCard from "./components/LevelsCard";
import ProWallsCard from "./components/ProWallsCard";
import GexHeatmapCard from "./components/GexHeatmapCard";
import TradesFeed from "./components/TradesFeed";
import CompanyHeader from "./components/CompanyHeader";
import ScorecardPanel from "./components/ScorecardPanel";
import AggressionScoreCard from "./components/AggressionScoreCard";
import ConvictionCard from "./components/ConvictionCard";
import ConvictionTransactions, { type ConvictionMeta } from "./components/ConvictionTransactions";
import UnusualityCard, { type UnusualityMeta, type UnusualRow } from "./components/UnusualityCard";
import StructureCard from "./components/StructureCard";
import IvContextCard from "./components/IvContextCard";
import ValidationCard from "./components/ValidationCard";
import FlowPriceChart from "./components/FlowPriceChart";
import OptionChainTable from "./components/OptionChainTable";
import ChartPanel from "./ChartPanel";

interface FlowMeta { ticker: string; notableCount: number; shown: number }
type FlowEvent =
  | { type: "step"; label: string; detail?: string }
  | {
      type: "done";
      rows: FlowRow[];
      score: AggressionScore;
      conviction?: ConvictionScore;
      convictionRows?: FlowRow[];
      convictionMeta?: ConvictionMeta;
      unusuality?: UnusualityMeta;
      unusualRows?: UnusualRow[];
      ivContext?: IvContextScore | null;
      meta: FlowMeta;
    }
  | { type: "error"; message: string };

export default function Dashboard() {
  const [ticker, setTicker] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<string[]>([]);

  const [company, setCompany] = useState<CompanyInfo | null>(null);
  const [chainRows, setChainRows] = useState<Row[] | null>(null);
  const [chainMeta, setChainMeta] = useState<ChainMeta | null>(null);
  const [bars, setBars] = useState<DailyBar[] | null>(null);
  const [structure, setStructure] = useState<StructureScore | null>(null);
  const [chainHistory, setChainHistory] = useState<ChainSnapshot[]>([]);

  const [aggScore, setAggScore] = useState<AggressionScore | null>(null);
  const [conviction, setConviction] = useState<ConvictionScore | null>(null);
  const [convRows, setConvRows] = useState<FlowRow[] | null>(null);
  const [convMeta, setConvMeta] = useState<ConvictionMeta | null>(null);
  const [unusuality, setUnusuality] = useState<UnusualityMeta | null>(null);
  const [unusualRows, setUnusualRows] = useState<UnusualRow[] | null>(null);
  const [ivContext, setIvContext] = useState<IvContextScore | null>(null);
  const [validation, setValidation] = useState<ValidationScore | null>(null);
  const [notable, setNotable] = useState<FlowRow[] | null>(null);
  const [flowMeta, setFlowMeta] = useState<FlowMeta | null>(null);

  const [chainErr, setChainErr] = useState<string | null>(null);
  const [flowErr, setFlowErr] = useState<string | null>(null);
  const [barsErr, setBarsErr] = useState<string | null>(null);
  const [showChain, setShowChain] = useState(false);
  const [horizonDays, setHorizonDays] = useState(20);
  const [view, setView] = useState<"estudiante" | "pro">("estudiante");
  // Sesgo histórico (memoria) para auto-corregir los targets, y si ya se leyó.
  const [calib, setCalib] = useState<{ biasPct: number | null; samples: number }>({ biasPct: null, samples: 0 });
  const [calibReady, setCalibReady] = useState(false);

  const chainEs = useRef<EventSource | null>(null);
  const flowEs = useRef<EventSource | null>(null);
  const chainDoneRef = useRef(true);
  const flowDoneRef = useRef(true);
  const finish = () => { if (chainDoneRef.current && flowDoneRef.current) setBusy(false); };

  const top5 = useMemo(() => {
    if (!chainRows) return [];
    return [...chainRows].sort((a, b) => b.notionalValue - a.notionalValue).slice(0, 5);
  }, [chainRows]);

  // % del premium notable que está en calls — la dirección del dinero que la
  // bandera de contradicción confronta contra las noticias.
  const callPct = useMemo(() => {
    if (!convRows || convRows.length === 0) return null;
    let call = 0, put = 0;
    for (const r of convRows) {
      if (r.type === "call") call += r.premium;
      else if (r.type === "put") put += r.premium;
    }
    return call + put > 0 ? Math.round((call / (call + put)) * 100) : null;
  }, [convRows]);

  // GEX (Gamma Exposure) — nodos de concentración + predicción (nodo imán).
  // Se calcula una vez con toda la cadena de Massive + los trades reales.
  const gex = useMemo(() => {
    if (!chainRows || chainRows.length === 0 || !bars || bars.length === 0) return null;
    const spot = company?.price ?? chainMeta?.underlyingPrice ?? bars[bars.length - 1].close;
    if (!spot || spot <= 0) return null;
    // Une convicción + inusuales (dedupe por id) como los trades reales.
    const seen = new Set<number>();
    const trades: TradeLite[] = [];
    for (const r of [...(convRows ?? []), ...(unusualRows ?? [])]) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      trades.push({ strike: r.strike, type: r.type, premium: r.premium, gamma: r.gamma });
    }
    return gexAnalysis({
      rows: chainRows,
      closes: bars.map((b) => b.close),
      spot,
      trades,
      convictionScore: conviction?.score ?? null,
      structureScore: structure?.score ?? null,
      lowLiquidity: structure?.notional.lowLiquidity ?? false,
      now: new Date(),
    });
  }, [chainRows, bars, company, chainMeta, convRows, unusualRows, conviction, structure]);

  // Heatmap de GEX por strike × vencimiento — abre el GEX en sus dos dimensiones.
  const heatmap = useMemo(() => {
    if (!chainRows || chainRows.length === 0 || !gex || !(gex.spot > 0)) return null;
    const seen = new Set<number>();
    const trades: HeatTrade[] = [];
    for (const r of [...(convRows ?? []), ...(unusualRows ?? [])]) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      trades.push({ strike: r.strike, expiration: r.expiration, gamma: r.gamma, premium: r.premium });
    }
    return gexHeatmap({ rows: chainRows, spot: gex.spot, iv: gex.iv, trades, now: new Date() });
  }, [chainRows, gex, convRows, unusualRows]);

  // Prediction Pro — junta los 6 sub-agentes, el mapa GEX y la σ en tres escenarios.
  const prediction = useMemo(() => {
    if (!gex || !(gex.spot > 0)) return null;
    return predictPro({
      spot: gex.spot,
      iv: gex.iv,
      horizonDays,
      nodes: gex.nodes.map((n) => ({
        strike: n.strike, concentration: n.concentration, side: n.side, netGex: n.netGex,
      })),
      scores: {
        aggression: aggScore?.score ?? null,
        conviction: conviction?.score ?? null,
        unusuality: unusuality?.score ?? null,
        structure: structure?.score ?? null,
        ivContext: ivContext?.score ?? null,
        validation: validation?.score ?? null,
      },
      regime: gex.regime,
      callPct,
      hitRate: validation?.hitRate.value ?? null,
      lowLiquidity: gex.lowLiquidity,
      calibration: calib,
    });
  }, [gex, horizonDays, aggScore, conviction, unusuality, structure, ivContext, validation, callPct, calib]);

  // Memoria del agente: guarda la predicción del día (una vez por ticker/sesión). El
  // dedupe por fecha ET vive en el servidor, así que reenviar el mismo día no duplica.
  const savedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!ticker || !prediction || prediction.caveat || !(prediction.spot > 0)) return;
    // Esperar a leer el sesgo: así se guarda el target YA calibrado, no el crudo.
    if (!calibReady) return;
    if (savedRef.current === ticker) return;
    savedRef.current = ticker;
    fetch("/api/prediction", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ticker,
        snapshot: {
          spot: prediction.spot,
          horizonDays: prediction.horizonDays,
          bear: prediction.bear.target,
          base: prediction.base.target,
          bull: prediction.bull.target,
          direction: prediction.direction,
          confidence: prediction.confidence,
        },
      }),
    }).catch(() => {});
  }, [ticker, prediction, calibReady]);

  // Los 3 flows de mayor premium — lo que sostiene la lectura.
  const topFlows = useMemo(() => {
    const seen = new Set<number>();
    const all: FlowRow[] = [];
    for (const r of [...(convRows ?? []), ...(notable ?? [])]) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      all.push(r);
    }
    return all.sort((a, b) => b.premium - a.premium).slice(0, 3);
  }, [convRows, notable]);

  // Soportes y resistencias: pivotes del precio × muros de opciones.
  const levels = useMemo(() => {
    if (!bars || bars.length === 0) return null;
    const spot = company?.price ?? chainMeta?.underlyingPrice ?? bars[bars.length - 1].close;
    if (!spot || spot <= 0) return null;

    const chain: ChainLevel[] = (chainRows ?? []).map((r) => ({
      strike: r.strike,
      contractType: r.contractType,
      openInterest: r.openInterest,
      notionalValue: r.notionalValue,
    }));
    const seen = new Set<number>();
    const flows: FlowLevel[] = [];
    for (const r of [...(convRows ?? []), ...(notable ?? [])]) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      flows.push({ strike: r.strike, type: r.type, aggression: r.aggression, premium: r.premium });
    }
    return findLevels({
      bars, spot, chain, flows,
      gex: gex?.nodes.map((n) => ({ strike: n.strike, netGex: n.netGex })) ?? [],
      now: new Date(),
    });
  }, [bars, company, chainMeta, chainRows, convRows, notable, gex]);

  const addStep = (s: string) => setSteps((p) => (p[p.length - 1] === s ? p : [...p, s]));

  function runSearch(t: string) {
    const tk = t.trim().toUpperCase();
    if (!tk || busy) return;
    chainEs.current?.close();
    flowEs.current?.close();
    setTicker(tk);
    setBusy(true);
    setSteps([]);
    setCompany(null); setChainRows(null); setChainMeta(null); setBars(null);
    setStructure(null); setChainHistory([]);
    setAggScore(null); setConviction(null); setConvRows(null); setConvMeta(null);
    setUnusuality(null); setUnusualRows(null); setIvContext(null); setValidation(null);
    setNotable(null); setFlowMeta(null);
    setChainErr(null); setFlowErr(null); setBarsErr(null);
    chainDoneRef.current = false; flowDoneRef.current = false;
    setShowChain(false);
    setCalib({ biasPct: null, samples: 0 }); setCalibReady(false); savedRef.current = null;

    // Backtest del sub-agente 6 sobre los flows ya guardados (no bloquea las streams).
    fetch(`/api/validation?ticker=${encodeURIComponent(tk)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: ValidationScore | null) => { if (d && !("error" in d)) setValidation(d); })
      .catch(() => {});

    // Memoria: lee el sesgo histórico ANTES de fijar el target para auto-corregirlo.
    // Es rápido (JSON + barras cacheadas) y termina mucho antes que las streams.
    fetch(`/api/prediction?ticker=${encodeURIComponent(tk)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { biasPct?: number | null; maturedCount?: number; error?: string } | null) => {
        if (d && !d.error) setCalib({ biasPct: d.biasPct ?? null, samples: d.maturedCount ?? 0 });
      })
      .catch(() => {})
      .finally(() => setCalibReady(true));

    // Stream 1 — Massive: empresa + option chain + estructura
    const c = new EventSource(`/api/chain?ticker=${encodeURIComponent(tk)}`);
    chainEs.current = c;
    c.onmessage = (ev) => {
      const d = JSON.parse(ev.data) as ChainEvent;
      if (d.type === "step") addStep(d.label);
      else if (d.type === "company") setCompany(d.company);
      else if (d.type === "done") {
        setChainRows(d.rows); setChainMeta(d.meta); setStructure(d.structure ?? null);
        setChainHistory(d.history ?? []);
        chainDoneRef.current = true; finish(); c.close();
        fetch(`/api/history?ticker=${encodeURIComponent(d.meta.ticker)}`)
          .then(async (r) => {
            const h = await r.json();
            // Si Massive falla acá (rate limit, blip), NO hay que fingir que "sin barras"
            // es un resultado válido: sin barras, GEX/Predicción se quedan mudos para
            // siempre sin ningún aviso. Se muestra el motivo y se deja `bars` en null
            // para no confundir "vacío legítimo" con "falló la carga".
            if (!r.ok) throw new Error(h?.error ?? `Massive respondió ${r.status}.`);
            setBars(Array.isArray(h.bars) ? h.bars : []);
          })
          .catch((err) => {
            setBarsErr(err instanceof Error ? err.message : "No se pudo cargar el histórico diario.");
          });
      } else if (d.type === "error") { setChainErr(d.message); chainDoneRef.current = true; finish(); c.close(); }
    };
    c.onerror = () => { chainDoneRef.current = true; finish(); c.close(); };

    // Stream 2 — MarketSnack: agresividad + convicción + inusualidad
    const f = new EventSource(`/api/flow?ticker=${encodeURIComponent(tk)}`);
    flowEs.current = f;
    f.onmessage = (ev) => {
      const d = JSON.parse(ev.data) as FlowEvent;
      if (d.type === "step") addStep(d.label);
      else if (d.type === "done") {
        setNotable(d.rows); setAggScore(d.score);
        setConviction(d.conviction ?? null);
        setConvRows(d.convictionRows ?? null);
        setConvMeta(d.convictionMeta ?? null);
        setUnusuality(d.unusuality ?? null);
        setUnusualRows(d.unusualRows ?? null);
        setIvContext(d.ivContext ?? null);
        setFlowMeta(d.meta); flowDoneRef.current = true; finish(); f.close();
      } else if (d.type === "error") { setFlowErr(d.message); flowDoneRef.current = true; finish(); f.close(); }
    };
    f.onerror = () => { flowDoneRef.current = true; finish(); f.close(); };
  }

  const started = steps.length > 0 || company != null || aggScore != null;

  // Los promedios de cada sub-agente = las señales del sentiment (y de Prediction Pro).
  const sentimentParts: SentimentPart[] = [
    { name: "Agresividad", note: "¿Compran al ask con fuerza?", score: aggScore?.score ?? null, weight: 20 },
    { name: "Convicción", note: "¿Cuánto dinero real entró?", score: conviction?.score ?? null, weight: 20 },
    { name: "Inusualidad", note: "¿Es flujo anormal? (griegos)", score: unusuality?.score ?? null, weight: 20 },
    { name: "Estructura", note: "¿Dónde se acumula el dinero?", score: structure?.score ?? null, weight: 15 },
    { name: "Contexto IV", note: "¿IV limpia o inflada?", score: ivContext?.score ?? null, weight: 10 },
    { name: "Confirmación de Precio", note: "¿El precio valida o absorbe?", score: validation?.score ?? null, weight: 15 },
  ];

  return (
    <>
      <HeaderBar ticker={ticker} company={company} busy={busy} onSearch={runSearch} />
      <main className="wrap page-stack">

        <MarketContextBar />

        {!started && !busy && (
          <div className="card" style={{ alignItems: "center", padding: "48px 24px", textAlign: "center" }}>
            <div style={{ fontSize: 20, fontWeight: 700 }}>Analiza un ticker</div>
            <div className="card-sub" style={{ maxWidth: 480 }}>
              Elige un ticker arriba (o búscalo) y el agente armará el sentiment score, el flujo
              inusual, los muros de strikes y el detalle completo de cada sub-agente.
            </div>
          </div>
        )}

        {busy && <AnalysisLoader ticker={ticker} steps={steps} />}

        {chainErr && <div className="error">⚠ Option chain: {chainErr}</div>}
        {flowErr && <div className="error">⚠ Flujo: {flowErr}</div>}
        {barsErr && (
          <div className="error">
            ⚠ Histórico diario: {barsErr} — GEX, niveles y Prediction Pro necesitan estas barras y
            se quedan sin calcular hasta que vuelvas a buscar el ticker.
          </div>
        )}

        {started && ticker && (
          <>
            <div className="view-toggle-row">
              <div className="view-toggle">
                <button className={view === "estudiante" ? "active" : ""} onClick={() => setView("estudiante")}>
                  👤 Estudiante
                </button>
                <button className={view === "pro" ? "active" : ""} onClick={() => setView("pro")}>
                  ⚡ Pro
                </button>
              </div>
            </div>

            {view === "estudiante" && (
              <>
                <VeredictoCard ticker={ticker} prediction={prediction} horizonDays={horizonDays} />

                {/* El selector de horizonte va pegado a la gráfica que controla:
                    si flota a la misma distancia que una sección, deja de leerse
                    como su control. */}
                <div className="stack-tight">
                  <div className="view-toggle-row">
                    <div className="view-toggle">
                      {[[10, "Esta semana"], [20, "2 semanas"], [30, "1 mes"]].map(([d, lbl]) => (
                        <button
                          key={d as number}
                          className={horizonDays === d ? "active" : ""}
                          onClick={() => setHorizonDays(d as number)}
                        >
                          {lbl}
                        </button>
                      ))}
                    </div>
                  </div>

                  <SimpleChart
                    ticker={ticker}
                    spot={gex?.spot ?? company?.price ?? chainMeta?.underlyingPrice ?? 0}
                    iv={gex?.iv ?? 0.4}
                    horizonDays={horizonDays}
                    scenarios={prediction ? { bear: prediction.bear.target, base: prediction.base.target, bull: prediction.bull.target } : null}
                    levels={levels}
                  />
                </div>

                <EscenariosCard prediction={prediction} />

                <ContextoLinea ticker={ticker} company={company} callPct={callPct} />

                {levels && (
                  <NivelesSimples levels={levels} iv={gex?.iv ?? 0.4} horizonDays={horizonDays} />
                )}

                <MemoriaCard ticker={ticker} />

                <div className="disclaimer">
                  Las predicciones son estimaciones de IA, no consejo financiero.
                </div>
              </>
            )}

            {view === "pro" && (
              <>
            <div className="grid-2">
              <SentimentCard ticker={ticker} parts={sentimentParts} />
              <PredictionCard ticker={ticker} prediction={prediction} horizonDays={horizonDays} onHorizon={setHorizonDays} topFlows={topFlows} />
            </div>

            {convRows && convRows.length > 0 && unusuality && (
              <div className="grid-2">
                <ActivityCard rows={convRows} unusualCount={unusuality.unusualCount} />
                <MoneyFlowCard ticker={ticker} rows={convRows} conviction={conviction} structure={structure} />
              </div>
            )}

            {levels && (
              <div className="grid-2">
                <LevelsCard r={levels} ticker={ticker} />
                <NewsCard ticker={ticker} company={company} callPct={callPct} />
              </div>
            )}
            {!levels && <NewsCard ticker={ticker} company={company} callPct={callPct} />}
            <SectorCard ticker={ticker} />

            {structure && <ProWallsCard ticker={ticker} structure={structure} gex={gex} horizonDays={horizonDays} levels={levels} />}

            {heatmap && heatmap.cells.length > 0 && <GexHeatmapCard h={heatmap} />}

            {unusualRows && <TradesFeed rows={unusualRows} />}

            <div className="disclaimer">
              Las predicciones son estimaciones de IA, no consejo financiero.
            </div>

            <details className="detalle">
              <summary>
                Detalle de sub-agentes — las tablas y promedios que alimentan Prediction Pro
              </summary>
              <div className="detalle-inner">
                {company && <CompanyHeader company={company} />}
                <ScorecardPanel aggression={aggScore} conviction={conviction} unusuality={unusuality} structure={structure} ivContext={ivContext} validation={validation} />
                {aggScore && <AggressionScoreCard score={aggScore} />}
                {conviction && <ConvictionCard conviction={conviction} />}
                {convRows && convMeta && convRows.length > 0 && (
                  <ConvictionTransactions rows={convRows} meta={convMeta} />
                )}
                {unusuality && unusualRows && unusualRows.length > 0 && (
                  <UnusualityCard meta={unusuality} rows={unusualRows} />
                )}
                {structure && <StructureCard s={structure} history={chainHistory} />}
                {ivContext && ivContext.iv.current != null && <IvContextCard s={ivContext} />}
                {validation && validation.coverage.flows > 0 && <ValidationCard s={validation} />}
                {notable && flowMeta && notable.length > 0 && (
                  <FlowPriceChart ticker={flowMeta.ticker} trades={notable} />
                )}
                {chainRows && top5.length > 0 && bars !== null && (
                  <ChartPanel ticker={chainMeta!.ticker} bars={bars} contracts={top5} />
                )}
                {chainRows && chainMeta && (
                  <div>
                    <h2 className="clusters-title" style={{ cursor: "pointer" }} onClick={() => setShowChain((v) => !v)}>
                      {showChain ? "▾" : "▸"} Option Chain completo
                      <span className="muted"> — {int.format(chainMeta.contractCount)} contratos</span>
                    </h2>
                    {showChain && <OptionChainTable rows={chainRows} meta={chainMeta} />}
                  </div>
                )}
              </div>
            </details>
              </>
            )}
          </>
        )}
      </main>
    </>
  );
}
