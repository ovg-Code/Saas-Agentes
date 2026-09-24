/**
 * Renderizado de `{{variable}}` en instrucciones y procedimientos.
 *
 * Deliberadamente mínimo (sin lógica, sin ejecución de código): las plantillas son datos,
 * y un motor con condicionales/bucles convertiría las plantillas en programas difíciles de auditar.
 *  - `{{empresa}}` / `{{ contacto.email }}` -> valor (rutas con puntos)
 *  - arrays -> "a, b, c"
 *  - variable inexistente -> error (mejor fallar al publicar que enviar "{{empresa}}" a un cliente)
 */
const VAR = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)\s*\}\}/g;

export class RenderError extends Error {
  constructor(public readonly missing: string[]) {
    super(`variables sin valor: ${missing.join(", ")}`);
  }
}

function lookup(params: Record<string, unknown>, path: string): unknown {
  let cur: unknown = params;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object" || !(key in (cur as object))) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function format(value: unknown): string {
  if (Array.isArray(value)) return value.map(format).join(", ");
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function render(text: string, params: Record<string, unknown>): string {
  const missing = new Set<string>();
  const out = text.replace(VAR, (_m, path: string) => {
    const value = lookup(params, path);
    if (value === undefined || value === null) {
      missing.add(path);
      return "";
    }
    return format(value);
  });
  if (missing.size > 0) throw new RenderError([...missing]);
  return out;
}

export function variablesIn(text: string): string[] {
  return [...new Set([...text.matchAll(VAR)].map((m) => m[1]!))];
}
