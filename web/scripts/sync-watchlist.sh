#!/bin/bash
# Drenador del buzón de salida hacia el watchlist de opciones de Robinhood.
#
# Lo lanza launchd cada 15 min (ver com.tito.watchlist-sync.plist). También se puede
# correr a mano: bash scripts/sync-watchlist.sh
#
# Reparto de trabajo a propósito:
#   - Lo determinista (leer la cola, topar a 10, confirmar, registrar) lo hace ESTE shell.
#   - Lo único que necesita un modelo —resolver el contrato a un UUID de instrumento de
#     Robinhood— se delega a `claude -p` con una lista blanca de exactamente 3 herramientas.
#
# Por eso el agente no recibe Bash ni escritura de ficheros: no puede colocar una orden
# ni tocar la cola aunque se lo pidieran. La restricción la aplica el harness.
#
# Si la cola está vacía NO se invoca al modelo: coste cero en los pases en vacío.

set -uo pipefail

API="http://localhost:3000/api/watchlist"
BROKER="robinhood"
MAX_POR_PASE=10
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="$DIR/data/sync-log.jsonl"

registrar() { # registrar <evento> <detalle-json>
  mkdir -p "$(dirname "$LOG")"
  printf '{"at":"%s","evento":"%s","detalle":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" >> "$LOG"
}

# 1. ¿Está el servidor? Si no, no hay nada que hacer: la cola aguanta en disco y entra
#    en el siguiente pase. Salir en silencio es lo correcto, no un error.
PENDING_JSON="$(curl -sf --max-time 10 "$API?broker=$BROKER" 2>/dev/null)" || {
  exit 0
}

# 2. Recortar al tope y quedarnos con lo que el modelo necesita ver.
LOTE="$(printf '%s' "$PENDING_JSON" | python3 -c '
import json, sys
d = json.load(sys.stdin)
p = d.get("pending") or []
tope = int(sys.argv[1])
lote = p[:tope]
print(json.dumps({"lote": lote, "total": len(p), "recortado": len(p) > tope}))
' "$MAX_POR_PASE")" || exit 0

TOTAL="$(printf '%s' "$LOTE" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["lote"]))')"
[ "$TOTAL" -eq 0 ] && exit 0   # cola vacía → ni se toca el modelo

RECORTADO="$(printf '%s' "$LOTE" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["total"] if d["recortado"] else 0)')"
[ "$RECORTADO" != "0" ] && registrar "tope" "{\"pendientes\":$RECORTADO,\"empujados\":$MAX_POR_PASE}"

# 3. Resolver y empujar. El modelo solo ve el lote y solo puede llamar a esas 3 tools.
PROMPT="Eres el drenador del watchlist de Tito. Empuja estos contratos al watchlist de
opciones de Robinhood del usuario.

Cola (JSON): $(printf '%s' "$LOTE" | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["lote"]))')

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

SALIDA="$(cd "$DIR" && claude -p "$PROMPT" \
  --allowedTools "mcp__robinhood-trading__get_option_instruments,mcp__robinhood-trading__get_option_watchlist,mcp__robinhood-trading__add_option_to_watchlist" \
  2>&1)"

if [ $? -ne 0 ] || [ -z "$SALIDA" ]; then
  registrar "error_agente" "$(printf '%s' "${SALIDA:-sin salida}" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()[:400]))')"
  exit 0   # transitorio: no se marca nada, se reintenta al siguiente pase
fi

# 4. Confirmar contra la API. Un fallo aquí es inocuo: el pase siguiente ve el contrato
#    ya presente en Robinhood (get_option_watchlist) y solo marca, sin duplicar.
RESULTADO="$(printf '%s' "$SALIDA" | python3 -c '
import json, re, sys
raw = sys.stdin.read()
m = re.search(r"```json\s*(\{.*?\})\s*```", raw, re.S) or re.search(r"(\{.*\})", raw, re.S)
if not m:
    print(json.dumps({"synced": [], "failed": []})); sys.exit(0)
try:
    d = json.loads(m.group(1))
except Exception:
    print(json.dumps({"synced": [], "failed": []})); sys.exit(0)
print(json.dumps({
    "synced": [k for k in (d.get("synced") or []) if isinstance(k, str)],
    "failed": [f for f in (d.get("failed") or []) if isinstance(f, dict) and f.get("key")],
}))
')"

SYNCED="$(printf '%s' "$RESULTADO" | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["synced"]))')"
if [ "$SYNCED" != "[]" ]; then
  curl -sf --max-time 10 -X POST "$API" -H 'Content-Type: application/json' \
    -d "{\"broker\":\"$BROKER\",\"synced\":$SYNCED}" -o /dev/null
  registrar "sincronizado" "$SYNCED"
fi

# Los fallidos se marcan de uno en uno porque cada uno lleva su propio motivo.
printf '%s' "$RESULTADO" | python3 -c '
import json, sys
for f in json.load(sys.stdin)["failed"]:
    print(json.dumps({"key": f["key"], "reason": f.get("reason") or "No se pudo resolver."}))
' | while IFS= read -r linea; do
  KEY="$(printf '%s' "$linea" | python3 -c 'import json,sys; print(json.load(sys.stdin)["key"])')"
  REASON="$(printf '%s' "$linea" | python3 -c 'import json,sys; print(json.load(sys.stdin)["reason"])')"
  curl -sf --max-time 10 -X POST "$API" -H 'Content-Type: application/json' \
    -d "$(python3 -c 'import json,sys; print(json.dumps({"broker":sys.argv[1],"failed":[sys.argv[2]],"reason":sys.argv[3]}))' "$BROKER" "$KEY" "$REASON")" \
    -o /dev/null
  registrar "aparcado" "$linea"
done

exit 0
