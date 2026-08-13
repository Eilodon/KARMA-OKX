/**
 * Rule-trace → human explanation, kept deliberately separate from `compiler.ts` (Section XIX:
 * "compiler.ts chỉ deterministic. explain.ts có thể produce ... LLM có thể rewrite explanation
 * đẹp hơn. Nhưng explanation không thay policy."). This module is pure string formatting over
 * the already-computed `RuleTraceEntry[]` — it cannot influence a `KarmaPolicyIR` in any way.
 */

import type { RuleTraceEntry } from "./compiler.js";

export function explainRuleTrace(trace: RuleTraceEntry[]): string {
  if (trace.length === 0) return "No rules applied.";
  return trace.map((r) => `- [${r.ruleId}] ${r.description}: ${r.before} -> ${r.after}`).join("\n");
}
