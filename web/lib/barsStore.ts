// Cache en disco de barras diarias, por día de mercado.
//
// Las barras diarias solo cambian una vez al día, pero el escaneo de Wheel
// las pide para 40 tickers en cada pasada. Sin cache serían 40 llamadas
// repetidas por escaneo. Solo servidor.
//
// `fetchDailyBars` sigue sin cache para el resto de rutas: este store es
// nuevo y en v1 solo lo usa Wheel.

import path from "path";
import { marketDateStr } from "./occ";
import { fetchDailyBars } from "./massive";
import { loadJson, saveJson } from "./persist";
import type { DailyBar } from "./types";

const DATA_DIR = path.join(process.cwd(), "data", "bars");

interface BarsFile {
  ticker: string;
  /** Día de mercado (ET) en que se guardó. */
  date: string;
  bars: DailyBar[];
}

function fileFor(ticker: string): string {
  const safe = ticker.trim().toUpperCase().replace(/[^A-Z0-9._-]/g, "");
  return path.join(DATA_DIR, `${safe}.json`);
}

function keyFor(ticker: string): string {
  return `bars:${ticker.trim().toUpperCase()}`;
}

export async function loadBars(ticker: string): Promise<BarsFile | null> {
  return loadJson<BarsFile>(fileFor(ticker), keyFor(ticker));
}

export async function saveBars(ticker: string, bars: DailyBar[], now = new Date()): Promise<void> {
  const payload: BarsFile = { ticker: ticker.toUpperCase(), date: marketDateStr(now), bars };
  await saveJson(fileFor(ticker), keyFor(ticker), payload);
}

/** Barras diarias con cache de un día de mercado. Si falla la red, devuelve []. */
export async function cachedDailyBars(ticker: string, days = 365, now = new Date()): Promise<DailyBar[]> {
  const today = marketDateStr(now);
  const cached = await loadBars(ticker);
  if (cached && cached.date === today && cached.bars.length > 0) return cached.bars;

  const bars = await fetchDailyBars(ticker, days).catch(() => [] as DailyBar[]);
  if (bars.length > 0) await saveBars(ticker, bars, now);
  return bars;
}
