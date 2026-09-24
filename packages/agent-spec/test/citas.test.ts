import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type ConnectorCatalog, importOpenApi, loadDeploymentFile, loadTemplateDir, readYaml, resolveRelease, SpecError, validateRelease } from "../src/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const { template } = loadTemplateDir(join(ROOT, "templates/agendar-citas"));
const deployment = () => loadDeploymentFile(join(ROOT, "examples/clientes/clinica-sonrisas.yaml"));

// Lo que devolvería tools/list del servidor MCP de examples/agenda-mock (el API lo descubre al desplegar).
const agendaTools: ConnectorCatalog["mcp_tools"] = [
  { name: "consultar_disponibilidad", description: "Devuelve los huecos libres de un día.", input_schema: { type: "object", properties: { fecha: { type: "string" } }, required: ["fecha"] } },
  { name: "crear_cita", description: "Reserva una cita.", input_schema: { type: "object", properties: { fecha: { type: "string" }, hora: { type: "string" }, servicio: { type: "string" }, nombre_cliente: { type: "string" }, telefono: { type: "string" } }, required: ["fecha", "hora", "servicio", "nombre_cliente"] } },
  { name: "buscar_citas", description: "Busca citas.", input_schema: { type: "object", properties: { telefono: { type: "string" }, nombre: { type: "string" } } } },
  { name: "cancelar_cita", description: "Cancela una cita.", input_schema: { type: "object", properties: { id_cita: { type: "string" } }, required: ["id_cita"] } },
];
const pagos = importOpenApi(readYaml(join(ROOT, "examples/agenda-mock/openapi.yaml")) as Record<string, unknown>);
const catalogs: Record<string, ConnectorCatalog> = {
  agenda: { id: "agenda", type: "mcp", url: "http://localhost:9091/mcp", operations: [], mcp_tools: agendaTools },
  pagos: { id: "pagos", type: "openapi", base_url: pagos.base_url, operations: pagos.operations },
};
const credentialRefs = { "agenda-token": "vault://clinica-sonrisas/agenda-token" };

describe("plantilla agendar-citas + conectores MCP y OpenAPI en el mismo agente", () => {
  it("resuelve un release válido con tools MCP y HTTP", () => {
    const r = resolveRelease({ template, deployment: deployment(), catalogs, credentialRefs });
    validateRelease(r);
    const byName = Object.fromEntries(r.tools.map((t) => [t.name, t]));
    expect(byName.calendario__crear_cita!.binding).toEqual({ kind: "mcp", connector: "agenda", tool: "crear_cita" });
    expect(byName.calendario__crear_cita!.input_schema.required).toContain("nombre_cliente");
    expect(byName.pagos__cobrar_senal!.binding).toMatchObject({ kind: "http", method: "POST", path: "/pagos/senal" });
    expect(byName.pagos__cobrar_senal!.approval).toBe("ask");
    expect(r.connectors.agenda).toEqual({ type: "mcp", url: "http://localhost:9091/mcp", auth: { type: "bearer", credential_ref: "vault://clinica-sonrisas/agenda-token" } });
    expect(r.instructions).toContain("revisión, limpieza, blanqueamiento, urgencia");
    expect(r.instructions).toContain("Europe/Madrid");

    const out = join(ROOT, "packages/agent-spec/fixtures/release.clinica-sonrisas.json");
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(r, null, 2)}\n`);
  });

  it("una tool MCP que el servidor no ofrece es un error claro", () => {
    const d = deployment();
    d.bindings!["calendario.crear_cita"] = { connector: "agenda", operation: "reservar" };
    try {
      resolveRelease({ template, deployment: d, catalogs, credentialRefs });
      expect.unreachable();
    } catch (e) {
      expect((e as SpecError).issues).toContainEqual({ path: "/bindings/calendario.crear_cita", message: "tool MCP 'reservar' no existe en 'agenda'" });
    }
  });

  it("las capacidades de calendario obligatorias no pueden faltar", () => {
    const d = deployment();
    delete d.bindings!["calendario.disponibilidad"];
    expect(() => resolveRelease({ template, deployment: d, catalogs, credentialRefs })).toThrow(/calendario.disponibilidad: capacidad obligatoria sin conector/);
  });
});
