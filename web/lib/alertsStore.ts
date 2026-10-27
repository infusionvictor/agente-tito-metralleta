// Persistencia de las alertas del piloto — un solo archivo JSON, más reciente primero.
// Solo servidor.

import path from "path";
import type { Alert } from "./alerts";
import { notifyDiscord } from "./discord";
import { loadJson, saveJson } from "./persist";

const DATA_FILE = path.join(process.cwd(), "data", "alerts", "alerts.json");
const KEY = "alerts";
/** Tope de alertas guardadas — es un feed, no un archivo histórico completo. */
const MAX_ALERTS = 300;

interface StoredFile {
  updatedAt: string;
  alerts: Alert[];
}

export async function loadAlerts(): Promise<Alert[]> {
  const parsed = await loadJson<StoredFile>(DATA_FILE, KEY);
  return parsed && Array.isArray(parsed.alerts) ? parsed.alerts : [];
}

export async function appendAlert(alert: Alert): Promise<Alert[]> {
  const existing = await loadAlerts();
  const alerts = [alert, ...existing].slice(0, MAX_ALERTS);
  const payload: StoredFile = { updatedAt: new Date().toISOString(), alerts };
  await saveJson(DATA_FILE, KEY, payload);
  await notifyDiscord(alert);
  return alerts;
}
