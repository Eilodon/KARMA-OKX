/**
 * `TermsCompiler` — the deterministic kernel, per `KARMA_OKX_MASTER_IMPLEMENTATION_PLAN.md`
 * Section XVII: three layers intersected, never a single `if reputation > 80` formula.
 *
 *   Layer A — Principal Envelope   (hard ceiling; what the principal allows at most)
 *   Layer B — Earned Trust Envelope (evidence tier; how far that ceiling gets used)
 *   Layer C — Task Risk Restrictions (task semantics; tightens further, never loosens)
 *
 * `compilePolicy` is a pure function: same inputs + same `compilerVersion` always produce the
 * same `KarmaPolicyIR` and the same `policyHash` (Section III, "Compiler Determinism"). No RPC,
 * no AI call, no chain read happens in this file — callers assemble `TrustEvidenceBundle` and
 * `TaskRiskIR` first (evidence/risk layers), then this just does arithmetic.
 *
 * Every step below can only shrink `maxPerTransaction`/`maxCumulativeExposure` (multiplier is
 * always <= 10_000 bps) and can only raise `providerBondBps`/tighten `evaluation.mode` — never
 * the reverse. That's what makes Properties 2/3/5 (principal cap never exceeded; risk-up never
 * loosens; adjudicated fault never improves terms) true by construction rather than by a
 * separately-maintained invariant check.
 */

import { canonicalHash } from "../../canonical_hash.js";
import type { TrustEvidenceBundle } from "../evidence/types.js";
import type { TaskRiskIR } from "../risk/types.js";
import { scaleByBps, type PolicyProfile } from "./profiles.js";
import { computePolicyHash } from "./hash.js";
import type { KarmaPolicyIR, PolicyEvaluationMode, PrincipalEnvelope, SettlementMode } from "./ir.js";

export const COMPILER_VERSION = "0.1.0-ai-season";
export const SCHEMA_VERSION = "karma-policy-ir-v1";

export interface RuleTraceEntry {
  ruleId: string;
  description: string;
  before: string;
  after: string;
}

export interface CompileInput {
  evidence: TrustEvidenceBundle;
  risk: TaskRiskIR;
  principalEnvelope: PrincipalEnvelope;
  profile: PolicyProfile;
  actionDigest: string;
  actionClass: string;
  nonce: bigint;
  issuedAt?: number;
}

export interface CompileResult {
  policy: KarmaPolicyIR;
  ruleTrace: RuleTraceEntry[];
}

const EVAL_STRICTNESS: Record<PolicyEvaluationMode, number> = { NONE: 0, SINGLE: 1, PANEL: 2 };

/** The stricter of two evaluation modes — used so Layer C can only tighten Layer B's mode, never
 *  accidentally loosen it (e.g. a STRONG-tier subject already at "NONE" must not get downgraded
 *  back to "SINGLE" by a rule meant to *raise* the floor for weaker tiers). */
function stricterOf(a: PolicyEvaluationMode, b: PolicyEvaluationMode): PolicyEvaluationMode {
  return EVAL_STRICTNESS[a] >= EVAL_STRICTNESS[b] ? a : b;
}

