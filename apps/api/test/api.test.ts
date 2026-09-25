/**
 * Tests de integración del plano de control contra Postgres real (RLS incluida) y un runtime simulado.
 * Requiere TEST_DATABASE_ADMIN_URL (superusuario/propietario). Crea una BD temporal por ejecución.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
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
    secrets: { "crm-lopez-key": "crm-demo-key", "wa-token": "wa-tok", "wa-app-secret": "wa-secret", "wa-verify": "wa-verify-me" },
    knowledge: [{ source: "faq.md", title: "FAQ", text: "## Devoluciones\n30 días." }],
  });
  const inject = (method: "GET" | "POST", url: string, token: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload !== undefined ? { payload: payload as object } : {}) });

  // Simulador de la Graph API de WhatsApp en un proceso hijo
  const waPort = 19900 + Math.floor(Math.random() * 90);
  let waMock: ChildProcess;
  const waSent = async () =>
    ((await (await fetch(`http://localhost:${waPort}/_debug`)).json()) as { sent: { to: string; type: string; text?: { body: string }; template?: { name: string } }[] }).sent;

  beforeAll(async () => {
    waMock = spawn("node", [join(ROOT, "examples/whatsapp-mock/server.mjs")], {
      env: { ...process.env, PORT: String(waPort), WA_ACCESS_TOKEN: "wa-tok" },
      stdio: "ignore",
    });
    for (let i = 0; i < 50; i++) {
      if (await fetch(`http://localhost:${waPort}/_debug`).then(() => true, () => false)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const u = new URL(ADMIN_URL!);
    u.pathname = `/${dbName}`;
    const mig = new pg.Client({ connectionString: u.toString() });
    await mig.connect();
    for (const f of readdirSync(join(ROOT, "db/migrations")).filter((x) => x.endsWith(".sql")).sort()) {
      await mig.query(readFileSync(join(ROOT, "db/migrations", f), "utf8"));
    }
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
      whatsappApiBase: `http://localhost:${waPort}`,
    });
  });

  afterAll(async () => {
    waMock?.kill();
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

  it("despliega un cliente cuya agenda es un servidor MCP (descubre sus tools)", async () => {
    // Servidor MCP "antiguo" que exige initialize + sesión: el descubrimiento debe adaptarse.
    const port = 19000 + Math.floor(Math.random() * 900);
    const mock: ChildProcess = spawn("node", [join(ROOT, "examples/agenda-mock/server.mjs")], {
      env: { ...process.env, PORT: String(port), AGENDA_TOKEN: "tok", REQUIRE_SESSION: "1" },
      stdio: "ignore",
    });
    try {
      for (let i = 0; i < 50; i++) {
        if (await fetch(`http://localhost:${port}/_debug`).then(() => true, () => false)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const d = parseYaml(readFileSync(join(ROOT, "examples/clientes/clinica-sonrisas.yaml"), "utf8"));
      d.connectors[0].url = `http://localhost:${port}/mcp`;
      const body = {
        deployment: d,
        connector_specs: { pagos: readFileSync(join(ROOT, "examples/agenda-mock/openapi.yaml"), "utf8") },
        secrets: { "agenda-token": "tok" },
        knowledge: [],
      };
      const r = await inject("POST", "/v1/deploy", PLATFORM, body);
      expect(r.statusCode, r.body).toBe(201);
      const tools = r.json().tools.map((t: { name: string; binding: string }) => `${t.name} ${t.binding}`);
      expect(tools).toContain("calendario__crear_cita agenda: crear_cita");
      expect(tools).toContain("pagos__cobrar_senal pagos: POST /pagos/senal");
      const { rows } = await db.admin.query("SELECT catalog FROM connectors WHERE slug = 'agenda'");
      expect(rows[0].catalog.mcp_tools.map((t: { name: string }) => t.name)).toEqual([
        "consultar_disponibilidad", "crear_cita", "buscar_citas", "cancelar_cita",
      ]);

      // Redesplegar sin secreto reutiliza el de la bóveda para volver a descubrir.
      const again = await inject("POST", "/v1/deploy", PLATFORM, { ...body, secrets: {} });
      expect(again.statusCode, again.body).toBe(200);

      // Credencial incorrecta -> error claro, nada publicado.
      const bad = await inject("POST", "/v1/deploy", PLATFORM, { ...body, secrets: { "agenda-token": "mal" } });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error).toMatch(/no se pudieron listar las tools MCP.*credenciales/);
    } finally {
      mock.kill();
    }
  });

  describe("canal WhatsApp", () => {
    const url = () => `/v1/channels/whatsapp/${agentId}/webhook`;
    let n = 0;
    const inbound = (from: string, text: string, wamid = `wamid.test.${++n}`, secret = "wa-secret") => {
      const body = JSON.stringify({
        object: "whatsapp_business_account",
        entry: [{ changes: [{ field: "messages", value: {
          metadata: { phone_number_id: "555000111" },
          messages: [{ from, id: wamid, type: "text", text: { body: text } }],
        } }] }],
      });
      const sig = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
      return app.inject({ method: "POST", url: url(), payload: body, headers: { "content-type": "application/json", "x-hub-signature-256": sig } });
    };
    const settle = () => (app as unknown as { whatsapp: { idle(): Promise<void> } }).whatsapp.idle();

    it("verificación del webhook de Meta", async () => {
      const ok = await app.inject({ method: "GET", url: `${url()}?hub.mode=subscribe&hub.verify_token=wa-verify-me&hub.challenge=12345` });
      expect(ok.statusCode).toBe(200);
      expect(ok.body).toBe("12345");
      const bad = await app.inject({ method: "GET", url: `${url()}?hub.mode=subscribe&hub.verify_token=otro&hub.challenge=1` });
      expect(bad.statusCode).toBe(403);
    });

    it("firma inválida -> 401 y ningún turno", async () => {
      const before = runtime.calls.length;
      const r = await inbound("34611111111", "hola", undefined, "secreto-falso");
      expect(r.statusCode).toBe(401);
      await settle();
      expect(runtime.calls.length).toBe(before);
    });

    it("mensaje entrante -> turno -> respuesta enviada por WhatsApp; reintentos de Meta deduplicados", async () => {
      const before = runtime.calls.length;
      expect((await inbound("34611111111", "hola por whatsapp", "wamid.dup")).statusCode).toBe(200);
      expect((await inbound("34611111111", "hola por whatsapp", "wamid.dup")).statusCode).toBe(200); // reintento
      await settle();
      expect(runtime.calls.length).toBe(before + 1);
      const sent = await waSent();
      expect(sent.at(-1)).toMatchObject({ to: "34611111111", type: "text", text: { body: "eco: hola por whatsapp" } });

      // el segundo mensaje del mismo número continúa la MISMA conversación
      await inbound("34611111111", "sigo aquí");
      await settle();
      const { rows } = await db.admin.query("SELECT count(*)::int AS n FROM conversations WHERE channel = 'whatsapp' AND external_user = '34611111111'");
      expect(rows[0].n).toBe(1);
    });

    it("la aprobación resuelta más tarde también llega por WhatsApp", async () => {
      await inbound("34622222222", "quiero un reembolso del 1001");
      await settle();
      const pending = (await inject("GET", "/v1/approvals", adminKey)).json().approvals;
      const mine = pending.at(-1);
      await inject("POST", `/v1/approvals/${mine.id}`, adminKey, { approve: true, by: "ana" });
      const sent = (await waSent()).filter((m) => m.to === "34622222222").map((m) => m.text?.body);
      expect(sent).toEqual(["Una persona revisará el reembolso.", "Reembolso emitido."]);
    });

    it("una respuesta humana en el handoff sale por WhatsApp", async () => {
      const conv = (await db.admin.query("SELECT id FROM conversations WHERE external_user = '34611111111'")).rows[0].id;
      await inject("POST", `/v1/conversations/${conv}/human-reply`, adminKey, { text: "Hola, soy Ana del equipo", by: "ana" });
      expect((await waSent()).at(-1)).toMatchObject({ to: "34611111111", text: { body: "Hola, soy Ana del equipo" } });
    });

    it("fuera de la ventana de 24 h se usa la plantilla aprobada", async () => {
      const conv = (await db.admin.query("SELECT id FROM conversations WHERE external_user = '34611111111'")).rows[0].id;
      await db.admin.query("UPDATE conversations SET last_customer_at = now() - interval '25 hours' WHERE id = $1", [conv]);
      await inject("POST", `/v1/conversations/${conv}/human-reply`, adminKey, { text: "¿Sigues ahí?", by: "ana" });
      expect((await waSent()).at(-1)).toMatchObject({ to: "34611111111", type: "template", template: { name: "seguimiento_pedido" } });
      const audit = await db.admin.query("SELECT action FROM audit_log WHERE conversation_id = $1 ORDER BY id DESC LIMIT 1", [conv]);
      expect(audit.rows[0].action).toBe("channel.template_sent");
    });

    it("fuera de ventana y sin plantilla no se envía nada (y se sabe por qué)", async () => {
      const wa = (app as unknown as { whatsapp: { send(m: object): Promise<{ status: string }> } }).whatsapp;
      const { rows } = await db.admin.query("SELECT r.release FROM agents a JOIN releases r ON r.id = a.active_release_id WHERE a.id = $1", [agentId]);
      const release = structuredClone(rows[0].release);
      delete release.channel_settings.whatsapp.reengagement_template;
      const before = (await waSent()).length;
      const out = await wa.send({ tenantId, conversationId: "x", to: "34699999999", text: "hola", release, lastCustomerAt: new Date(Date.now() - 48 * 3600e3) });
      expect(out.status).toBe("outside_window");
      expect((await waSent()).length).toBe(before);
    });
  });

  it("sirve el widget, la consola y el catálogo con el formulario de parámetros", async () => {
    expect((await app.inject({ method: "GET", url: "/widget.js" })).body).toContain("agentes-chat");
    expect((await app.inject({ method: "GET", url: "/console" })).body).toContain("Consola de agentes");
    const t = (await app.inject({ method: "GET", url: "/v1/templates/atencion-cliente" })).json();
    expect(t.parameters.properties.empresa.type).toBe("string");
    expect(t.capabilities.find((c: { name: string }) => c.name === "pedidos.reembolsar").required).toBe(false);
  });
});
