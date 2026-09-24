import type { JsonSchema } from "./types.js";

/**
 * Capacidades que implementa la propia plataforma (conector "builtin").
 * Cualquier plantilla puede pedirlas sin que el cliente conecte nada.
 */
export const BUILTIN_CAPABILITIES: Record<string, { description: string; input_schema: JsonSchema }> = {
  "conocimiento.buscar": {
    description:
      "Busca en la base de conocimiento de la empresa (documentos, FAQ, políticas). Úsala antes de responder preguntas sobre la empresa.",
    input_schema: {
      type: "object",
      properties: {
        consulta: { type: "string", description: "Qué buscar, en lenguaje natural" },
        max_resultados: { type: "integer", minimum: 1, maximum: 10, default: 4 },
      },
      required: ["consulta"],
      additionalProperties: false,
    },
  },
  "humano.escalar": {
    description:
      "Transfiere la conversación a una persona del equipo. La conversación queda en pausa hasta que un humano responda.",
    input_schema: {
      type: "object",
      properties: {
        motivo: { type: "string", description: "Por qué se escala" },
        resumen: { type: "string", description: "Resumen breve de la conversación para el humano" },
        prioridad: { type: "string", enum: ["baja", "normal", "alta"] },
      },
      required: ["motivo", "resumen"],
      additionalProperties: false,
    },
  },
};

export function isBuiltin(capability: string): boolean {
  return capability in BUILTIN_CAPABILITIES;
}
