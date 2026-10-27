// POST /api/watch/scan — la "lupa": vigilancia en tiempo real de los tickers
// que el usuario marcó (ver /api/watch), complementaria al escaneo de TODO el
// mercado que ya hacen /api/ideas y /api/digest/morning.
//
// Por cada ticker vigilado: cadena acotada (fetchNearChain) → niveles reales
// (lib/levels.ts, mismo cálculo que usa el piloto automático para su vía
// intradía). Si el precio CRUZÓ un nivel real desde la última vez que se
// revisó (no solo "está cerca"), avisa por Discord — informativo, no crea
// trades. Cada nivel se avisa como máximo una vez cada 4h (lib/watchStore.ts)
// para no repetir la misma alerta si el precio oscila alrededor del nivel.
//
// Corre cada 15 min en horario de mercado (ver .github/workflows/watch-scan.yml).

import { isAuthorized } from "@/lib/cronAuth";
import { sendLevelCrossAlert } from "@/lib/discord";
import { gexAnalysis } from "@/lib/gex";
import type { ChainLevel, GexLevel, LvlBar } from "@/lib/levels";
import { findLevels } from "@/lib/levels";
import { fetchNearChain, MassiveError, fetchDailyBars } from "@/lib/massive";
import { notionalValue, toRow } from "@/lib/compute";
import { loadWatchedTickers, loadWatchState, recentlyAlerted, saveWatchState } from "@/lib/watchStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIN_STRENGTH = 35; // mismo piso que las líneas punteadas de ProWallsCard

export async function POST(request: Request) {
  if (!isAuthorized(request.headers.get("x-cron-secret"), process.env.CRON_SECRET)) {
    return Response.json({ error: "No autorizado." }, { status: 401 });
  }

  const now = new Date();
  const tickers = await loadWatchedTickers();
  const result: { ticker: string; status: string }[] = [];

  for (const ticker of tickers) {
    try {
      const chain = await fetchNearChain(ticker, { dteMax: 60, now });
      if (chain.spot == null || chain.contracts.length === 0) {
        result.push({ ticker, status: "sin cadena" });
        continue;
      }

      const bars = await fetchDailyBars(ticker, 120).catch(() => []);
      if (bars.length < 20) {
        result.push({ ticker, status: "sin barras" });
        continue;
      }

      const rows = chain.contracts.map(toRow).filter((r) => r.strike > 0 && r.expiration);
      const closes = bars.map((b) => b.close);
      const gex = gexAnalysis({ rows, closes, spot: chain.spot, now });

      const chainLevels: ChainLevel[] = rows.map((r) => ({
        strike: r.strike, contractType: r.contractType,
        openInterest: r.openInterest, notionalValue: notionalValue(r.openInterest, r.strike),
      }));
      const gexLevels: GexLevel[] = gex.nodes.map((n) => ({ strike: n.strike, netGex: n.netGex }));
      const lvlBars: LvlBar[] = bars.map((b) => ({ time: b.time, high: b.high, low: b.low, close: b.close }));
      const levels = findLevels({ bars: lvlBars, spot: chain.spot, chain: chainLevels, gex: gexLevels, now });

      const state = await loadWatchState(ticker);
      const prevSpot = state?.lastSpot ?? null;
      const spot = chain.spot;
      const alertedLevels = { ...(state?.alertedLevels ?? {}) };
      let alerted = 0;

      if (prevSpot != null) {
        const r = levels.keyResistance;
        if (r && r.strength >= MIN_STRENGTH && prevSpot < r.price && spot >= r.price && !recentlyAlerted(state, r.price, now)) {
          await sendLevelCrossAlert({ ticker, kind: "resistencia", levelPrice: r.price, strength: r.strength, spot, now });
          alertedLevels[r.price.toFixed(2)] = now.toISOString();
          alerted++;
        }
        const s = levels.keySupport;
        if (s && s.strength >= MIN_STRENGTH && prevSpot > s.price && spot <= s.price && !recentlyAlerted(state, s.price, now)) {
          await sendLevelCrossAlert({ ticker, kind: "soporte", levelPrice: s.price, strength: s.strength, spot, now });
          alertedLevels[s.price.toFixed(2)] = now.toISOString();
          alerted++;
        }
      }

      await saveWatchState(ticker, { lastSpot: spot, alertedLevels });

      result.push({ ticker, status: alerted > 0 ? `${alerted} alerta(s)` : "sin cruce" });
    } catch (err) {
      const msg = err instanceof MassiveError ? err.message : "Error inesperado.";
      result.push({ ticker, status: `error: ${msg}` });
    }
  }

  return Response.json({ scanned: tickers.length, result });
}
