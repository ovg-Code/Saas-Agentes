# Alta de un cliente nuevo (objetivo: < 1 hora)

1. **Elegir plantilla** — `agentes templates` o la pestaña *Plantillas* de la consola (`/console`).
2. **Rellenar parámetros** — el formulario de la consola se genera del JSON Schema de la plantilla y produce el
   `cliente.yaml` base.
3. **Conectar sus sistemas** (solo si la plantilla usa capacidades opcionales):
   - ¿Tiene API con OpenAPI/Swagger? Añade un conector `type: openapi` con `spec:` (ruta o URL) y enlaza cada
     capacidad a una operación (`operationId` o `"GET /ruta"`).
   - ¿Tiene servidor MCP? Conector `type: mcp` con `url:`.
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

Cambios posteriores: edita el YAML y vuelve a desplegar (idempotente; solo crea release si algo cambió).
Rollback: `POST /v1/agents/<id>/activate {"release_id": "rel_..."}`.

Ejemplo completo: [`examples/clientes/ferreteria-lopez.yaml`](../examples/clientes/ferreteria-lopez.yaml).
