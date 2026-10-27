// Persistencia del buzón de salida hacia el broker. web/data/outbox.json (gitignored).
// Solo servidor. La lógica pura vive en `watchlist.ts`.
//
// Ojo con lo que NO guarda: los griegos, tu sizing y tu saldo se quedan en el navegador
// del estudiante. Aquí solo cae la identidad del contrato (ticker y, si el broker los
// acepta, tipo/strike/vencimiento), que es lo mínimo para resolverlo en el broker.

import path from "path";
import { loadJson, saveJson } from "./persist";
import type { OutboxItem } from "./watchlist";

const FILE = path.join(process.cwd(), "data", "outbox.json");
const KEY = "outbox";

export interface StoredOutbox {
  updatedAt: string;
  items: OutboxItem[];
}

const EMPTY: StoredOutbox = { updatedAt: "", items: [] };

export async function loadOutbox(): Promise<StoredOutbox> {
  const parsed = await loadJson<StoredOutbox>(FILE, KEY);
  return parsed && Array.isArray(parsed.items) ? { ...EMPTY, ...parsed } : EMPTY;
}

export async function saveOutbox(items: OutboxItem[]): Promise<StoredOutbox> {
  const payload: StoredOutbox = { updatedAt: new Date().toISOString(), items };
  await saveJson(FILE, KEY, payload);
  return payload;
}
