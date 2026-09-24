import { type LoadedTemplate, loadTemplateCatalog } from "@agentes/agent-spec";
import semver from "semver";
import { badRequest, notFound } from "../../shared/errors.js";

/**
 * Catálogo de plantillas (capa 1). Hoy se carga del directorio templates/ del repo, versionado con git;
 * varias versiones de una misma plantilla pueden convivir (templates/<id>/ o templates/<id>@<ver>/).
 */
export class TemplateCatalog {
  private readonly items: LoadedTemplate[];

  constructor(dir: string) {
    this.items = loadTemplateCatalog(dir);
  }

  list() {
    return this.items.map(({ template: t }) => ({
      id: t.id,
      version: t.version,
      name: t.name,
      category: t.category,
      description: t.description,
      channels: t.channels,
      autonomy: t.autonomy,
    }));
  }

  /** La versión más alta que cumple el rango semver (p.ej. ^1.0). */
  resolve(id: string, range = "*"): LoadedTemplate {
    const candidates = this.items.filter((i) => i.template.id === id);
    if (candidates.length === 0) throw notFound(`plantilla '${id}' no existe`);
    const best = semver.maxSatisfying(
      candidates.map((c) => c.template.version),
      range,
    );
    if (!best) throw badRequest(`ninguna versión de '${id}' cumple '${range}'`);
    return candidates.find((c) => c.template.version === best)!;
  }

  /** Descripción completa para construir el formulario de onboarding (parameters = JSON Schema). */
  describe(id: string) {
    const { template: t, evals } = this.resolve(id);
    const caps = (m: Record<string, { description: string; tier: string; approval?: string }> | undefined, required: boolean) =>
      Object.entries(m ?? {}).map(([name, c]) => ({ name, required, ...c }));
    return {
      ...t,
      capabilities: [...caps(t.capabilities.required, true), ...caps(t.capabilities.optional, false)],
      eval_cases: evals.length,
    };
  }
}
