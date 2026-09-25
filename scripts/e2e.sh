#!/usr/bin/env bash
# Prueba de "despliegue rápido" de extremo a extremo, sin coste de LLM (modelo fake):
#   CRM mock (OpenAPI) + runtime Python + API  ->  `agentes deploy` de un cliente  ->  chat, aprobación, evals.
# Requiere Postgres con la migración aplicada (DATABASE_ADMIN_URL) — ver docs/desarrollo.md.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export DATABASE_ADMIN_URL="${DATABASE_ADMIN_URL:-postgres://agentes@localhost:5432/agentes}"
export DATABASE_URL="${DATABASE_URL:-postgres://agentes_app:agentes_app@localhost:5432/agentes}"
export PLATFORM_ADMIN_TOKEN="${PLATFORM_ADMIN_TOKEN:-e2e-platform-token}"
export VAULT_MASTER_KEY="${VAULT_MASTER_KEY:-$(openssl rand -base64 32)}"
export INTERNAL_TOKEN="${INTERNAL_TOKEN:-e2e-internal}"
export API_PORT=18080 RUNTIME_URL=http://localhost:18090 PUBLIC_BASE_URL=http://localhost:18080
export OAUTH_MOCK_URL=http://localhost:9093 OAUTH_MOCK_CLIENT_ID=agentes-dev OAUTH_MOCK_CLIENT_SECRET=agentes-dev-secret
export WHATSAPP_API_BASE=http://localhost:9092 WA_ACCESS_TOKEN=wa-demo-token WA_APP_SECRET=wa-demo-secret WA_VERIFY_TOKEN=wa-demo-verify
export AGENTES_API_URL=http://localhost:18080

LOGS="$(mktemp -d)"
cleanup() {
  # los servicios arrancan en subshells: se matan por patrón para no dejar procesos huérfanos
  pkill -f "agentes_runtime[.]api" 2>/dev/null || true
  pkill -f "agentes_runtime[.]temporal[.]worker" 2>/dev/null || true
  pkill -f "src/main[.]ts" 2>/dev/null || true
  pkill -f "crm-mock/server[.]mjs" 2>/dev/null || true
  pkill -f "agenda-mock/server[.]mjs" 2>/dev/null || true
  pkill -f "whatsapp-mock/server[.]mjs" 2>/dev/null || true
  pkill -f "oauth-mock/server[.]mjs" 2>/dev/null || true
  rm -f "$ROOT/examples/clientes/.e2e.yaml" "$ROOT/examples/clientes/.e2e-citas.yaml" "$ROOT/examples/clientes/.e2e-google.yaml"
  [ "${E2E_OK:-0}" = 1 ] || echo "logs en $LOGS"
}
trap cleanup EXIT

CRM_API_KEY=crm-demo-key PORT=9090 node examples/crm-mock/server.mjs >"$LOGS/crm.log" 2>&1 &
OAUTH_CLIENT_ID=agentes-dev OAUTH_CLIENT_SECRET=agentes-dev-secret ACCESS_TTL=61 PORT=9093 node examples/oauth-mock/server.mjs >"$LOGS/oauth.log" 2>&1 &
OAUTH_INTROSPECT_URL=http://localhost:9093/introspect AGENDA_TOKEN=agenda-demo-token PORT=9091 node examples/agenda-mock/server.mjs >"$LOGS/agenda.log" 2>&1 &
PORT=9092 node examples/whatsapp-mock/server.mjs >"$LOGS/whatsapp.log" 2>&1 &
# espera hasta que un comando tenga éxito (canales asíncronos: la respuesta no vuelve en la petición)
wait_for() { for _ in $(seq 1 50); do eval "$1" >/dev/null 2>&1 && return 0; sleep 0.2; done; echo "timeout esperando: $1"; return 1; }
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(eval(process.argv[1]))})' "$1"; }
(cd services/runtime && LLM_PROVIDER=fake EMBEDDINGS_PROVIDER=fake PORT=18090 CONTROL_PLANE_URL=http://localhost:18080 \
  uv run python -m agentes_runtime.api >"$LOGS/runtime.log" 2>&1) &
