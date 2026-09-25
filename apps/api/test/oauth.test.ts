/**
 * Conexiones OAuth por cliente contra Postgres real, un proveedor OAuth simulado y una agenda MCP que valida
 * los access tokens por introspección (como haría Google con su API).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { parse as parseYaml } from "yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { RuntimeGateway } from "../src/modules/conversations/runtime.js";
import { createDb, type Db } from "../src/shared/db.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL;
const PLATFORM = "platform-test-token";
const INTERNAL = "internal-test-token";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const runtime: RuntimeGateway = {
  mode: "direct",
  turn: async () => ({ state: { status: "idle" }, result: { status: "completed", reply: "ok", approvals_requested: [], handoff: null, tools_executed: [], events: [] } }),
  ingest: async () => ({ chunks: 0 }),
};

async function startMock(script: string, env: Record<string, string>, port: number): Promise<ChildProcess> {
  const child = spawn("node", [join(ROOT, script)], { env: { ...process.env, ...env, PORT: String(port) }, stdio: "ignore" });
  for (let i = 0; i < 50; i++) {
    if (await fetch(`http://localhost:${port}/_debug`).then(() => true, () => false)) break;
    await sleep(100);
  }
  return child;
}

const describeDb = ADMIN_URL ? describe : describe.skip;

describeDb("conexiones OAuth por cliente", () => {
  const dbName = `agentes_oauth_${Date.now()}`;
  const base = 19500 + Math.floor(Math.random() * 200);
  const oauthPort = base;
  const agendaPort = base + 300;
  let oauthMock: ChildProcess;
  let agendaMock: ChildProcess;
  let db: Db;
  let app: ReturnType<typeof buildApp>;

  const deployment = () => {
    const d = parseYaml(readFileSync(join(ROOT, "examples/clientes/clinica-sonrisas-google.yaml"), "utf8"));
    d.connectors[0].url = `http://localhost:${agendaPort}/mcp`;
    return d;
  };
  const deploy = () =>
    app.inject({ method: "POST", url: "/v1/deploy", headers: { authorization: `Bearer ${PLATFORM}` }, payload: { deployment: deployment(), knowledge: [] } });
  const stats = async () => (await (await fetch(`http://localhost:${oauthPort}/_debug`)).json()) as { refreshes: number; exchanges: number };
  let tenantId = "";
  const resolveToken = () =>
    app.inject({
      method: "POST",
      url: "/internal/credentials/resolve",
      headers: { "x-internal-token": INTERNAL },
      payload: { tenant_id: tenantId, ref: "vault://clinica-sonrisas-google/agenda-google" },
    });

  /** Simula al cliente abriendo el enlace y aceptando en el proveedor. */
  async function authorize(connectUrl: string) {
    const start = await app.inject({ method: "GET", url: new URL(connectUrl).pathname });
    expect(start.statusCode).toBe(302);
    const atProvider = await fetch(start.headers.location as string, { redirect: "manual" });
    expect(atProvider.status).toBe(302);
    const back = new URL(atProvider.headers.get("location")!);
    return app.inject({ method: "GET", url: back.pathname + back.search });
  }

  beforeAll(async () => {
    // TTL de 61 s con margen de renovación de 60 s: al segundo de emitirse, el token "está a punto de caducar".
    oauthMock = await startMock("examples/oauth-mock/server.mjs", { OAUTH_CLIENT_ID: "cid", OAUTH_CLIENT_SECRET: "csecret", ACCESS_TTL: "61" }, oauthPort);
    agendaMock = await startMock(
      "examples/agenda-mock/server.mjs",
      { AGENDA_TOKEN: "no-usar", OAUTH_INTROSPECT_URL: `http://localhost:${oauthPort}/introspect` },
      agendaPort,
    );
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
      vaultMasterKey: Buffer.alloc(32, 9),
      platformAdminToken: PLATFORM,
      internalToken: INTERNAL,
      publicBaseUrl: "http://api.test",
      oauthProviders: {
        mock: {
          id: "mock",
          name: "Proveedor simulado",
          authorize_url: `http://localhost:${oauthPort}/authorize`,
          token_url: `http://localhost:${oauthPort}/token`,
          default_scopes: ["calendar.events"],
          client_id: "cid",
          client_secret: "csecret",
        },
      },
    });
  });

  afterAll(async () => {
    oauthMock?.kill();
    agendaMock?.kill();
    await app?.close();
    await db?.close();
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  let connectUrl = "";

  it("desplegar sin conectar devuelve el enlace para el cliente", async () => {
    const r = await deploy();
    expect(r.statusCode, r.body).toBe(409);
    const pending = r.json().details.pending_connections;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ credential: "agenda-google", provider: "mock" });
    connectUrl = pending[0].connect_url;
    expect(connectUrl).toMatch(/^http:\/\/api\.test\/v1\/oauth\/start\/[\w-]{40,}$/);
  });

  it("el cliente autoriza -> tokens cifrados en la bóveda", async () => {
    const r = await authorize(connectUrl);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.body).toContain("Cuenta conectada");
    const { rows } = await db.admin.query("SELECT tenant_id, kind, provider, scopes, expires_at, ciphertext FROM credentials WHERE name = 'agenda-google'");
    expect(rows[0]).toMatchObject({ kind: "oauth", provider: "mock", scopes: ["calendar.events"] });
    expect(rows[0].ciphertext.toString()).not.toContain("refresh_token");
    tenantId = rows[0].tenant_id;
    // Scopes pedidos: los del conector en el YAML (calendar.events).
  });

  it("un enlace de conexión no se puede reutilizar", async () => {
    const again = await app.inject({ method: "GET", url: new URL(connectUrl).pathname });
    expect(again.statusCode).toBe(409);
  });

  it("volver a desplegar publica; las tools MCP se descubren con el token OAuth", async () => {
    const r = await deploy();
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().tools.map((t: { name: string }) => t.name)).toContain("calendario__crear_cita");
    expect(r.json().keys.admin).toBeTruthy(); // la key admin se emite al PUBLICAR, aunque el tenant se creara antes
  });

  it("token a punto de caducar: se renueva UNA vez aunque lleguen varios turnos a la vez", async () => {
    await sleep(1200);
    const before = (await stats()).refreshes;
    const results = await Promise.all(Array.from({ length: 5 }, () => resolveToken()));
    const tokens = new Set(results.map((r) => r.json().secret));
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    expect(tokens.size).toBe(1);
    expect((await stats()).refreshes).toBe(before + 1);
    // y el token renovado es válido en la API del proveedor
    const introspect = await fetch(`http://localhost:${oauthPort}/introspect`, { method: "POST", body: new URLSearchParams({ token: [...tokens][0]! }) });
    expect((await introspect.json()).active).toBe(true);
  });

  it("si el cliente retira el permiso: error claro, marcado para reconectar y nuevo enlace al redesplegar", async () => {
    await fetch(`http://localhost:${oauthPort}/_revoke`, { method: "POST" });
    await sleep(1200);
    const r = await resolveToken();
    expect(r.statusCode).toBe(424);
    expect(r.json().error).toMatch(/debe volver a autorizar/);

    const admin = await db.admin.query("SELECT needs_reconnect FROM credentials WHERE name = 'agenda-google'");
    expect(admin.rows[0].needs_reconnect).toBe(true);
    const audit = await db.admin.query("SELECT action FROM audit_log WHERE action LIKE 'connection.%' ORDER BY id");
    expect(audit.rows.map((x) => x.action)).toEqual(["connection.authorized", "connection.refreshed", "connection.revoked"]);

    const redeploy = await deploy();
    expect(redeploy.statusCode).toBe(409);
    const link = redeploy.json().details.pending_connections[0].connect_url;
    expect((await authorize(link)).statusCode).toBe(200);
    expect((await resolveToken()).statusCode).toBe(200);
  });

  it("los proveedores no configurados se rechazan con un mensaje útil", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/v1/oauth/connect?tenant_id=${tenantId}`,
      headers: { authorization: `Bearer ${PLATFORM}` },
      payload: { credential: "crm", provider: "salesforce" },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/proveedor OAuth desconocido/);
  });
});
