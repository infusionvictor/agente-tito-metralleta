// Cliente de Redis (Upstash, vía la integración "Storage" de Vercel) para los stores
// server-side. Solo servidor.
//
// Por qué esto existe: todo lo que antes escribía en web/data/*.json con `fs` funciona
// en local (`npm run dev`) pero NUNCA en Vercel — el filesystem del deploy es de solo
// lectura fuera de /tmp, y /tmp no persiste entre invocaciones. Confirmado en producción:
// ENOENT al hacer mkdir en /var/task/web/data. Con datos reales (trades del piloto,
// alertas, watchlist) eso significa perder información en silencio, no un detalle menor.
//
// KV_REST_API_URL / KV_REST_API_TOKEN los inyecta la integración de Upstash — no hay
// que ponerlos a mano. En local dev, si no están, cada store cae de vuelta a `fs`
// (ver lib/persist.ts) para no exigirle Redis a quien solo quiere correr `npm run dev`.

import { Redis } from "@upstash/redis";

let client: Redis | null = null;

export function hasKv(): boolean {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

function getClient(): Redis {
  if (!client) {
    client = new Redis({
      url: process.env.KV_REST_API_URL!,
      token: process.env.KV_REST_API_TOKEN!,
    });
  }
  return client;
}

export async function kvGet<T>(key: string): Promise<T | null> {
  const value = await getClient().get<T>(key);
  return value ?? null;
}

export async function kvSet<T>(key: string, value: T): Promise<void> {
  await getClient().set(key, value);
}
