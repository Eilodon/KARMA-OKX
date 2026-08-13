/**
 * `TaskRiskIR` — the structured shape a `TaskRiskClassifier` (see `./classifier.ts`) must reduce
 * an arbitrary natural-language obligation to, per `KARMA_OKX_MASTER_IMPLEMENTATION_PLAN.md`
 * Section XII.
 *
 * Split into two pieces on purpose:
 *  - `LlmTaskRiskFieldsSchema` — the ONLY thing the model is allowed to produce. Every field is
 *    an enum or boolean (Section XIV's prompt-injection defense: "enum only; no arbitrary policy
 *    values" — a free-string field here would let injected task text steer the classification
 *    with attacker-chosen text, the same weakness `llm_strategy.ts`'s free-string `skillId` has
 *    today, deliberately not repeated here).
 *  - `TaskRiskIR` — the full IR the compiler actually consumes, adding `amountAtRisk` and
 *    `expectedDurationSecs` supplied by the TRUSTED CALLER, never the model (Section XII:
 *    "AI không được tự bịa amount").
 */

import { z } from "zod/v4";

export const ASSET_CLASSES = ["RWA", "TOKEN", "SERVICE", "DATA", "OTHER"] as const;
export const REVERSIBILITY_LEVELS = ["FULL", "PARTIAL", "NONE"] as const;
export const SIDE_EFFECT_LEVELS = ["LOW", "MEDIUM", "HIGH"] as const;
export const DEPENDENCY_LEVELS = ["LOW", "MEDIUM", "HIGH"] as const;
export const DATA_SENSITIVITY_LEVELS = ["PUBLIC", "PRIVATE", "RESTRICTED"] as const;

export const LlmTaskRiskFieldsSchema = z.object({
  actionClass: z.enum(["BUY", "SELL", "TRANSFER", "REBALANCE", "SUBCONTRACT", "OTHER"]),
  assetClass: z.enum(ASSET_CLASSES),
  capitalMovement: z.boolean(),
  custodyRequired: z.boolean(),
  externalTransfer: z.boolean(),
  reversible: z.enum(REVERSIBILITY_LEVELS),
  delegationRequired: z.boolean(),
  externalSideEffects: z.enum(SIDE_EFFECT_LEVELS),
  counterpartyDependency: z.enum(DEPENDENCY_LEVELS),
  dataSensitivity: z.enum(DATA_SENSITIVITY_LEVELS),
  /** Free text IS allowed here, but only as an annotation the compiler never branches on —
   *  matches Section XIV's "task content, not instruction" framing: the model may echo back
   *  what it noticed, but nothing downstream trusts this string for a decision. */
  semanticFlags: z.array(z.string().max(64)).max(8),
  classificationConfidence: z.number().min(0).max(1),
});

export type LlmTaskRiskFields = z.infer<typeof LlmTaskRiskFieldsSchema>;

export type TaskRiskSource = "llm" | "llm_fallback";

export interface TaskRiskIR extends LlmTaskRiskFields {
  /** Caller-supplied, never model-supplied. */
  amountAtRisk: bigint;
  expectedDurationSecs: number;
  source: TaskRiskSource;
}

/** The conservative posture used whenever classification fails or is disqualified (timeout,
 *  malformed output, impossible-combination flag) — Section XV: "unknown → conservative risk",
 *  never "AI failed → bond=0". Every restriction-triggering field is pinned to its strictest
 *  value; `classificationConfidence: 0` makes the fallback visible in the rule trace/UI rather
 *  than silently masquerading as a real classification. */
export function conservativeFallbackRisk(input: {
  amountAtRisk: bigint;
  expectedDurationSecs: number;
  actionClass?: LlmTaskRiskFields["actionClass"];
  assetClass?: LlmTaskRiskFields["assetClass"];
}): TaskRiskIR {
  return {
    actionClass: input.actionClass ?? "OTHER",
    assetClass: input.assetClass ?? "OTHER",
    capitalMovement: true,
    custodyRequired: true,
    externalTransfer: true,
    reversible: "NONE",
    delegationRequired: false,
    externalSideEffects: "HIGH",
    counterpartyDependency: "HIGH",
    dataSensitivity: "RESTRICTED",
    semanticFlags: ["classification_fallback"],
    classificationConfidence: 0,
    amountAtRisk: input.amountAtRisk,
    expectedDurationSecs: input.expectedDurationSecs,
    source: "llm_fallback",
  };
}
