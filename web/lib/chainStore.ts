// Historial diario de la cadena de opciones (sub-agente 4 — Acumulación y Rapidez).
// El documento pide "45 días hacia atrás", pero la cadena de Massive es una FOTO del
// momento: no hay serie histórica de open interest. Por eso guardamos una foto por
// día de mercado y el historial se va acumulando hacia adelante. Solo servidor.

import path from "path";
import { marketDateStr } from "./occ";
import { loadJson, saveJson } from "./persist";
import type { StructureScore } from "./structure";

const DATA_DIR = path.join(process.cwd(), "data", "chain");

/** Ventana que pide el documento. */
export const HISTORY_DAYS = 45;

export interface ChainSnapshot {
  date: string; // fecha de mercado (ET), YYYY-MM-DD
  savedAt: string;
  score: number;
  avgNotionalPerStrike: number;
  totalNotional: number;
  strikeCount: number;
  notionalPoints: number;
  dominantCount: number;
  strikePoints: number;
  volOIPct: number;
  volOIPoints: number;
  callPct: number;
  putPct: number;
  dominantSide: "calls" | "puts";
  lowLiquidity: boolean;
  topStrikes: { strike: number; notional: number; side: "calls" | "puts" }[];
}

export interface ChainHistory {
  ticker: string;
  updatedAt: string;
  snapshots: ChainSnapshot[]; // más reciente primero
}

function fileFor(ticker: string): string {
  const safe = ticker.trim().toUpperCase().replace(/[^A-Z0-9._-]/g, "");
  return path.join(DATA_DIR, `${safe}.json`);
}

function keyFor(ticker: string): string {
  return `chain:${ticker.trim().toUpperCase()}`;
}

export async function loadChainHistory(ticker: string): Promise<ChainHistory | null> {
  const parsed = await loadJson<ChainHistory>(fileFor(ticker), keyFor(ticker));
  return parsed && Array.isArray(parsed.snapshots) ? parsed : null;
}

/**
 * Guarda la foto del día (una por fecha de mercado; si ya existe se reemplaza con
 * la más reciente) y devuelve el historial recortado a HISTORY_DAYS.
 */
export async function saveChainSnapshot(
  ticker: string,
  s: StructureScore,
  now: Date = new Date(),
): Promise<ChainHistory> {
  const clean = ticker.trim().toUpperCase();
  const date = marketDateStr(now);

  const snapshot: ChainSnapshot = {
    date,
    savedAt: now.toISOString(),
    score: s.score,
    avgNotionalPerStrike: s.notional.avgPerStrike,
    totalNotional: s.notional.total,
    strikeCount: s.notional.strikeCount,
    notionalPoints: s.notional.points,
    dominantCount: s.strikes.dominantCount,
    strikePoints: s.strikes.points,
    volOIPct: s.volOI.pct,
    volOIPoints: s.volOI.points,
    callPct: s.strikes.callPct,
    putPct: s.strikes.putPct,
    dominantSide: s.strikes.dominantSide,
    lowLiquidity: s.notional.lowLiquidity,
    topStrikes: s.strikes.top.slice(0, 5).map((t) => ({
      strike: t.strike, notional: t.notional, side: t.side,
    })),
  };

  const existing = await loadChainHistory(clean);
  const byDate = new Map<string, ChainSnapshot>();
  for (const snap of existing?.snapshots ?? []) byDate.set(snap.date, snap);
  byDate.set(date, snapshot); // la foto de hoy se actualiza en cada corrida

  const snapshots = [...byDate.values()]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, HISTORY_DAYS);

  const payload: ChainHistory = { ticker: clean, updatedAt: now.toISOString(), snapshots };
  await saveJson(fileFor(clean), keyFor(clean), payload);
  return payload;
}
