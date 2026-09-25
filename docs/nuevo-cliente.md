# Alta de un cliente nuevo (objetivo: < 1 hora)

1. **Elegir plantilla** — `agentes templates` o la pestaña *Plantillas* de la consola (`/console`).
2. **Rellenar parámetros** — el formulario de la consola se genera del JSON Schema de la plantilla y produce el
   `cliente.yaml` base.
3. **Conectar sus sistemas** (solo si la plantilla usa capacidades opcionales):
   - ¿Tiene API con OpenAPI/Swagger? Añade un conector `type: openapi` con `spec:` (ruta o URL) y enlaza cada
     capacidad a una operación (`operationId` o `"GET /ruta"`).
   - ¿Tiene servidor MCP (Google Calendar, Calendly, su propio software…)? Conector `type: mcp` con `url:`.
     Al desplegar, la plataforma llama a `tools/list` con su credencial y enlaza cada capacidad a una tool por
     su nombre. Un mismo agente puede mezclar conectores MCP y OpenAPI.
   - Credenciales: `credentials: { nombre: { from_env: VARIABLE } }`. La CLI lee la variable y la sube cifrada;
     nunca se escribe el secreto en el YAML.
4. **Conocimiento** — `knowledge:` con rutas a sus documentos (FAQ, políticas, catálogo) o URLs.
5. **Probar sin publicar** — `agentes deploy cliente.yaml --dry-run` muestra tools, aprobaciones y errores.
6. **Publicar** — `AGENTES_TOKEN=<token> agentes deploy cliente.yaml`. Devuelve:
   - snippet del **widget** para su web,
   - endpoint **MCP** (para su Claude/ChatGPT/IDE/CRM),
   - endpoint **API** para sus sistemas,
   - **API keys** (admin/agent/widget; se muestran una sola vez).
7. **Evals** — `agentes eval --agent <id> --template templates/<plantilla>`.
8. **Operación** — su equipo usa `/console` con la key admin: aprobaciones pendientes, conversaciones,
   respuesta humana en handoffs, probador.

## Activar WhatsApp

1. Pide al cliente (o créalo con él en Meta Business): el **número** dado de alta en WhatsApp Business Cloud API,
   su **phone_number_id**, un **token de acceso** permanente (usuario de sistema) y el **app secret** de su app.
   Inventa un **verify token** cualquiera.
2. Añade al YAML:
   ```yaml
   channels: [widget, api, mcp, whatsapp]
   channel_settings:
     whatsapp:
       phone_number_id: "1234567890"
       credentials: { access_token: wa-token, app_secret: wa-app-secret, verify_token: wa-verify }
       reengagement_template: { name: seguimiento_pedido, language: es }   # plantilla aprobada en Meta (opcional)
   credentials:
     wa-token: { from_env: WA_ACCESS_TOKEN }
     wa-app-secret: { from_env: WA_APP_SECRET }
     wa-verify: { from_env: WA_VERIFY_TOKEN }
   ```
3. Despliega y, en Meta → WhatsApp → Configuración, pon como webhook
   `https://<tu-dominio>/v1/channels/whatsapp/<agent_id>/webhook` con el mismo verify token y suscribe `messages`.
4. Prueba en local sin Meta: `node examples/whatsapp-mock/server.mjs` (API de Meta simulada, con
   `WHATSAPP_API_BASE=http://localhost:9092` en la API) y
   `node examples/whatsapp-mock/send.mjs <wa_id> "hola" <url_webhook> <app_secret>`.

Qué hace la plataforma: verifica la firma de cada webhook, ignora reintentos duplicados, mantiene una
conversación por número, y envía por WhatsApp también las respuestas diferidas (aprobaciones resueltas,
respuestas de una persona del equipo). Fuera de la ventana de 24 h solo se puede escribir con una plantilla
aprobada: si no hay `reengagement_template`, el mensaje no se envía y queda como `channel.outside_window` en la
auditoría. **Precios**: Meta cobra por mensaje según país y tipo; varias fuentes indican cambios desde el
2026-10-01 para respuestas dentro de la ventana — verifica la tabla oficial antes de fijar precios al cliente.

Cambios posteriores: edita el YAML y vuelve a desplegar (idempotente; solo crea release si algo cambió).
Rollback: `POST /v1/agents/<id>/activate {"release_id": "rel_..."}`.

Ejemplos completos:
- [`ferreteria-lopez.yaml`](../examples/clientes/ferreteria-lopez.yaml): atención al cliente + CRM propio (OpenAPI).
- [`clinica-sonrisas.yaml`](../examples/clientes/clinica-sonrisas.yaml): citas con agenda por MCP + cobros por OpenAPI.
