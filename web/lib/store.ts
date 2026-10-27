// Almacén local de transacciones ya categorizadas, para que el agente vaya ajustando
// con el tiempo (nota del Scorecard: "crea un lugar donde almacenar esta información").
// Un archivo JSON por ticker en web/data/trades/. Solo servidor.

import path from "path";
import type { FlowRow } from "./flow";
import { loadJson, saveJson } from "./persist";

const DATA_DIR = path.join(process.cwd(), "data", "trades");

/** Tope por ticker para que el archivo no crezca sin control. */
const MAX_PER_TICKER = 5000;

export interface StoredTrades {
  ticker: string;
  updatedAt: string;
  trades: FlowRow[];
}

export interface SaveResult {
  total: number; // cuántas quedan guardadas
  added: number; // cuántas eran nuevas en esta corrida
  firstSeen: string | null; // fecha del trade más antiguo guardado
}

function fileFor(ticker: string): string {
  const safe = ticker.trim().toUpperCase().replace(/[^A-Z0-9._-]/g, "");
  return path.join(DATA_DIR, `${safe}.json`);
}

function keyFor(ticker: string): string {
  return `trades:${ticker.trim().toUpperCase()}`;
}

export async function loadTrades(ticker: string): Promise<StoredTrades | null> {
  const parsed = await loadJson<StoredTrades>(fileFor(ticker), keyFor(ticker));
  return parsed && Array.isArray(parsed.trades) ? parsed : null;
}

/**
 * Fusiona los trades nuevos con los ya guardados (dedupe por id) y persiste.
 * Los trades vienen ya clasificados/puntuados, así que se guarda el análisis completo.
 */
export async function saveTrades(ticker: string, rows: FlowRow[]): Promise<SaveResult> {
  const clean = ticker.trim().toUpperCase();
  const existing = await loadTrades(clean);
  const byId = new Map<number, FlowRow>();

  for (const t of existing?.trades ?? []) byId.set(t.id, t);
  let added = 0;
  for (const t of rows) {
    if (!byId.has(t.id)) added++;
    byId.set(t.id, t); // el análisis más reciente gana (expiryStatus se recalcula cada corrida)
  }

  const merged = [...byId.values()]
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, MAX_PER_TICKER);

  const payload: StoredTrades = {
    ticker: clean,
    updatedAt: new Date().toISOString(),
    trades: merged,
  };

  await saveJson(fileFor(clean), keyFor(clean), payload);

  const oldest = merged[merged.length - 1]?.timestamp ?? null;
  return { total: merged.length, added, firstSeen: oldest };
}