if [ "${RUNTIME_MODE:-direct}" = temporal ]; then
  # Modo durable: las conversaciones viven en workflows de Temporal (servidor en $TEMPORAL_ADDRESS,
  # p.ej. `uv run python ../../scripts/temporal-dev.py` o docker compose).
  (cd services/runtime && LLM_PROVIDER=fake EMBEDDINGS_PROVIDER=fake CONTROL_PLANE_URL=http://localhost:18080 \
    uv run python -m agentes_runtime.temporal.worker >"$LOGS/worker.log" 2>&1) &
fi
pnpm --filter @agentes/agent-spec build >/dev/null
(cd apps/api && npx tsx src/main.ts >"$LOGS/api.log" 2>&1) &

for url in http://localhost:18080/health http://localhost:18090/health; do
  for _ in $(seq 1 60); do curl -sf "$url" >/dev/null && break; sleep 0.5; done
  curl -sf "$url" >/dev/null || { echo "no arrancó $url"; tail -50 "$LOGS"/*.log; exit 1; }
done

echo "(modo runtime: ${RUNTIME_MODE:-direct})"
echo "== 1. Desplegar cliente nuevo desde YAML (un paso) =="
SLUG="e2e-$(date +%s)"
sed "s/slug: ferreteria-lopez/slug: $SLUG/" examples/clientes/ferreteria-lopez.yaml > examples/clientes/.e2e.yaml

OUT=$(AGENTES_TOKEN=$PLATFORM_ADMIN_TOKEN CRM_LOPEZ_API_KEY=crm-demo-key node apps/cli/bin/agentes.js deploy examples/clientes/.e2e.yaml)
echo "$OUT"
AGENT_KEY=$(echo "$OUT" | sed -n 's/^ *agent *\(ak_[^ ]*\).*/\1/p')
ADMIN_KEY=$(echo "$OUT" | sed -n 's/^ *admin *\(ak_[^ ]*\).*/\1/p')
AGENT_ID=$(echo "$OUT" | sed -n 's#.*/v1/agents/\([0-9a-f-]*\)/chat.*#\1#p' | head -1)
test -n "$AGENT_KEY" && test -n "$ADMIN_KEY" && test -n "$AGENT_ID"

echo "== 2. Pregunta de FAQ (RAG) =="
AGENTES_TOKEN=$AGENT_KEY node apps/cli/bin/agentes.js chat --agent "$AGENT_ID" "¿Cuánto cuesta el envío?" | tee "$LOGS/faq.txt"
grep -q "49" "$LOGS/faq.txt"

echo "== 3. Consulta al CRM propio del cliente =="
AGENTES_TOKEN=$AGENT_KEY node apps/cli/bin/agentes.js chat --agent "$AGENT_ID" "¿Dónde está mi pedido 1001?" | tee "$LOGS/pedido.txt"
grep -q "en reparto" "$LOGS/pedido.txt"

echo "== 4. Reembolso -> aprobación humana -> ejecución en el CRM =="
R=$(curl -sf -X POST "$AGENTES_API_URL/v1/agents/$AGENT_ID/chat" -H "authorization: Bearer $AGENT_KEY" -H 'content-type: application/json' \
  -d '{"message":"Quiero el reembolso del pedido 1001"}')
echo "$R"
APPROVAL=$(echo "$R" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(j.status!=="awaiting_approval")process.exit(1);console.log(j.approvals[0].id)})')
test "$(curl -sf http://localhost:9090/_debug | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).reembolsos.length))')" = "0"
curl -sS --fail-with-body -X POST "$AGENTES_API_URL/v1/approvals/$APPROVAL" -H "authorization: Bearer $ADMIN_KEY" -H 'content-type: application/json' \
  -d '{"approve":true,"by":"e2e"}'
