#!/bin/bash
# Drenador del buzón de salida hacia el watchlist de opciones de Robinhood.
#
# Variante Windows de sync-watchlist.sh: el original asume `launchd` (macOS),
# `python3` y pega a http://localhost:3000 (servidor local de desarrollo).
# Esta corre bajo Task Scheduler de Windows, usa `node` (python3 no está
# realmente instalado en esta máquina — el "python3" del PATH es solo el
# acceso directo de la Tienda) y pega directo al despliegue de Vercel, porque
# el buzón vive en Redis (lib/persist.ts), accesible solo vía la API desplegada.
#
# Mismo reparto de trabajo que el original a propósito:
#   - Lo determinista (leer la cola, topar a 10, confirmar, registrar) lo hace
#     ESTE shell.
#   - Lo único que necesita un modelo —resolver el contrato a un UUID de
#     instrumento de Robinhood— se delega a `claude -p` con una lista blanca de
#     EXACTAMENTE 3 herramientas. Sin Bash y sin place_option_order: el proceso
#     es incapaz de colocar una orden.
#
# Requiere que ANTES se haya corrido, en una terminal interactiva (no aquí):
#   claude mcp add robinhood-trading --transport http https://agent.robinhood.com/mcp/trading --scope user
# y completado el OAuth de Robinhood (/mcp). Sin eso, `claude -p` falla al no
# encontrar las herramientas — se registra como error transitorio y no se
# marca nada (se reintenta el siguiente pase, cada 15 min).
#
# Si la cola está vacía NO se invoca al modelo: coste cero en los pases en vacío.

set -uo pipefail

CLAUDE="/c/Users/Pedro/AppData/Local/Packages/Claude_pzs8sxrjxfjjc/LocalCache/Roaming/Claude/claude-code/2.1.260/claude.exe"
API="https://agente-tito-metralleta.vercel.app/api/watchlist"
BROKER="robinhood"
MAX_POR_PASE=10
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="$DIR/data/sync-log.jsonl"

registrar() { # registrar <evento> <detalle-json>
  mkdir -p "$(dirname "$LOG")"
  printf '{"at":"%s","evento":"%s","detalle":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" >> "$LOG"
}

# 1. ¿Responde el despliegue? Si no, no hay nada que hacer: la cola vive en
#    Redis y aguanta al siguiente pase. Salir en silencio es lo correcto.
PENDING_JSON="$(curl -sf --max-time 15 "$API?broker=$BROKER" 2>/dev/null)" || {
  exit 0
}

# 2. Recortar al tope y quedarnos con lo que el modelo necesita ver.
LOTE="$(printf '%s' "$PENDING_JSON" | node -e '
const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
const p = d.pending || [];
const tope = parseInt(process.argv[1], 10);
const lote = p.slice(0, tope);
process.stdout.write(JSON.stringify({ lote, total: p.length, recortado: p.length > tope }));
' "$MAX_POR_PASE")" || exit 0

TOTAL="$(printf '%s' "$LOTE" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).lote.length)')"
[ "$TOTAL" -eq 0 ] && exit 0   # cola vacía → ni se toca el modelo

RECORTADO="$(printf '%s' "$LOTE" | node -e '
const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
console.log(d.recortado ? d.total : 0);
')"
[ "$RECORTADO" != "0" ] && registrar "tope" "{\"pendientes\":$RECORTADO,\"empujados\":$MAX_POR_PASE}"

# 3. Resolver y empujar. El modelo solo ve el lote y solo puede llamar a esas 3 tools.
LOTE_JSON="$(printf '%s' "$LOTE" | node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(0,"utf8")).lote))')"

PROMPT="Eres el drenador del watchlist de Tito. Empuja estos contratos al watchlist de
opciones de Robinhood del usuario.

Cola (JSON): $LOTE_JSON

Para cada ítem:
1. Si le falta 'strike' o 'expiration', NO se puede resolver: va a 'failed' con motivo
   'Sin strike o vencimiento: encolado con el formato viejo.' No lo intentes igualmente.
