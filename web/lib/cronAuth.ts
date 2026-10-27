// Verificación del secreto compartido para disparar escaneos remotos
// (POST /api/autopilot/scan). Función pura — sin esto, el endpoint desplegado
// públicamente sería invocable por cualquiera que conozca la URL.

/**
 * Sin `secret` configurado (despliegue local, sin CRON_SECRET) siempre autoriza.
 * Con `secret` configurado, exige que `headerValue` coincida exactamente.
 */
export function isAuthorized(headerValue: string | null, secret: string | undefined): boolean {
  if (!secret) return true;
  return headerValue === secret;
}

/**
 * Vercel Cron Jobs (vercel.json `crons`) invocan por GET y mandan el secret
 * en `Authorization: Bearer <CRON_SECRET>` — no dejan mandar headers propios
 * como `x-cron-secret`. Mismo secret, formato distinto.
 */
export function isVercelCronAuthorized(authHeader: string | null, secret: string | undefined): boolean {
  if (!secret) return true;
  return authHeader === `Bearer ${secret}`;
}
