#!/usr/bin/env node
// Dispara una corrida del piloto automático (SIMULACIÓN) contra el dev server local.
//
// Pensado para Task Scheduler de Windows — NO reimplementa el escaneo (vive en
// app/api/autopilot/scan/route.ts, que a su vez usa los mismos archivos JSON en
// web/data/ que lee el dev server): solo lo dispara por HTTP. Por eso `npm run dev`
// tiene que estar corriendo — no hay servidor desplegado, es un proyecto local.
//
// Uso:
//   node scripts/autopilot-scan.mjs [puerto] [url-completa]
//   - Sin nada: pega a http://localhost:3000/api/autopilot/scan
//   - Con url-completa: pega ahí en vez de localhost (ej. un despliegue en Vercel).
//     Si CRON_SECRET está en el entorno, se manda como header x-cron-secret
//     (necesario si el endpoint remoto lo exige — ver isAuthorized en route.ts).
//
// Registro en Task Scheduler (ejemplo, cada 15 min en horario de mercado):
//   schtasks /create /tn "TitoAutopilot" /tr "node C:\ruta\a\web\scripts\autopilot-scan.mjs 3000" ^
//     /sc minute /mo 15 /st 09:30 /et 16:00

const port = process.argv[2] || "3000";
const url = process.argv[3] || `http://localhost:${port}/api/autopilot/scan`;

const stamp = () => new Date().toISOString();

try {
  const secret = process.env.CRON_SECRET;
  const res = await fetch(url, {
    method: "POST",
    headers: secret ? { "x-cron-secret": secret } : {},
  });
  const data = await res.json();

  if (!res.ok) {
    console.error(`[${stamp()}] Piloto respondió ${res.status}:`, data.error ?? data);
    process.exit(1);
  }

  console.log(
    `[${stamp()}] Escaneados ${data.scanned} · trades AUTO nuevos: ${data.createdTrades} · alertas: ${data.alerts}` +
      (data.degraded?.marketsnack ? ` · vía swing degradada (${data.degraded.reason})` : "") +
      (data.errors?.length ? ` · ${data.errors.length} error(es) de ticker` : ""),
  );
  for (const c of data.candidates ?? []) {
    console.log(`    → ${c.ticker} (${c.path}, prob ${c.probability}%)`);
  }
  if (data.errors?.length) {
    for (const e of data.errors) console.log(`    ! ${e}`);
  }
} catch (err) {
  console.error(
    `[${stamp()}] No se pudo contactar ${url}. ¿Está corriendo "npm run dev" en web/? `,
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
}