2. Si los tiene, llama a get_option_instruments con chain_symbol=<ticker>, type=<type>,
   strike_price=<strike con EXACTAMENTE 4 decimales, p.ej. 20.0000>, expiration_dates=<expiration>.
   El strike sin los 4 decimales devuelve vacío sin explicar por qué.
3. Si no devuelve ningún instrumento, va a 'failed' con motivo 'Robinhood no encuentra el contrato.'

Después llama UNA vez a get_option_watchlist. Los instrumentos que ya estén ahí cuentan
como sincronizados (no los vuelvas a añadir). Con los que falten, llama UNA vez a
add_option_to_watchlist con todos sus option_ids.

La clave ('key') de cada ítem es su campo 'symbol' si lo tiene, y si no su 'ticker'.

Responde SOLO con un bloque de código JSON, sin texto alrededor:
\`\`\`json
{\"synced\": [\"KEY1\", \"KEY2\"], \"failed\": [{\"key\": \"KEY3\", \"reason\": \"motivo corto\"}]}
\`\`\`"

SALIDA="$("$CLAUDE" -p "$PROMPT" \
  --allowedTools "mcp__robinhood-trading__get_option_instruments,mcp__robinhood-trading__get_option_watchlist,mcp__robinhood-trading__add_option_to_watchlist" \
  2>&1)"

if [ $? -ne 0 ] || [ -z "$SALIDA" ]; then
  registrar "error_agente" "$(printf '%s' "${SALIDA:-sin salida}" | node -e 'console.log(JSON.stringify(require("fs").readFileSync(0,"utf8").slice(0,400)))')"
  exit 0   # transitorio (incl. MCP de Robinhood aún no autorizado en esta terminal):
           # no se marca nada, se reintenta al siguiente pase
fi

# 4. Confirmar contra la API. Un fallo aquí es inocuo: el pase siguiente ve el contrato
#    ya presente en Robinhood (get_option_watchlist) y solo marca, sin duplicar.
RESULTADO="$(printf '%s' "$SALIDA" | node -e '
const raw = require("fs").readFileSync(0, "utf8");
const m = raw.match(/```json\s*(\{[\s\S]*?\})\s*```/) || raw.match(/(\{[\s\S]*\})/);
let d = { synced: [], failed: [] };
if (m) {
  try { d = JSON.parse(m[1]); } catch { d = { synced: [], failed: [] }; }
}
console.log(JSON.stringify({
  synced: (d.synced || []).filter((k) => typeof k === "string"),
  failed: (d.failed || []).filter((f) => f && typeof f === "object" && f.key),
}));
')"

SYNCED="$(printf '%s' "$RESULTADO" | node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(0,"utf8")).synced))')"
if [ "$SYNCED" != "[]" ]; then
  curl -sf --max-time 15 -X POST "$API" -H 'Content-Type: application/json' \
    -d "{\"broker\":\"$BROKER\",\"synced\":$SYNCED}" -o /dev/null
  registrar "sincronizado" "$SYNCED"
fi

# Los fallidos se marcan de uno en uno porque cada uno lleva su propio motivo.
printf '%s' "$RESULTADO" | node -e '
const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
for (const f of d.failed) {
  console.log(JSON.stringify({ key: f.key, reason: f.reason || "No se pudo resolver." }));
}
' | while IFS= read -r linea; do
  KEY="$(printf '%s' "$linea" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).key)')"
  REASON="$(printf '%s' "$linea" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).reason)')"
  curl -sf --max-time 15 -X POST "$API" -H 'Content-Type: application/json' \
    -d "$(node -e 'console.log(JSON.stringify({broker:process.argv[1],failed:[process.argv[2]],reason:process.argv[3]}))' "$BROKER" "$KEY" "$REASON")" \
    -o /dev/null
  registrar "aparcado" "$linea"
done

exit 0