echo
test "$(curl -sf http://localhost:9090/_debug | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).reembolsos.length))')" = "1"

echo "== 5. El agente como servidor MCP =="
curl -sf -X POST "$AGENTES_API_URL/v1/agents/$AGENT_ID/mcp" -H "authorization: Bearer $AGENT_KEY" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"preguntar","arguments":{"message":"¿Hacéis copias de llaves?"}}}' | tee "$LOGS/mcp.json"
grep -q "llaves" "$LOGS/mcp.json"
echo

echo "== 6. Evals golden de la plantilla =="
AGENTES_TOKEN=$AGENT_KEY node apps/cli/bin/agentes.js eval --agent "$AGENT_ID" --template templates/atencion-cliente

echo "== 7. Segundo cliente con OTRA plantilla (agendar-citas): agenda por MCP + pagos por OpenAPI =="
sed "s/slug: clinica-sonrisas/slug: $SLUG-clinica/" examples/clientes/clinica-sonrisas.yaml > examples/clientes/.e2e-citas.yaml
OUT2=$(AGENTES_TOKEN=$PLATFORM_ADMIN_TOKEN AGENDA_TOKEN=agenda-demo-token node apps/cli/bin/agentes.js deploy examples/clientes/.e2e-citas.yaml)
echo "$OUT2"
CITAS_KEY=$(echo "$OUT2" | sed -n 's/^ *agent *\(ak_[^ ]*\).*/\1/p')
CITAS_ADMIN=$(echo "$OUT2" | sed -n 's/^ *admin *\(ak_[^ ]*\).*/\1/p')
CITAS_ID=$(echo "$OUT2" | sed -n 's#.*/v1/agents/\([0-9a-f-]*\)/chat.*#\1#p' | head -1)
echo "$OUT2" | grep -q "calendario__crear_cita .*agenda: crear_cita"

chat_citas() {
  curl -sf -X POST "$AGENTES_API_URL/v1/agents/$CITAS_ID/chat" -H "authorization: Bearer $CITAS_KEY" -H 'content-type: application/json' \
    -d "$(node -e 'console.log(JSON.stringify({message: process.argv[1], ...(process.argv[2] ? {conversation_id: process.argv[2]} : {})}))' "$1" "${2:-}")"
}
R=$(chat_citas "¿Qué huecos tenéis mañana?"); echo "$R" | json 'j.reply'
test "$(echo "$R" | json 'j.tools_executed.join()')" = "calendario__disponibilidad"

