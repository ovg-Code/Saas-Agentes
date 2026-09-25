import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type ConnectorCatalog,
  type Deployment,
  effectiveApproval,
  importOpenApi,
  loadDeploymentFile,
  loadTemplateCatalog,
  loadTemplateDir,
  readYaml,
  render,
  RenderError,
  resolveRelease,
  SpecError,
  validateRelease,
} from "../src/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const TEMPLATE_DIR = join(ROOT, "templates/atencion-cliente");
const EXAMPLE = join(ROOT, "examples/clientes/ferreteria-lopez.yaml");
const CRM_OPENAPI = join(ROOT, "examples/crm-mock/openapi.yaml");

const { template } = loadTemplateDir(TEMPLATE_DIR);
const crm = importOpenApi(readYaml(CRM_OPENAPI) as Record<string, unknown>);
const catalogs: Record<string, ConnectorCatalog> = {
  "crm-lopez": { id: "crm-lopez", type: "openapi", base_url: crm.base_url, operations: crm.operations },
};
const credentialRefs = {
  "crm-lopez-key": "vault://ferreteria-lopez/crm-lopez-key",
  "wa-token": "vault://ferreteria-lopez/wa-token",
  "wa-app-secret": "vault://ferreteria-lopez/wa-app-secret",
  "wa-verify": "vault://ferreteria-lopez/wa-verify",
};

function baseDeployment(): Deployment {
  return loadDeploymentFile(EXAMPLE);
}

function issuesOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (e) {
    if (e instanceof SpecError) return e.issues.map((i) => `${i.path}: ${i.message}`);
    throw e;
  }
  return [];
}

describe("plantillas del catálogo", () => {
  it("todas las plantillas del repo son válidas y sus procedimientos existen", () => {
    const all = loadTemplateCatalog(join(ROOT, "templates"));
    expect(all.length).toBeGreaterThan(0);
    for (const t of all) {
      for (const p of t.template.procedures ?? []) expect(p.content, `${t.template.id}/${p.id}`).toBeTruthy();
      expect(t.evals.length, `${t.template.id} sin evals`).toBeGreaterThan(0);
    }
  });
});

describe("importador OpenAPI", () => {
  it("aplana parámetros y body, y resuelve $ref", () => {
    const ticket = crm.operations.find((o) => o.operationId === "crearTicket")!;
    expect(ticket.method).toBe("POST");
    expect(ticket.has_body).toBe(true);
    expect(ticket.input_schema.properties.body.properties.asunto.type).toBe("string");
    expect(ticket.input_schema.properties.body.properties.numero_pedido.type).toEqual(["string", "null"]);
    const pedido = crm.operations.find((o) => o.operationId === "obtenerPedido")!;
    expect(pedido.params).toEqual([{ name: "numero", in: "path", required: true }]);
    expect(pedido.input_schema.required).toEqual(["numero"]);
  });
});

