// Persistencia de Mis Trades — un solo archivo JSON con todos los trades (a diferencia
// de data/trades/{TICKER}.json, que es el backtest de flows de validation.ts; nombre
// de carpeta distinto a propósito para no pisarse). Solo servidor.

import path from "path";
import type { PaperTrade } from "./paperTrades";
import { loadJson, saveJson } from "./persist";

const DATA_FILE = path.join(process.cwd(), "data", "papertrades", "trades.json");
const KEY = "papertrades";

interface StoredFile {
  updatedAt: string;
  trades: PaperTrade[];
}

export async function loadAllTrades(): Promise<PaperTrade[]> {
  const parsed = await loadJson<StoredFile>(DATA_FILE, KEY);
  return parsed && Array.isArray(parsed.trades) ? parsed.trades : [];
}

async function saveAllTrades(trades: PaperTrade[]): Promise<void> {
  const payload: StoredFile = { updatedAt: new Date().toISOString(), trades };
  await saveJson(DATA_FILE, KEY, payload);
}

/** Inserta o reemplaza (por id) y persiste. Devuelve la lista completa ya guardada. */
export async function upsertTrade(trade: PaperTrade): Promise<PaperTrade[]> {
  const all = await loadAllTrades();
  const idx = all.findIndex((t) => t.id === trade.id);
  if (idx >= 0) all[idx] = trade;
  else all.unshift(trade);
  await saveAllTrades(all);
  return all;
}

/** Reemplaza varios trades a la vez (para el refresh masivo del piloto/monitor). */
export async function upsertMany(updated: PaperTrade[]): Promise<PaperTrade[]> {
  if (updated.length === 0) return loadAllTrades();
  const all = await loadAllTrades();
  const byId = new Map(updated.map((t) => [t.id, t]));
  const merged = all.map((t) => byId.get(t.id) ?? t);
  await saveAllTrades(merged);
  return merged;
}

/** Solo permite borrar trades que todavía no se activaron (pending). */
export async function deletePendingTrade(id: string): Promise<{ trades: PaperTrade[]; deleted: boolean }> {
  const all = await loadAllTrades();
  const target = all.find((t) => t.id === id);
  if (!target || target.status !== "pending") {
    return { trades: all, deleted: false };
  }
  const trades = all.filter((t) => t.id !== id);
  await saveAllTrades(trades);
  return { trades, deleted: true };
}
