// Notifica las alertas del piloto automático a un canal de Discord vía webhook.
// Opcional: si DISCORD_WEBHOOK_URL no está configurado, no hace nada — nunca
// bloquea ni rompe el flujo de escaneo. Solo servidor.

import type { Alert } from "./alerts";

/** Subconjunto de `Idea` (app/ideas/types.ts) que necesita el resumen matutino. */
export interface DigestIdea {
  ticker: string;
  type: "call" | "put";
  strike: number | null;
  expiration: string | null;
  assetPrice: number;
  premium: number;
  unusualScore: number;
  history: { hitRate: number | null; resolved: number } | null;
}

const PATH_LABEL: Record<Alert["path"], string> = {
  intraday: "Intradía · GEX + niveles",
  swing: "Swing · flujo institucional",
};

const DIRECTION_LABEL: Record<Alert["direction"], string> = {
  up: "🟢 Alcista",
  down: "🔴 Bajista",
};

const DIRECTION_COLOR: Record<Alert["direction"], number> = {
  up: 0x22c55e,
  down: 0xef4444,
};

function contractLabel(alert: Alert): string {
  const side = alert.contractType === "call" ? "C" : "P";
  return `$${alert.strike.toFixed(2)}${side} ${alert.expiration}`;
}

/**
 * Todos los campos salen tal cual del trade que ya se creó — nada se redondea
 * distinto ni se recalcula acá. Gatillo = nivel real del subyacente; objetivo/
 * stop = precio de opción proyectado con Black-Scholes sobre niveles reales
 * (ver autopilot.ts) — nunca un múltiplo inventado de la prima.
 */
export function buildDiscordPayload(alert: Alert): Record<string, unknown> {
  return {
    embeds: [
      {
        title: `${alert.ticker} ${contractLabel(alert)} — ${DIRECTION_LABEL[alert.direction]}`,
        description: alert.reasoning,
        color: DIRECTION_COLOR[alert.direction],
        fields: [
          { name: "Vía", value: PATH_LABEL[alert.path], inline: true },
          { name: "Probabilidad", value: `${alert.probability}%`, inline: true },
          { name: "Gatillo (subyacente)", value: `$${alert.entryTrigger.toFixed(2)}`, inline: true },
          { name: "Compra (objetivo, prima)", value: `$${alert.target.toFixed(2)}`, inline: true },
          { name: "Stop loss (prima)", value: `$${alert.stop.toFixed(2)}`, inline: true },
        ],
        footer: {
          text: "Tito Metralleta · Piloto automático — SIMULACIÓN, no coloca órdenes reales. " +
            "Niveles calculados con datos reales (GEX/niveles o excursión histórica), no es recomendación.",
        },
        timestamp: alert.createdAt,
      },
    ],
  };
}

/** POST genérico al webhook de Discord. Nunca lanza — un fallo de red o webhook mal puesto no debe tumbar el escaneo. */
async function postToDiscord(
  payload: Record<string, unknown>,
  errorLabel: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return;

  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(`[discord] webhook respondió ${res.status} para ${errorLabel}`);
    }
  } catch (err) {
    console.error(`[discord] no se pudo enviar ${errorLabel}:`, err instanceof Error ? err.message : err);
  }
}

/** Envía la alerta al webhook de Discord. Nunca lanza — un fallo de red o webhook mal puesto no debe tumbar el escaneo. */
export async function notifyDiscord(alert: Alert, fetchImpl: typeof fetch = fetch): Promise<void> {
  await postToDiscord(buildDiscordPayload(alert), `la alerta de ${alert.ticker}`, fetchImpl);
}

function ideaLine(idea: DigestIdea): string {
  const side = idea.type === "call" ? "C" : "P";
  const contract = idea.strike != null && idea.expiration ? `$${idea.strike.toFixed(2)}${side} ${idea.expiration}` : side;
  const premiumM = (idea.premium / 1_000_000).toFixed(2);
  const parts = [`**${idea.ticker}** ${contract} — premium $${premiumM}M, score ${idea.unusualScore}/100`];
  if (idea.history && idea.history.hitRate != null) {
    parts.push(`acierto histórico ${idea.history.hitRate.toFixed(0)}% (${idea.history.resolved} casos)`);
  } else {
    parts.push("sin historial verificado");
  }
  return parts.join(" — ");
}

/**
 * Resumen matutino: top ideas REALES del escaneo de todo el mercado (mismo
 * filtro de calidad que /ideas — lib/risk.ts), nunca inventadas. Si `ideas`
 * viene vacío por un error de escaneo, `scanError` explica por qué en vez de
 * fingir "no hay oportunidades hoy".
 */
export function buildMorningDigestPayload(
  ideas: DigestIdea[],
  meta: { scanned: number; tickers: number },
  scanError: string | null,
  now: Date,
): Record<string, unknown> {
  const description = scanError
    ? `⚠ No se pudo completar el escaneo: ${scanError}`
    : ideas.length === 0
      ? `Sin ideas que pasen el filtro de calidad hoy (se revisaron ${meta.scanned} operaciones en ${meta.tickers} tickers).`
      : ideas.map(ideaLine).join("\n");

  return {
    embeds: [
      {
        title: "📋 Resumen matutino — oportunidades del mercado",
        description,
        color: scanError ? 0xef4444 : 0x3b82f6,
        footer: {
          text:
            `Tito Metralleta · Escaneo real de flujo de opciones (${meta.scanned} operaciones, ` +
            `${meta.tickers} tickers) — no es consejo financiero, no coloca órdenes.`,
        },
        timestamp: now.toISOString(),
      },
    ],
  };
}

/**
 * Alerta de "lupa" — cruce real de un nivel (soporte/resistencia, ver
 * lib/levels.ts) en un ticker que el usuario marcó para vigilar. Informativa:
 * no crea trades ni implica que el piloto automático vaya a actuar.
 */
export function buildLevelCrossPayload(params: {
  ticker: string;
  kind: "resistencia" | "soporte";
  levelPrice: number;
  strength: number;
  spot: number;
  now: Date;
}): Record<string, unknown> {
  const { ticker, kind, levelPrice, strength, spot, now } = params;
  const up = kind === "resistencia";
  return {
    embeds: [
      {
        title: `👁 ${ticker} — ${up ? "rompió resistencia" : "rompió soporte"} en $${levelPrice.toFixed(2)}`,
        description:
          `El precio cruzó un ${kind} real (fuerza ${strength}/100) que veníamos vigilando. ` +
          `Precio actual: $${spot.toFixed(2)}.`,
        color: up ? 0x22c55e : 0xef4444,
        footer: {
          text: "Tito Metralleta · Vigilancia de niveles — informativo, no es una señal del piloto automático ni consejo financiero.",
        },
        timestamp: now.toISOString(),
      },
    ],
  };
}

export async function sendLevelCrossAlert(
  params: Parameters<typeof buildLevelCrossPayload>[0],
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await postToDiscord(buildLevelCrossPayload(params), `la alerta de nivel de ${params.ticker}`, fetchImpl);
}

/** Envía el resumen matutino al webhook de Discord. */
export async function sendMorningDigest(
  ideas: DigestIdea[],
  meta: { scanned: number; tickers: number },
  scanError: string | null,
  now: Date,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await postToDiscord(buildMorningDigestPayload(ideas, meta, scanError, now), "el resumen matutino", fetchImpl);
}