R=$(chat_citas "Quiero reservar mañana a las 16:30, soy Marta Díaz"); echo "$R" | json 'j.reply'
CONV=$(echo "$R" | json 'j.conversation_id')
CITA=$(curl -sf http://localhost:9091/_debug | json 'j.citas.find(c=>c.hora==="16:30"&&c.nombre_cliente==="Marta Díaz").id')
echo "cita creada en la agenda del cliente: $CITA"

R=$(chat_citas "Cobradme la señal de la cita $CITA" "$CONV")
test "$(echo "$R" | json 'j.status')" = "awaiting_approval"
test "$(curl -sf http://localhost:9091/_debug | json 'j.cobros.length')" = "0"
curl -sS --fail-with-body -X POST "$AGENTES_API_URL/v1/approvals/$(echo "$R" | json 'j.approvals[0].id')" \
  -H "authorization: Bearer $CITAS_ADMIN" -H 'content-type: application/json' -d '{"approve":true,"by":"recepcion"}' | json 'j.reply'
test "$(curl -sf http://localhost:9091/_debug | json 'j.cobros.length')" = "1"

AGENTES_TOKEN=$CITAS_KEY node apps/cli/bin/agentes.js eval --agent "$CITAS_ID" --template templates/agendar-citas

echo "== 8. Canal WhatsApp: el cliente escribe al número de la ferretería =="
WA_URL="$AGENTES_API_URL/v1/channels/whatsapp/$AGENT_ID/webhook"
test "$(curl -sf "$WA_URL?hub.mode=subscribe&hub.verify_token=$WA_VERIFY_TOKEN&hub.challenge=ok123")" = "ok123"
node examples/whatsapp-mock/send.mjs 34600111222 "¿Dónde está mi pedido 1001?" "$WA_URL" "$WA_APP_SECRET"
wait_for 'curl -sf http://localhost:9092/_debug | grep -q "en reparto"'
curl -sf http://localhost:9092/_debug | json 'j.sent.at(-1).to + " <- " + j.sent.at(-1).text.body'

node examples/whatsapp-mock/send.mjs 34600111222 "Quiero el reembolso del pedido 1002" "$WA_URL" "$WA_APP_SECRET"
wait_for 'curl -sf "$AGENTES_API_URL/v1/approvals" -H "authorization: Bearer $ADMIN_KEY" | grep -q 1002'
APPROVAL=$(curl -sf "$AGENTES_API_URL/v1/approvals" -H "authorization: Bearer $ADMIN_KEY" | json 'j.approvals.find(a=>a.input.numero==="1002").id')
curl -sS --fail-with-body -X POST "$AGENTES_API_URL/v1/approvals/$APPROVAL" -H "authorization: Bearer $ADMIN_KEY" \
  -H 'content-type: application/json' -d '{"approve":true,"by":"e2e"}' >/dev/null
wait_for 'curl -sf http://localhost:9092/_debug | grep -q "pedido[^,]*1002"'
echo "resultado del reembolso enviado por WhatsApp:"
curl -sf http://localhost:9092/_debug | json 'j.sent.at(-1).text.body'

echo "== 9. Conexión OAuth: el cliente autoriza su agenda con un clic y los tokens se renuevan solos =="
sed "s/slug: clinica-sonrisas-google/slug: $SLUG-google/" examples/clientes/clinica-sonrisas-google.yaml > examples/clientes/.e2e-google.yaml
set +e
OUT3=$(AGENTES_TOKEN=$PLATFORM_ADMIN_TOKEN node apps/cli/bin/agentes.js deploy examples/clientes/.e2e-google.yaml); RC=$?
set -e
echo "$OUT3"
test "$RC" = 3
LINK=$(echo "$OUT3" | grep -o 'http://[^ ]*/v1/oauth/start/[A-Za-z0-9_-]*' | head -1)
echo "-> el cliente abre el enlace y acepta:"
curl -sfL "$LINK" | grep -o "Tu cuenta de [^.]*\. [^<]*"
OUT3=$(AGENTES_TOKEN=$PLATFORM_ADMIN_TOKEN node apps/cli/bin/agentes.js deploy examples/clientes/.e2e-google.yaml)
echo "$OUT3" | grep -E "release|calendario__crear_cita"
G_KEY=$(echo "$OUT3" | sed -n 's/^ *agent *\(ak_[^ ]*\).*/\1/p')
G_ID=$(echo "$OUT3" | sed -n 's#.*/v1/agents/\([0-9a-f-]*\)/chat.*#\1#p' | head -1)
AGENTES_TOKEN=$G_KEY node apps/cli/bin/agentes.js chat --agent "$G_ID" "Quiero reservar mañana a las 12:00, soy Rosa Vidal" | tail -1
sleep 2   # el access token entra en su último minuto de vida -> la plataforma lo renueva sola
R=$(AGENTES_TOKEN=$G_KEY node apps/cli/bin/agentes.js chat --agent "$G_ID" "Quiero reservar mañana a las 12:30, soy Rosa Vidal")
echo "$R" | tail -1
echo "$R" | grep -q "12:30"
test "$(curl -sf http://localhost:9093/_debug | json 'j.refreshes')" -ge 1
echo "renovaciones de token realizadas por la plataforma: $(curl -sf http://localhost:9093/_debug | json 'j.refreshes')"

E2E_OK=1
echo -e "\n✔ E2E completado"
