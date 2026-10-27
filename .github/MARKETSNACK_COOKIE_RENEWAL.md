# Renovar MARKETSNACK_COOKIE

La cookie de sesión de `app.marketsnack.com` que usa el sub-agente Time & Sales/swing
caduca o rota sin aviso previo (a veces en minutos, no en una fecha fija). Cuando
`.github/workflows/marketsnack-cookie-check.yml` avise por Discord, o si la web
muestra "Sesión de MarketSnack inválida o expirada", seguir estos pasos:

1. Iniciar sesión en <https://app.marketsnack.com> en un navegador.
2. Abrir DevTools (`F12`) → pestaña **Network**.
3. Recargar la página o navegar a cualquier sección con datos.
4. Buscar una petición reciente a `api/flow_feed` (o cualquier `api/...`).
5. Clic en ella → **Headers** → **Request Headers** → copiar el valor completo
   del header `Cookie`.
6. **Actualizar rápido, sin dejar pasar tiempo** (la cookie puede rotar apenas se
   usa de nuevo en el navegador):
   - Local: pegar el valor en `web/.env.local`, variable `MARKETSNACK_COOKIE`.
   - Producción: Vercel → proyecto `agente-tito-metralleta` → Settings →
     Environment Variables → editar `MARKETSNACK_COOKIE` → pegar → Save →
     **Redeploy** (Vercel lo pide automáticamente tras guardar).
7. Confirmar en <https://agente-tito-metralleta.vercel.app> con un ticker
   cualquiera que ya no aparezca el aviso de sesión inválida.

No hay forma de predecir cuándo va a caducar de nuevo — el chequeo diario
(`marketsnack-cookie-check.yml`, corre 13:00 UTC) es lo que la detecta, no algo
que avise "un día antes".
