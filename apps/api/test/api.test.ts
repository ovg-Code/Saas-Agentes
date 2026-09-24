/**
 * Tests de integración del plano de control contra Postgres real (RLS incluida) y un runtime simulado.
 * Requiere TEST_DATABASE_ADMIN_URL (superusuario/propietario). Crea una BD temporal por ejecución.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { parse as parseYaml } from "yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { RuntimeGateway, TurnInput, TurnResult } from "../src/modules/conversations/runtime.js";
import { createDb, type Db } from "../src/shared/db.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL;
const PLATFORM = "platform-test-token";
const INTERNAL = "internal-test-token";

class StubRuntime implements RuntimeGateway {
  readonly mode = "direct" as const;
  calls: TurnInput[] = [];
  ingested: string[] = [];
  async turn(p: Parameters<RuntimeGateway["turn"]>[0]) {
    this.calls.push(p.input);
    const base: TurnResult = { status: "completed", reply: "", approvals_requested: [], handoff: null, tools_executed: [], events: [] };
    let result: TurnResult;
    if (p.input.kind === "user_message" && p.input.text.includes("reembolso")) {
      result = {
        ...base,
        status: "awaiting_approval",
        reply: "Una persona revisará el reembolso.",
        approvals_requested: [{ tool_use_id: "tu_1", tool: "pedidos__reembolsar", capability: "pedidos.reembolsar", tier: "financial", input: { numero: "1001" }, reason: "x" }],
        events: [{ type: "approval.requested", data: { tool_use_id: "tu_1" } }, { type: "llm.call", data: { input_tokens: 100, output_tokens: 20 } }],
      };
    } else if (p.input.kind === "approval_decision") {
      const ok = p.input.decisions.tu_1;
      result = {
        ...base,
        reply: ok ? "Reembolso emitido." : "No se ha podido.",
        tools_executed: ok ? ["pedidos__reembolsar"] : [],
        events: [{ type: "approval.decided", data: { tool_use_id: "tu_1", approved: ok, by: p.input.decided_by } }],
      };
    } else {
      result = { ...base, reply: `eco: ${p.input.kind === "user_message" ? p.input.text : ""}` };
    }
    return { state: { status: result.status === "awaiting_approval" ? "awaiting_approval" : "idle", n: this.calls.length }, result };
  }
  async ingest(p: Parameters<RuntimeGateway["ingest"]>[0]) {
    this.ingested.push(`${p.tenant_id}:${p.source}`);
    return { chunks: 3 };
  }
}

const describeDb = ADMIN_URL ? describe : describe.skip;

describeDb("plano de control (integración)", () => {
  const dbName = `agentes_test_${Date.now()}`;
  let db: Db;
  let app: ReturnType<typeof buildApp>;
  const runtime = new StubRuntime();

  const deploymentYaml = () => parseYaml(readFileSync(join(ROOT, "examples/clientes/ferreteria-lopez.yaml"), "utf8"));
  const deployBody = (overrides: Record<string, unknown> = {}) => ({
    deployment: { ...deploymentYaml(), ...overrides },
    connector_specs: { "crm-lopez": readFileSync(join(ROOT, "examples/crm-mock/openapi.yaml"), "utf8") },
    secrets: { "crm-lopez-key": "crm-demo-key" },
    knowledge: [{ source: "faq.md", title: "FAQ", text: "## Devoluciones\n30 días." }],
  });
  const inject = (method: "GET" | "POST", url: string, token: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload !== undefined ? { payload: payload as object } : {}) });

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const u = new URL(ADMIN_URL!);
    u.pathname = `/${dbName}`;
    const mig = new pg.Client({ connectionString: u.toString() });
    await mig.connect();
    await mig.query(readFileSync(join(ROOT, "db/migrations/001_init.sql"), "utf8"));
    await mig.end();
    const appUrl = new URL(u.toString());
    appUrl.username = "agentes_app";
    appUrl.password = "agentes_app";
    db = createDb(appUrl.toString(), u.toString());
    app = buildApp({
      db,
      runtime,
      templatesDir: join(ROOT, "templates"),
      vaultMasterKey: Buffer.alloc(32, 7),
      platformAdminToken: PLATFORM,
      internalToken: INTERNAL,
      publicBaseUrl: "http://api.test",
    });
  });

  afterAll(async () => {
    await app?.close();
    await db?.close();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  let adminKey = "";
  let agentKey = "";
  let widgetKey = "";
  let agentId = "";
  let tenantId = "";

  it("despliega un cliente en un solo paso", async () => {
    const r = await inject("POST", "/v1/deploy", PLATFORM, deployBody());
    expect(r.statusCode, r.body).toBe(201);
    const body = r.json();
    expect(body.tenant.created).toBe(true);
    expect(body.release.changed).toBe(true);
    expect(body.tools.find((t: { name: string }) => t.name === "pedidos__reembolsar").approval).toBe("ask");
    expect(body.knowledge).toEqual([{ source: "faq.md", chunks: 3 }]);
    expect(body.endpoints.widget_snippet).toContain(body.keys.widget);
    ({ admin: adminKey, agent: agentKey, widget: widgetKey } = body.keys);
    agentId = body.agent.id;
    tenantId = body.tenant.id;
    expect(adminKey && agentKey && widgetKey).toBeTruthy();
  });

  it("redesplegar lo mismo es idempotente (mismo release, sin nuevas keys)", async () => {
    const r = await inject("POST", "/v1/deploy", adminKey, deployBody());
    expect(r.statusCode).toBe(200);
    expect(r.json().release.changed).toBe(false);
    expect(r.json().keys).toEqual({});
  });

  it("un cambio de parámetros crea un release nuevo y se puede hacer rollback", async () => {
    const first = (await inject("GET", `/v1/agents/${agentId}/releases`, adminKey)).json().releases[0].id;
    const d = deploymentYaml();
    d.params.tono = "formal";
    const r = await inject("POST", "/v1/deploy", adminKey, { ...deployBody(), deployment: d });
    expect(r.json().release.changed).toBe(true);
    const rb = await inject("POST", `/v1/agents/${agentId}/activate`, adminKey, { release_id: first });
    expect(rb.json().active_release_id).toBe(first);
  });

  it("dry-run devuelve el release sin publicar", async () => {
    const d = deploymentYaml();
    d.params.tono = "tecnico";
    const r = await inject("POST", "/v1/deploy", adminKey, { ...deployBody(), deployment: d, dry_run: true });
    expect(r.json().dry_run).toBe(true);
    expect(r.json().preview.params.tono).toBe("tecnico");
    const releases = (await inject("GET", `/v1/agents/${agentId}/releases`, adminKey)).json().releases;
    expect(releases).toHaveLength(2);
  });

  it("un despliegue inválido explica todos los problemas", async () => {
    const d = deploymentYaml();
    d.autonomy = "L5";
    d.bindings["pedidos.consultar"].operation = "GET /nada";
    const r = await inject("POST", "/v1/deploy", adminKey, { ...deployBody(), deployment: d });
    expect(r.statusCode).toBe(400);
    const paths = r.json().details.map((i: { path: string }) => i.path);
    expect(paths).toEqual(expect.arrayContaining(["/autonomy", "/bindings/pedidos.consultar"]));
  });

  it("los secretos se guardan cifrados y solo el runtime los canjea", async () => {
    const { rows } = await db.admin.query("SELECT ciphertext FROM credentials");
    expect(rows[0].ciphertext.toString()).not.toContain("crm-demo-key");
    const ok = await app.inject({
      method: "POST",
      url: "/internal/credentials/resolve",
      headers: { "x-internal-token": INTERNAL },
      payload: { tenant_id: tenantId, ref: "vault://ferreteria-lopez/crm-lopez-key" },
    });
    expect(ok.json().secret).toBe("crm-demo-key");
    const noToken = await app.inject({ method: "POST", url: "/internal/credentials/resolve", payload: { tenant_id: tenantId, ref: "vault://ferreteria-lopez/crm-lopez-key" } });
    expect(noToken.statusCode).toBe(401);
  });

  it("chat -> aprobación pendiente -> aprobar -> reanuda y audita", async () => {
    const r1 = await inject("POST", `/v1/agents/${agentId}/chat`, agentKey, { message: "quiero un reembolso del 1001" });
    expect(r1.statusCode, r1.body).toBe(200);
    const c1 = r1.json();
    expect(c1.status).toBe("awaiting_approval");
    expect(c1.approvals).toHaveLength(1);

    // la key del agente no puede aprobar
    expect((await inject("POST", `/v1/approvals/${c1.approvals[0].id}`, agentKey, { approve: true })).statusCode).toBe(403);

    const pending = (await inject("GET", "/v1/approvals", adminKey)).json().approvals;
    expect(pending.map((a: { id: string }) => a.id)).toEqual([c1.approvals[0].id]);

    const r2 = await inject("POST", `/v1/approvals/${c1.approvals[0].id}`, adminKey, { approve: true, by: "ana" });
    expect(r2.json().reply).toBe("Reembolso emitido.");
    expect(runtime.calls.at(-1)).toMatchObject({ kind: "approval_decision", decisions: { tu_1: true }, decided_by: "ana" });

    // decidir dos veces no reanuda dos veces
    expect((await inject("POST", `/v1/approvals/${c1.approvals[0].id}`, adminKey, { approve: false })).statusCode).toBe(409);

    const conv = (await inject("GET", `/v1/conversations/${c1.conversation_id}`, adminKey)).json();
    expect(conv.messages.map((m: { role: string }) => m.role)).toEqual(["customer", "agent", "agent"]);
    expect(conv.input_tokens).toBe("100");
    const audit = await db.admin.query("SELECT action FROM audit_log WHERE conversation_id = $1 ORDER BY id", [c1.conversation_id]);
    expect(audit.rows.map((r) => r.action)).toEqual(["approval.requested", "llm.call", "approval.approved", "approval.decided"]);
    await expect(db.admin.query("DELETE FROM audit_log")).rejects.toThrow(/append-only/);
  });

  it("aislamiento: otro tenant no ve nada del primero", async () => {
    const other = deploymentYaml();
    other.tenant = { slug: "otra-empresa", name: "Otra" };
    const r = await inject("POST", "/v1/deploy", PLATFORM, { ...deployBody(), deployment: other });
    const otherAdmin = r.json().keys.admin;
    expect((await inject("GET", "/v1/agents", otherAdmin)).json().agents.map((a: { id: string }) => a.id)).not.toContain(agentId);
    expect((await inject("POST", `/v1/agents/${agentId}/chat`, otherAdmin, { message: "hola" })).statusCode).toBe(404);
    expect((await inject("POST", "/v1/deploy", otherAdmin, deployBody())).statusCode).toBe(403);
    // RLS a nivel de BD: sin tenant fijado, el rol de la app no ve filas
    const { rows } = await db.app.query("SELECT count(*)::int AS n FROM conversations");
    expect(rows[0].n).toBe(0);
  });

  it("la key del widget solo sirve para su agente", async () => {
    const r = await inject("POST", `/v1/agents/${agentId}/chat`, widgetKey, { message: "hola" });
    expect(r.json().reply).toBe("eco: hola");
    expect((await inject("GET", "/v1/approvals", widgetKey)).statusCode).toBe(403);
  });

  it("el agente es un servidor MCP", async () => {
    const rpc = (body: object) => inject("POST", `/v1/agents/${agentId}/mcp`, agentKey, body);
    const init = (await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).json();
    expect(init.result.protocolVersion).toBe("2025-06-18");
    expect((await rpc({ jsonrpc: "2.0", method: "notifications/initialized" })).statusCode).toBe(202);
    const list = (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
    expect(list.result.tools[0].name).toBe("preguntar");
    const call = (await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "preguntar", arguments: { message: "hola mcp" } } })).json();
    expect(call.result.content[0].text).toBe("eco: hola mcp");
    expect(call.result.structuredContent.conversation_id).toBeTruthy();
  });

  it("sirve el widget, la consola y el catálogo con el formulario de parámetros", async () => {
    expect((await app.inject({ method: "GET", url: "/widget.js" })).body).toContain("agentes-chat");
    expect((await app.inject({ method: "GET", url: "/console" })).body).toContain("Consola de agentes");
    const t = (await app.inject({ method: "GET", url: "/v1/templates/atencion-cliente" })).json();
    expect(t.parameters.properties.empresa.type).toBe("string");
    expect(t.capabilities.find((c: { name: string }) => c.name === "pedidos.reembolsar").required).toBe(false);
  });
});
