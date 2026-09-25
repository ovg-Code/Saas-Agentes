import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type ConnectorCatalog, type Deployment, loadDeploymentFile, loadTemplateDir, resolveRelease, SpecError, validateRelease } from "../src/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const { template } = loadTemplateDir(join(ROOT, "templates/agendar-citas"));
const deployment = (): Deployment => loadDeploymentFile(join(ROOT, "examples/clientes/clinica-sonrisas-google.yaml"));
const tool = (name: string) => ({ name, input_schema: { type: "object", properties: {} } });
const catalogs: Record<string, ConnectorCatalog> = {
  agenda: {
    id: "agenda",
    type: "mcp",
    url: "http://localhost:9091/mcp",
    operations: [],
    mcp_tools: ["consultar_disponibilidad", "crear_cita", "buscar_citas", "cancelar_cita"].map(tool),
  },
};
const issues = (fn: () => unknown) => {
  try {
    fn();
    return [];
  } catch (e) {
    return (e as SpecError).issues.map((i) => i.message);
  }
};

describe("conectores OAuth (el cliente autoriza con su cuenta)", () => {
  it("una vez conectada, el release lleva auth oauth2 + referencia a la bóveda", () => {
    const r = resolveRelease({ template, deployment: deployment(), catalogs, credentialRefs: { "agenda-google": "vault://clinica-sonrisas/agenda-google" } });
    validateRelease(r);
    expect(r.connectors.agenda!.auth).toEqual({ type: "oauth2", credential_ref: "vault://clinica-sonrisas/agenda-google" });
  });

  it("sin conectar, explica que el cliente debe autorizar", () => {
    expect(issues(() => resolveRelease({ template, deployment: deployment(), catalogs, credentialRefs: {} })).join()).toMatch(
      /cuenta de 'agenda-google' aún no está conectada/,
    );
  });

  it("el proveedor de la credencial debe coincidir con el del conector", () => {
    const d = deployment();
    d.credentials!["agenda-google"] = { oauth: "microsoft" };
    expect(issues(() => resolveRelease({ template, deployment: d, catalogs, credentialRefs: { "agenda-google": "vault://x/y" } })).join()).toMatch(
      /debe declararse como \{ oauth: mock \}/,
    );
  });
});
