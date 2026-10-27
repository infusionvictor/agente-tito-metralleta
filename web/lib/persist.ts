// Puente único entre los stores (outbox, alertas, trades, etc.) y su backend real.
//
// En Vercel (KV_REST_API_URL configurado por la integración de Upstash) persiste en
// Redis — es lo único que sobrevive entre invocaciones serverless. En local dev, sin
// esa variable, cae a `fs` sobre web/data/ como antes, para que `npm run dev` siga
// funcionando sin depender de una cuenta de Upstash. Cada store solo cambia su
// `fs.readFile`/`fs.writeFile` por `loadJson`/`saveJson` con la misma forma de datos.

import { promises as fs } from "fs";
import path from "path";
import { hasKv, kvGet, kvSet } from "./kv";

export async function loadJson<T>(fsPath: string, kvKey: string): Promise<T | null> {
  if (hasKv()) return kvGet<T>(kvKey);
  try {
    const raw = await fs.readFile(fsPath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function saveJson<T>(fsPath: string, kvKey: string, data: T): Promise<void> {
  if (hasKv()) {
    await kvSet(kvKey, data);
    return;
  }
  await fs.mkdir(path.dirname(fsPath), { recursive: true });
  await fs.writeFile(fsPath, JSON.stringify(data), "utf8");
}