export function compilePolicy(input: CompileInput): CompileResult {
  const trace: RuleTraceEntry[] = [];
  const issuedAt = input.issuedAt ?? Date.now();

  // ── Layer A: Principal Envelope — hard ceiling ────────────────────────────────────────────
  let maxPerTx = input.principalEnvelope.maxPerTransaction;
  let maxCumulative = input.principalEnvelope.maxCumulativeExposure;
  trace.push({
    ruleId: "RULE_001",
    description: "principal_cap",
    before: "unbounded",
    after: `${maxPerTx}/${maxCumulative}`,
  });

  const actionAuthorized = input.principalEnvelope.allowedActions.includes(input.actionClass);
  if (!actionAuthorized) {
    const before = `${maxPerTx}/${maxCumulative}`;
    maxPerTx = 0n;
    maxCumulative = 0n;
    trace.push({
      ruleId: "RULE_002",
      description: "action_not_authorized_by_principal",
      before,
      after: "0/0",
    });
  }

  // ── Layer B: Earned Trust Envelope ────────────────────────────────────────────────────────
  const tier = input.profile.tierFor(input.evidence);
  const beforeB = `${maxPerTx}/${maxCumulative}`;
  maxPerTx = scaleByBps(maxPerTx, tier.capMultiplierBps);
  maxCumulative = scaleByBps(maxCumulative, tier.capMultiplierBps);
  let bondBps = tier.bondFloorBps;
  let evaluationMode: PolicyEvaluationMode = tier.evaluatorMode;
  // Not part of KarmaPolicyIR in this build (delegation/Contract Graph is out of scope — see the
  // plan file's explicit scope-cuts); tracked only for the rule-trace narrative below.
  const delegationAllowed = tier.delegationAllowed && input.principalEnvelope.delegationAllowed;
  trace.push({
    ruleId: `RULE_1${tier.name === "THIN" ? "04" : tier.name === "ESTABLISHED" ? "10" : "20"}`,
    description: `evidence_tier_${tier.name.toLowerCase()}`,
    before: beforeB,
    after: `${maxPerTx}/${maxCumulative}, bond=${bondBps}bps, evaluator=${evaluationMode}`,
  });

  // ── Layer C: Task Risk Restrictions — tighten only, per the file-header invariant ────────
  if (input.risk.custodyRequired) {
    const before = `${maxPerTx}/${maxCumulative}`;
    maxPerTx = scaleByBps(maxPerTx, 5_000);
    maxCumulative = scaleByBps(maxCumulative, 5_000);
    bondBps = Math.max(bondBps, 5_000);
    evaluationMode = stricterOf(evaluationMode, "SINGLE");
    trace.push({
      ruleId: "RULE_211",
      description: "custody_required",
      before,
      after: `${maxPerTx}/${maxCumulative}, bond>=${bondBps}bps`,
    });
  }

  if (input.risk.reversible !== "FULL") {
    const before = evaluationMode;
    evaluationMode = stricterOf(evaluationMode, "SINGLE");
    trace.push({
      ruleId: "RULE_240",
      description: `irreversible_action_${input.risk.reversible.toLowerCase()}`,
      before: `evaluator_${before.toLowerCase()}`,
      after: `evaluator_${evaluationMode.toLowerCase()}`,
    });
  }

  if (input.risk.externalSideEffects === "HIGH" || input.risk.externalTransfer) {
    const beforeEval = evaluationMode;
    evaluationMode = stricterOf(evaluationMode, "PANEL");
    trace.push({
      ruleId: "RULE_301",
      description: "high_external_side_effects_or_transfer",
      before: `delegation=${delegationAllowed}, evaluator=${beforeEval.toLowerCase()}`,
      after: `delegation=false, evaluator=${evaluationMode.toLowerCase()}`,
    });
  }

  if (input.risk.classificationConfidence === 0 && input.risk.source === "llm_fallback") {
    const before = `${maxPerTx}/${maxCumulative}`;
    maxPerTx = scaleByBps(maxPerTx, 2_500);
    maxCumulative = scaleByBps(maxCumulative, 2_500);
    trace.push({
      ruleId: "RULE_310",
      description: "unclassified_risk_conservative_fallback",
      before,
      after: `${maxPerTx}/${maxCumulative}`,
    });
  }

  const settlement: { mode: SettlementMode; providerBondBps: number } = {
    mode: bondBps > 0 ? "ESCROW" : "DIRECT",
    providerBondBps: bondBps,
  };

  const validity = {
    issuedAt,
    validFrom: Math.max(issuedAt, input.principalEnvelope.validFrom),
    expiresAt: Math.min(
      issuedAt + input.risk.expectedDurationSecs * 1000,
      input.principalEnvelope.validUntil,
    ),
  };

  const evidenceRoot = input.evidence.snapshot.evidenceRoot;
  // Reuse the same canonical hasher `computePolicyHash` wraps, directly — `TaskRiskIR` isn't a
  // `KarmaPolicyIR`, so `computePolicyHash`'s narrower type doesn't apply here.
  const taskRiskHash = "0x" + canonicalHash(input.risk);

  const policyWithoutHash: Omit<KarmaPolicyIR, "policyHash"> = {
    schemaVersion: SCHEMA_VERSION,
    principal: input.principalEnvelope.principal,
    subject: input.principalEnvelope.subject,
    actionDigest: input.actionDigest,
    actionClass: input.actionClass,
    authority: {
      allowedActions: actionAuthorized ? [input.actionClass] : [],
      maxPerTransaction: maxPerTx,
      maxCumulativeExposure: maxCumulative,
    },
    settlement,
    evaluation: { mode: evaluationMode },
    validity,
    evidenceRoot,
    taskRiskHash,
    policyProfile: input.profile.name,
    policyVersion: input.profile.version,
    compilerVersion: COMPILER_VERSION,
    nonce: input.nonce,
  };

  const policyHash = computePolicyHash(policyWithoutHash);

  return {
    policy: { ...policyWithoutHash, policyHash },
    ruleTrace: trace,
  };
}
