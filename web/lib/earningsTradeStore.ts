// Almacén de los trades de earnings del usuario: un archivo por ticker en
// web/data/earnings-trades/. Sirve de REFERENCIA para el próximo earnings del mismo nombre
// ("la última vez que vendí prima en BE, así me fue"). Solo servidor.
// Ver docs/superpowers/specs/2026-07-27-earnings-iv-crush-design.md

import { promises as fs } from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), "data", "earnings-trades");
const MAX_PER_TICKER = 200;

export interface EarningsTrade {
  id: string;
  ticker: string;
  savedAt: string; // ISO
  earningsDate: string | null;
  kind: "bull_put" | "bear_call";
  shortStrike: number;
  longStrike: number;
  width: number;
  credit: number; // por acción
  expiration: string | null;
  // foto del momento (para comparar en el próximo earnings)
  spotAtEntry: number | null;
  ivAtEntry: number | null; // % ATM
  richnessAtEntry: number | null;
  flowAtEntry: { callPct: number; putPct: number } | null;
  note?: string;
}

function fileFor(ticker: string): string {
  const safe = ticker.trim().toUpperCase().replace(/[^A-Z0-9._-]/g, "");
  return path.join(DATA_DIR, `${safe}.json`);
}

export async function loadEarningsTrades(ticker: string): Promise<EarningsTrade[]> {
  try {
    const raw = await fs.readFile(fileFor(ticker), "utf8");
    const parsed = JSON.parse(raw) as { trades?: EarningsTrade[] };
    return Array.isArray(parsed.trades) ? parsed.trades : [];
  } catch {
    return [];
  }
}

/** Agrega un trade al historial del ticker (más reciente primero) y persiste. */
export async function saveEarningsTrade(trade: EarningsTrade): Promise<EarningsTrade[]> {
  const existing = await loadEarningsTrades(trade.ticker);
  const trades = [trade, ...existing].slice(0, MAX_PER_TICKER);
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(
    fileFor(trade.ticker),
    JSON.stringify({ ticker: trade.ticker, updatedAt: new Date().toISOString(), trades }, null, 2),
  );
  return trades;
}
