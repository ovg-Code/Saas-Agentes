import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { AgentTemplate } from "./types.js";
import { SpecError, validateDeployment, validateTemplate } from "./validate.js";

export interface EvalCase {
  id: string;
  description?: string;
  turns: {
    user: string;
    expect?: {
      contains?: string[];
      not_contains?: string[];
      tools_called?: string[];
      tools_not_called?: string[];
      status?: "completed" | "awaiting_approval" | "handoff";
    };
  }[];
}

export interface LoadedTemplate {
  template: AgentTemplate;
  evals: EvalCase[];
  dir: string;
}

export function readYaml(path: string): unknown {
  return parseYaml(readFileSync(path, "utf8"));
}

/** Carga una plantilla desde disco: template.yaml + procedimientos .md + evals. */
export function loadTemplateDir(dir: string): LoadedTemplate {
  const root = resolve(dir);
  const template = validateTemplate(readYaml(join(root, "template.yaml")));
  const missing: { path: string; message: string }[] = [];
  template.procedures = (template.procedures ?? []).map((p, i) => {
    if (p.content !== undefined || !p.file) return p;
    const file = join(root, p.file);
    if (!existsSync(file)) {
      missing.push({ path: `/procedures/${i}/file`, message: `no existe ${p.file}` });
      return p;
    }
    return { ...p, content: readFileSync(file, "utf8").trim() };
  });
  if (missing.length) throw new SpecError("plantilla", missing);

  let evals: EvalCase[] = [];
  if (template.evals) {
    const file = join(root, template.evals);
    if (!existsSync(file)) throw new SpecError("plantilla", [{ path: "/evals", message: `no existe ${template.evals}` }]);
    evals = ((readYaml(file) as { cases?: EvalCase[] }).cases ?? []) as EvalCase[];
  }
  return { template, evals, dir: root };
}

/** Carga el catálogo de plantillas: cada subdirectorio con un template.yaml. */
export function loadTemplateCatalog(templatesDir: string): LoadedTemplate[] {
  return readdirSync(templatesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(templatesDir, d.name, "template.yaml")))
    .map((d) => loadTemplateDir(join(templatesDir, d.name)));
}

export function loadDeploymentFile(path: string) {
  return validateDeployment(readYaml(path));
}