describe("resolución de un despliegue", () => {
  it("genera un release válido, con defaults, render y tools enlazadas", () => {
    const release = resolveRelease({ template, deployment: baseDeployment(), catalogs, credentialRefs });
    expect(() => validateRelease(release)).not.toThrow();
    expect(release.id).toMatch(/^rel_[0-9a-f]{16}$/);
    expect(release.instructions).toContain("Ferretería López");
    expect(release.instructions).toContain("reclamaciones formales, reembolsos"); // default de array renderizado
    expect(release.instructions).not.toContain("{{");
    expect(release.params.tono).toBe("cercano");

    const names = release.tools.map((t) => t.name);
    expect(names).toEqual([
      "conocimiento__buscar",
      "crm__buscar_cliente",
      "humano__escalar",
      "pedidos__consultar",
      "pedidos__reembolsar",
      "tickets__crear",
    ]);
    const byName = Object.fromEntries(release.tools.map((t) => [t.name, t]));
    expect(byName.pedidos__consultar!.binding).toMatchObject({ kind: "http", method: "GET", path: "/pedidos/{numero}" });
    expect(byName.tickets__crear!.approval).toBe("auto"); // write en L3
    expect(byName.pedidos__reembolsar!.approval).toBe("ask"); // financial + always + locked
    expect(release.connectors["crm-lopez"]!.auth.credential_ref).toBe("vault://ferreteria-lopez/crm-lopez-key");
    // El release nunca contiene secretos, solo referencias.
    expect(JSON.stringify(release)).not.toContain("crm-demo-key");
  });

  it("es determinista: mismo input -> mismo id; cambio de parámetro -> id distinto", () => {
    const a = resolveRelease({ template, deployment: baseDeployment(), catalogs, credentialRefs });
    const b = resolveRelease({ template, deployment: baseDeployment(), catalogs, credentialRefs });
    expect(a.id).toBe(b.id);
    const d = baseDeployment();
    d.params!.tono = "formal";
    expect(resolveRelease({ template, deployment: d, catalogs, credentialRefs }).id).not.toBe(a.id);
  });

  it("acumula todos los problemas en un solo error", () => {
    const d = baseDeployment();
    delete d.params!.empresa;
    d.autonomy = "L5";
    d.bindings!["pedidos.consultar"] = { connector: "crm-lopez", operation: "GET /no-existe" };
    d.bindings!["inventario.ajustar"] = { connector: "crm-lopez", operation: "crearTicket" };
    d.knowledge = [];
    const issues = issuesOf(() => resolveRelease({ template, deployment: d, catalogs, credentialRefs }));
    expect(issues.join("\n")).toMatch(/empresa/);
    expect(issues.join("\n")).toMatch(/como máximo L4/);
    expect(issues.join("\n")).toMatch(/no existe en 'crm-lopez'/);
    expect(issues.join("\n")).toMatch(/inventario.ajustar: la plantilla no declara/);
    expect(issues.join("\n")).toMatch(/necesita conocimiento/);
  });

  it("el cliente no puede relajar una capacidad bloqueada, pero sí endurecer otras", () => {
    const d = baseDeployment();
    d.overrides = { capabilities: { "pedidos.reembolsar": { approval: "never" }, "tickets.crear": { approval: "always" } } };
    expect(issuesOf(() => resolveRelease({ template, deployment: d, catalogs, credentialRefs })).join()).toMatch(/no se puede relajar/);
    d.overrides = { capabilities: { "tickets.crear": { approval: "always" } } };
    const r = resolveRelease({ template, deployment: d, catalogs, credentialRefs });
    expect(r.tools.find((t) => t.name === "tickets__crear")!.approval).toBe("ask");
  });

  it("exige credenciales en la bóveda y versión compatible", () => {
    const d = baseDeployment();
    d.template = "atencion-cliente@^2.0";
    const issues = issuesOf(() => resolveRelease({ template, deployment: d, catalogs, credentialRefs: {} }));
    expect(issues.join("\n")).toMatch(/no cumple el rango/);
    expect(issues.join("\n")).toMatch(/credencial 'crm-lopez-key' no disponible/);
  });

  it("las capacidades opcionales sin binding simplemente no aparecen", () => {
    const d = baseDeployment();
    d.bindings = {};
    d.connectors = [];
    d.credentials = {};
    const r = resolveRelease({ template, deployment: d, catalogs: {}, credentialRefs: { "wa-token": "vault://x/a", "wa-app-secret": "vault://x/b", "wa-verify": "vault://x/c" } });
    expect(r.tools.map((t) => t.name)).toEqual(["conocimiento__buscar", "humano__escalar"]);
    expect(r.connectors).toEqual({});
  });

  it("escribe el fixture de contrato que usa el runtime Python", () => {
    const release = resolveRelease({ template, deployment: baseDeployment(), catalogs, credentialRefs });
    const out = join(ROOT, "packages/agent-spec/fixtures/release.ferreteria-lopez.json");
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(release, null, 2)}\n`);
  });
});

describe("política de autonomía", () => {
  it("matriz nivel x tier", () => {
    const row = (lvl: "L1" | "L2" | "L3" | "L4" | "L5") =>
      (["read", "write", "irreversible", "financial"] as const).map((t) => effectiveApproval(t, "policy", lvl));
    expect(row("L1")).toEqual(["ask", "ask", "ask", "ask"]);
    expect(row("L2")).toEqual(["auto", "ask", "ask", "ask"]);
    expect(row("L3")).toEqual(["auto", "auto", "ask", "ask"]);
    expect(row("L4")).toEqual(["auto", "auto", "auto", "ask"]);
    expect(row("L5")).toEqual(["auto", "auto", "auto", "auto"]);
  });
  it("'never' no puede saltarse la aprobación de algo financiero; 'always' manda siempre", () => {
    expect(effectiveApproval("financial", "never", "L3")).toBe("ask");
    expect(effectiveApproval("write", "never", "L1")).toBe("auto");
    expect(effectiveApproval("read", "always", "L5")).toBe("ask");
  });
});

describe("render", () => {
  it("rellena rutas con puntos y falla si falta una variable", () => {
    expect(render("Hola {{ a.b }} y {{c}}", { a: { b: "x" }, c: [1, 2] })).toBe("Hola x y 1, 2");
    expect(() => render("{{nope}}", {})).toThrow(RenderError);
  });
});

describe("canal WhatsApp", () => {
  const withWhatsApp = baseDeployment; // el ejemplo de la ferretería ya activa WhatsApp

  it("activar whatsapp exige su configuración", () => {
    const d = { ...baseDeployment(), channel_settings: {} };
    expect(issuesOf(() => resolveRelease({ template, deployment: d, catalogs, credentialRefs })).join()).toMatch(
      /channel_settings\/whatsapp: el canal whatsapp necesita/,
    );
  });

  it("el release lleva referencias a la bóveda, nunca secretos", () => {
    const r = resolveRelease({ template, deployment: withWhatsApp(), catalogs, credentialRefs });
    validateRelease(r);
    expect(r.channel_settings?.whatsapp).toEqual({
      phone_number_id: "555000111",
      access_token_ref: "vault://ferreteria-lopez/wa-token",
      app_secret_ref: "vault://ferreteria-lopez/wa-app-secret",
      verify_token_ref: "vault://ferreteria-lopez/wa-verify",
      reengagement_template: { name: "seguimiento_pedido", language: "es" },
    });
  });

  it("credenciales de whatsapp ausentes en la bóveda son un error", () => {
    const { "wa-token": _omit, ...sinToken } = credentialRefs;
    expect(issuesOf(() => resolveRelease({ template, deployment: withWhatsApp(), catalogs, credentialRefs: sinToken })).join()).toMatch(
      /credentials\/access_token: credencial 'wa-token' no disponible/,
    );
  });
});
