// POST /api/autopilot/scan — el piloto automático. SIMULACIÓN: solo crea paper
// trades marcados AUTO y alertas; nunca coloca una orden real.
//
// Dos vías sobre el universo de la Wheel (40 tickers líquidos, ver wheelUniverse.ts):
//   - swing: UN solo fetch de flujo de todo el mercado (fetchMarketFlow), filtrado al
//     universo, exige acierto histórico verificado (validationScore) para autopilotear.
//   - intradía: por ticker, cadena acotada (fetchNearChain) → GEX (gex.ts) + niveles
//     reales (levels.ts) como gatillo de ruptura.
//
// Reglas: una dirección por ticker (si ya hay un AUTO pendiente/activo en ese ticker,
// se salta — en cualquiera de las dos vías); si MarketSnack falla (cookie caducado),
// el piloto sigue solo con la vía intradía y lo reporta en `degraded.marketsnack`.
//
// Lo llama el botón "Escanear ahora" de la UI y, para correr desatendido, el script
// scripts/autopilot-scan.mjs vía Task Scheduler (ver README de esa carpeta).

import { createAlert } from "@/lib/alerts";
import { isAuthorized } from "@/lib/cronAuth";
import { appendAlert } from "@/lib/alertsStore";
import { kvGet, kvSet } from "@/lib/kv";
import {
  buildAutoTradeInput,
  evaluateIntraday,
  evaluateSwing,
  type AutoCandidate,
  type ContractCandidate,
} from "@/lib/autopilot";
import { cachedDailyBars } from "@/lib/barsStore";
import { notionalValue, toRow } from "@/lib/compute";
import { classifyFlow, type FlowRow } from "@/lib/flow";
import { gexAnalysis } from "@/lib/gex";
import type { ChainLevel, GexLevel, LvlBar } from "@/lib/levels";
import { findLevels } from "@/lib/levels";
import { fetchMarketFlow, MarketSnackError } from "@/lib/marketsnack";
import { fetchNearChain, MassiveError } from "@/lib/massive";
import { daysToExpiration } from "@/lib/occ";
import { createTrade, type PaperTrade } from "@/lib/paperTrades";
import { loadAllTrades, upsertTrade } from "@/lib/paperTradesStore";
import { isTradeableIdea, withinMoneyness } from "@/lib/risk";
import { loadTrades } from "@/lib/store";
import { validationScore, type FlowLite } from "@/lib/validation";
import { WHEEL_UNIVERSE } from "@/lib/wheelUniverse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Mismos umbrales que /api/ideas (flujo grande, ya institucional).
const MIN_PREMIUM = 100_000;
const MAX_PAGES = 8;
// Cuántos tickers de la vía intradía se consultan a la vez, para no saturar Massive.
const INTRADAY_BATCH = 5;

function toFlowLite(t: FlowRow): FlowLite {
  return {
    id: t.id, timestamp: t.timestamp, type: t.type, strike: t.strike,
    expiration: t.expiration, assetPrice: t.assetPrice, premium: t.premium,
    aggression: t.aggression,
  };
}

interface ScanResult {
  scanned: number;
  createdTrades: number;
  alerts: number;
  skippedBlocked: string[]; // ya tenían un AUTO vivo
  errors: string[];
  degraded: { marketsnack: boolean; reason: string | null };
  candidates: { ticker: string; path: string; probability: number }[];
}

async function batched<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    const chunk = items.slice(i, i + size);
    out.push(...(await Promise.all(chunk.map(fn))));
  }
  return out;
}

// El botón "Escanear ahora" de la UI no puede llevar CRON_SECRET (es del navegador,
// cualquiera vería el valor). En vez de exponer el secreto o dejar el endpoint
// abierto sin más, una llamada sin el header pasa por un límite de frecuencia
// propio: Mis Trades es compartido por todos los que usan la app, así que un botón
// sin freno podría llenarlo de ruido si alguien lo golpea en bucle.
const MANUAL_SCAN_COOLDOWN_MS = 5 * 60 * 1000;
const MANUAL_SCAN_KEY = "autopilot:last-manual-scan";

