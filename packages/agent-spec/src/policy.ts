import type { ApprovalSetting, AutonomyLevel, EffectiveApproval, Tier } from "./types.js";

export const AUTONOMY_LEVELS: readonly AutonomyLevel[] = ["L1", "L2", "L3", "L4", "L5"];
export const TIERS: readonly Tier[] = ["read", "write", "irreversible", "financial"];

/**
 * Niveles de autonomía (Feng, McDonald & Zhang, arXiv 2506.12469), definidos por el rol del humano:
 *  L1 Operador    — el agente propone, el humano confirma TODA acción.
 *  L2 Colaborador — lecturas automáticas; cualquier escritura se confirma.
 *  L3 Consultor   — lecturas y escrituras reversibles automáticas; lo irreversible/financiero se confirma.
 *  L4 Aprobador   — solo lo financiero se confirma.
 *  L5 Observador  — todo automático salvo capacidades con approval: always.
 *
 * Esta tabla dice, por nivel, cuál es el tier más alto que se ejecuta SIN aprobación.
 */
const AUTO_UP_TO: Record<AutonomyLevel, Tier | null> = {
  L1: null,
  L2: "read",
  L3: "write",
  L4: "irreversible",
  L5: "financial",
};

export function autonomyRank(level: AutonomyLevel): number {
  return AUTONOMY_LEVELS.indexOf(level);
}

export function tierRank(tier: Tier): number {
  return TIERS.indexOf(tier);
}

/** Decisión efectiva para una capacidad: se calcula al publicar y se congela en el release. */
export function effectiveApproval(tier: Tier, setting: ApprovalSetting, autonomy: AutonomyLevel): EffectiveApproval {
  if (setting === "always") return "ask";
  // "never" nunca puede saltarse la aprobación de algo irreversible o financiero.
  if (setting === "never" && tierRank(tier) <= tierRank("write")) return "auto";
  const limit = AUTO_UP_TO[autonomy];
  if (limit === null) return "ask";
  return tierRank(tier) <= tierRank(limit) ? "auto" : "ask";
}

const STRICTNESS: Record<ApprovalSetting, number> = { never: 0, policy: 1, always: 2 };

/**
 * Aplica el override del cliente respetando los límites de la plantilla:
 * si la capacidad está `locked`, el cliente solo puede endurecerla, nunca relajarla.
 */
export function mergeApproval(
  templateSetting: ApprovalSetting,
  locked: boolean,
  override: ApprovalSetting | undefined,
): { value: ApprovalSetting; rejected?: string } {
  if (override === undefined) return { value: templateSetting };
  if (locked && STRICTNESS[override] < STRICTNESS[templateSetting]) {
    return {
      value: templateSetting,
      rejected: `no se puede relajar la aprobación de '${templateSetting}' a '${override}' (capacidad bloqueada por la plantilla)`,
    };
  }
  return { value: override };
}
