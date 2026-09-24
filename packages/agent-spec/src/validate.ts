import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import type { AgentTemplate, Deployment, Release } from "./types.js";

// ajv-formats publica CJS; según el bundler llega como default o como namespace.
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ??
  addFormatsModule) as unknown as (ajv: Ajv2020) => void;

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "schema");

function loadSchema(name: string): object {
  return JSON.parse(readFileSync(join(SCHEMA_DIR, name), "utf8"));
}

export const schemas = {
  template: loadSchema("template.schema.json"),
  deployment: loadSchema("deployment.schema.json"),
  release: loadSchema("release.schema.json"),
};

const ajv = new Ajv2020({ allErrors: true, strict: false, useDefaults: false });
addFormats(ajv);

const validators = {
  template: ajv.compile(schemas.template),
  deployment: ajv.compile(schemas.deployment),
  release: ajv.compile(schemas.release),
};

export interface Issue {
  path: string;
  message: string;
}

export class SpecError extends Error {
  constructor(
    public readonly kind: string,
    public readonly issues: Issue[],
  ) {
    super(`${kind} inválido:\n${issues.map((i) => `  - ${i.path || "/"}: ${i.message}`).join("\n")}`);
  }
}

function toIssues(errors: ErrorObject[] | null | undefined): Issue[] {
  return (errors ?? []).map((e) => ({
    path: e.instancePath,
    message: e.keyword === "additionalProperties" ? `propiedad no permitida '${e.params.additionalProperty}'` : (e.message ?? e.keyword),
  }));
}

function check<T>(kind: string, validate: ValidateFunction, data: unknown): T {
  if (!validate(data)) throw new SpecError(kind, toIssues(validate.errors));
  return data as T;
}

export const validateTemplate = (data: unknown) => check<AgentTemplate>("plantilla", validators.template, data);
export const validateDeployment = (data: unknown) => check<Deployment>("despliegue", validators.deployment, data);
export const validateRelease = (data: unknown) => check<Release>("release", validators.release, data);

/**
 * Valida los parámetros de un cliente contra el JSON Schema de parámetros de la plantilla
 * y devuelve una copia con los valores por defecto aplicados.
 */
export function validateParams(parametersSchema: object, params: unknown): { value: Record<string, unknown>; issues: Issue[] } {
  const withDefaults = new Ajv2020({ allErrors: true, strict: false, useDefaults: true });
  addFormats(withDefaults);
  const validate = withDefaults.compile(parametersSchema);
  const value = structuredClone((params ?? {}) as Record<string, unknown>);
  const ok = validate(value);
  return { value, issues: ok ? [] : toIssues(validate.errors).map((i) => ({ ...i, path: `/params${i.path}` })) };
}