export async function POST(request: Request) {
  const isCron = isAuthorized(request.headers.get("x-cron-secret"), process.env.CRON_SECRET);
  if (!isCron) {
    const last = await kvGet<string>(MANUAL_SCAN_KEY).catch(() => null);
    if (last && Date.now() - Date.parse(last) < MANUAL_SCAN_COOLDOWN_MS) {
      const waitSec = Math.ceil((MANUAL_SCAN_COOLDOWN_MS - (Date.now() - Date.parse(last))) / 1000);
      return Response.json(
        { error: `Espera ${waitSec}s antes de volver a escanear manualmente.` },
        { status: 429 },
      );
    }
    await kvSet(MANUAL_SCAN_KEY, new Date().toISOString()).catch(() => null);
  }

  const now = new Date();
  const universe = WHEEL_UNIVERSE.map((w) => w.ticker);
  const result: ScanResult = {
    scanned: universe.length,
    createdTrades: 0,
    alerts: 0,
    skippedBlocked: [],
    errors: [],
    degraded: { marketsnack: false, reason: null },
    candidates: [],
  };

  const existingTrades = await loadAllTrades();
  const blocked = new Set(
    existingTrades
      .filter((t) => t.source === "auto" && (t.status === "pending" || t.status === "active"))
      .map((t) => t.ticker),
  );

  // ---------------------------------------------------------------------
  // Vía swing — un solo fetch de flujo de mercado, acotado al universo.
  // ---------------------------------------------------------------------
  const swingCandidates: AutoCandidate[] = [];
  try {
    const { trades } = await fetchMarketFlow({ period: "1d", minPremium: MIN_PREMIUM, maxPages: MAX_PAGES });
    const { rows } = classifyFlow(trades, now);
    const universeSet = new Set(universe);

    const byTicker = new Map<string, FlowRow>();
    for (const r of rows) {
      if (!universeSet.has(r.underlying)) continue;
      if (blocked.has(r.underlying)) continue;
      if (r.strike == null || !r.expiration) continue; // sin contrato concreto no hay plan que armar
      if (!isTradeableIdea(r) || !withinMoneyness(r)) continue;
      const prev = byTicker.get(r.underlying);
      if (!prev || r.premium > prev.premium) byTicker.set(r.underlying, r);
    }

    for (const [ticker, r] of byTicker) {
      const stored = await loadTrades(ticker);
      const flows = (stored?.trades ?? []).filter((t) => t.assetPrice > 0 && t.timestamp).map(toFlowLite);
      if (flows.length === 0) continue; // sin historial: el piloto no puede sostener "acierto histórico"

      const bars = await cachedDailyBars(ticker, 200, now);
      if (bars.length === 0) continue;

      const report = validationScore({ flows, bars, now });
      const cand = evaluateSwing({
        ticker,
        type: r.type === "unknown" ? "call" : r.type,
        // ya filtrados no-null al armar byTicker (sin contrato concreto no entra al mapa)
        strike: r.strike!,
        expiration: r.expiration!,
        dte: daysToExpiration(r.expiration!, now),
        iv: r.iv,
        assetPrice: r.assetPrice,
        price: r.price,
        hitRate: report.hitRate.value,
        resolved: report.hitRate.resolved,
        avgMfePct: report.avgMfe,
        avgMaePct: report.avgMae,
      });
      if (cand) swingCandidates.push(cand);
    }
  } catch (err) {
    result.degraded.marketsnack = true;
    result.degraded.reason =
      err instanceof MarketSnackError ? err.message : "Error inesperado consultando el flujo de mercado.";
  }

  // ---------------------------------------------------------------------
  // Vía intradía — cadena acotada por ticker → GEX + niveles.
  // ---------------------------------------------------------------------
  const swingTickers = new Set(swingCandidates.map((c) => c.ticker));
  const intradayTargets = universe.filter((t) => !blocked.has(t) && !swingTickers.has(t));

  const intradayResults = await batched(intradayTargets, INTRADAY_BATCH, async (ticker) => {
    try {
      const chain = await fetchNearChain(ticker, { dteMax: 60, now });
      if (chain.spot == null || chain.contracts.length === 0) return null;

      const bars = await cachedDailyBars(ticker, 120, now);
      if (bars.length < 20) return null;

      const rows = chain.contracts.map(toRow).filter((r) => r.strike > 0 && r.expiration);
      const closes = bars.map((b) => b.close);
      const gex = gexAnalysis({ rows, closes, spot: chain.spot, now });
      if (gex.lowLiquidity || gex.nodes.length === 0) return null;

      const chainLevels: ChainLevel[] = rows.map((r) => ({
        strike: r.strike, contractType: r.contractType,
        openInterest: r.openInterest, notionalValue: notionalValue(r.openInterest, r.strike),
      }));
      const gexLevels: GexLevel[] = gex.nodes.map((n) => ({ strike: n.strike, netGex: n.netGex }));
      const lvlBars: LvlBar[] = bars.map((b) => ({ time: b.time, high: b.high, low: b.low, close: b.close }));
      const levels = findLevels({ bars: lvlBars, spot: chain.spot, chain: chainLevels, gex: gexLevels, now });

      const contracts: ContractCandidate[] = chain.contracts
        .map((c) => ({
          strike: c.details?.strike_price ?? 0,
          expiration: c.details?.expiration_date ?? "",
          dte: c.details?.expiration_date ? daysToExpiration(c.details.expiration_date, now) : -1,
          bid: c.last_quote?.bid ?? null,
          ask: c.last_quote?.ask ?? null,
          lastTrade: c.last_trade?.price ?? null,
        }))
        .filter((c) => c.strike > 0 && c.expiration);

      return evaluateIntraday({
        ticker,
        spot: chain.spot,
        iv: gex.iv,
        gexDirection: gex.direction,
        gexConfidence: gex.confidence,
        kingStrike: gex.kingStrike,
        lowLiquidity: gex.lowLiquidity,
        keySupport: levels.keySupport ? { price: levels.keySupport.price, strength: levels.keySupport.strength } : null,
        keyResistance: levels.keyResistance
          ? { price: levels.keyResistance.price, strength: levels.keyResistance.strength }
          : null,
        contracts,
      });
    } catch (err) {
      const msg = err instanceof MassiveError ? err.message : "Error inesperado.";
      result.errors.push(`${ticker}: ${msg}`);
      return null;
    }
  });

  const intradayCandidates = intradayResults.filter((c): c is AutoCandidate => c != null);

  // ---------------------------------------------------------------------
  // Materializar: candidato → paper trade AUTO + alerta.
  // ---------------------------------------------------------------------
  const allCandidates = [...swingCandidates, ...intradayCandidates];
  const created: PaperTrade[] = [];
  for (const c of allCandidates) {
    const trade = createTrade(buildAutoTradeInput(c), now);
    await upsertTrade(trade);
    created.push(trade);
    const alert = createAlert(
      {
        ticker: c.ticker,
        path: c.path,
        direction: c.direction,
        contractType: c.contractType,
        strike: c.strike,
        expiration: c.expiration,
        entryTrigger: c.entryTrigger,
        target: c.target,
        stop: c.stop,
        probability: Math.round(c.probability),
        reasoning: c.reasoning,
        tradeId: trade.id,
      },
      now,
    );
    await appendAlert(alert);
    result.createdTrades++;
    result.alerts++;
    result.candidates.push({ ticker: c.ticker, path: c.path, probability: Math.round(c.probability) });
  }

  result.skippedBlocked = [...blocked];
  return Response.json(result);
}
