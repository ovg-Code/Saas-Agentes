# Saas-Agentes

Plataforma para **crear plantillas de agentes de IA una vez** y **desplegarlas en minutos** para cada empresa:
atención al cliente, citas, inventario, CRM operado por agentes, conciliaciones… hasta agentes autónomos.
Cada despliegue se integra donde el cliente ya trabaja: su web (widget de una línea), su CRM/ERP propio (basta
su OpenAPI), servidores MCP, el Claude/ChatGPT de su equipo (cada agente es un servidor MCP) o su backend (API).

```bash
# Un cliente nuevo = un YAML sin código
AGENTES_TOKEN=... CRM_LOPEZ_API_KEY=... pnpm agentes deploy examples/clientes/ferreteria-lopez.yaml

✔ Asistente de Ferretería López
  plantilla   atencion-cliente@1.0.0   autonomía L3
  Tools
   ▶ conocimiento__buscar     read         plataforma
   ▶ pedidos__consultar       read         crm-lopez: GET /pedidos/{numero}
   ⏸ pedidos__reembolsar      financial    crm-lopez: POST /pedidos/{numero}/reembolso   (requiere aprobación)
   ▶ tickets__crear           write        crm-lopez: POST /tickets
  Integración
   API chat   POST …/v1/agents/<id>/chat
   MCP        …/v1/agents/<id>/mcp
   Widget     <script src="…/widget.js" data-agent="<id>" data-key="…" async></script>
```

Plantillas incluidas: **atención al cliente** (FAQ, pedidos, tickets, reembolsos con aprobación) y
**agendar citas** (huecos, reservas, cancelaciones, cobro de señal con aprobación). Clientes de ejemplo en
[`examples/clientes/`](examples/clientes/).

## Cómo funciona

Parametrización en **4 capas**: *plantilla* (la escribimos una vez, con capacidades abstractas como
`crm.crear_ticket`) → *conector* (su sistema, importado de OpenAPI o MCP) → *despliegue* (parámetros y enlaces del
cliente, sin código) → *release* inmutable que ejecuta el runtime. La autonomía (L1 asistente … L5 autónomo) es
una política por nivel × riesgo de cada acción, con aprobación humana donde toque.

- 📐 [Arquitectura, investigación y decisiones](docs/arquitectura.md) · [ADRs](docs/adr/)
- 🧩 [Crear una plantilla nueva](docs/nueva-plantilla.md)
- 🚀 [Alta de un cliente](docs/nuevo-cliente.md)
- 🛠️ [Desarrollo local y tests](docs/desarrollo.md)

## Stack

TypeScript (plano de control, Fastify, monolito modular) · Python (runtime agéntico, worker de Temporal) ·
Postgres + RLS + pgvector · Temporal · LiteLLM (multi-proveedor, Claude por defecto) · Langfuse · MCP ·
docker-compose y Helm (SaaS, dedicado u on-prem).
