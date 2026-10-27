// Lista de tickers "vigilados" para alertas proactivas de cruce de nivel
// (soporte/resistencia real, ver lib/levels.ts) — la "lupa" que vigila en
// tiempo real lo que a ti te importa, complementaria al escaneo de TODO el
// mercado que ya hacen /api/ideas y el resumen matutino (ver
// .github/workflows/watch-scan.yml). Solo servidor.
//
// Tope de tickers a propósito: cada pase de vigilancia gasta una llamada de
// cadena + barras por ticker contra Massive. Sin tope, una lista larga
// agotaría la cuota rápido.

import path from "path";
import { loadJson, saveJson } from "./persist";

export const MAX_WATCHED = 15;

const LIST_FILE = path.join(process.cwd(), "data", "watch", "tickers.json");
const LIST_KEY = "watch:tickers";

interface StoredList {
  tickers: string[];
}

export async function loadWatchedTickers(): Promise<string[]> {
  const parsed = await loadJson<StoredList>(LIST_FILE, LIST_KEY);
  return Array.isArray(parsed?.tickers) ? parsed.tickers : [];
}

export async function addWatchedTicker(ticker: string): Promise<{ tickers: string[]; error: string | null }> {
  const clean = ticker.trim().toUpperCase();
  const current = await loadWatchedTickers();
  if (current.includes(clean)) return { tickers: current, error: null };
  if (current.length >= MAX_WATCHED) {
    return { tickers: current, error: `Máximo ${MAX_WATCHED} tickers vigilados. Quita alguno primero.` };
  }
  const tickers = [...current, clean];
  await saveJson(LIST_FILE, LIST_KEY, { tickers });
  return { tickers, error: null };
}

export async function removeWatchedTicker(ticker: string): Promise<string[]> {
  const clean = ticker.trim().toUpperCase();
  const tickers = (await loadWatchedTickers()).filter((t) => t !== clean);
  await saveJson(LIST_FILE, LIST_KEY, { tickers });
  return tickers;
}

// ---------------------------------------------------------------------------
// Estado por ticker: último spot visto y última vez que se avisó de CADA nivel
// (para no repetir la misma alerta si el precio oscila alrededor del nivel).
// ---------------------------------------------------------------------------

interface WatchState {
  lastSpot: number;
  /** precio del nivel (redondeado) → cuándo se avisó por última vez, ISO. */
  alertedLevels: Record<string, string>;
}

const ALERT_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4h: no repetir la misma alerta el mismo día

function stateFile(ticker: string): string {
  const safe = ticker.trim().toUpperCase().replace(/[^A-Z0-9._-]/g, "");
  return path.join(process.cwd(), "data", "watch", "state", `${safe}.json`);
}

function stateKey(ticker: string): string {
  return `watch:state:${ticker.trim().toUpperCase()}`;
}

export async function loadWatchState(ticker: string): Promise<WatchState | null> {
  return loadJson<WatchState>(stateFile(ticker), stateKey(ticker));
}

export async function saveWatchState(ticker: string, state: WatchState): Promise<void> {
  await saveJson(stateFile(ticker), stateKey(ticker), state);
}

/** ¿Ya se avisó este nivel hace menos de ALERT_COOLDOWN_MS? */
export function recentlyAlerted(state: WatchState | null, levelPrice: number, now: Date): boolean {
  if (!state) return false;
  const key = levelPrice.toFixed(2);
  const at = state.alertedLevels[key];
  if (!at) return false;
  return now.getTime() - Date.parse(at) < ALERT_COOLDOWN_MS;
}
