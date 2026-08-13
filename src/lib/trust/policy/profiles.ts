/**
 * Policy profiles — versioned, deterministic rule sets, per
 * `KARMA_OKX_MASTER_IMPLEMENTATION_PLAN.md` Section XVIII: "Đừng pretend KARMA biết một công
 * thức universal (score 83 -> collateral 17%)." `CONSERVATIVE_RWA_V1`'s tier numbers below are
 * lifted directly from the plan's own worked example — traceable, not invented for this build.
 *
 * All multipliers/floors are basis points (1/10000) so the compiler never touches floating point
 * on a bigint money amount — `scaleByBps` truncates, so a tier can only ever shrink an amount,
 * never grow it (multiplier is always <= 10_000).
 */

import type { TrustEvidenceBundle } from "../evidence/types.js";
import type { PolicyEvaluationMode } from "./ir.js";

export interface EvidenceTier {
  name: "THIN" | "ESTABLISHED" | "STRONG";
  /** Applied to the principal's caps. 10_000 = 100% (no reduction). */
  capMultiplierBps: number;
  bondFloorBps: number;
  evaluatorMode: PolicyEvaluationMode;
  delegationAllowed: boolean;
}

export interface PolicyProfile {
  name: string;
  version: string;
  tierFor(evidence: TrustEvidenceBundle): EvidenceTier;
}

export function scaleByBps(value: bigint, bps: number): bigint {
  if (bps < 0 || bps > 10_000) {
    throw new Error(`[policy] scaleByBps: bps must be in [0, 10000], got ${bps}`);
  }
  return (value * BigInt(Math.trunc(bps))) / 10_000n;
}

const THIN_TIER: EvidenceTier = {
  name: "THIN",
  capMultiplierBps: 1_000, // 10%
  bondFloorBps: 10_000, // 100%
  evaluatorMode: "SINGLE",
  delegationAllowed: false,
};

const ESTABLISHED_TIER: EvidenceTier = {
  name: "ESTABLISHED",
  capMultiplierBps: 5_000, // 50%
  bondFloorBps: 5_000, // 50%
  evaluatorMode: "SINGLE",
  delegationAllowed: true,
};

const STRONG_TIER: EvidenceTier = {
  name: "STRONG",
  capMultiplierBps: 10_000, // 100%
  bondFloorBps: 2_000, // 20%
  evaluatorMode: "NONE",
  delegationAllowed: true,
};

/** Section XVIII's worked example, made real. Thresholds are intentionally simple/conservative
 *  for a hackathon-scoped kernel — a market-calibration engine (Section XCVI-XCVII) is
 *  explicitly future work, not something an LLM or this profile tunes itself. */
export const CONSERVATIVE_RWA_V1: PolicyProfile = {
  name: "CONSERVATIVE_RWA_V1",
  version: "1.0.0",
  tierFor(evidence) {
    const { successfulJobs, adjudicatedFaults, successfulSettledValue } = evidence.economicHistory;
    // Property 5 (any adjudicated fault forces the worst tier, regardless of volume) is enforced
    // structurally here, not as a bolt-on check — there's no code path that can skip this.
    if (adjudicatedFaults > 0) return THIN_TIER;
    if (successfulJobs >= 50 && successfulSettledValue >= 10_000n) return STRONG_TIER;
    if (successfulJobs >= 10 && successfulSettledValue >= 1_000n) return ESTABLISHED_TIER;
    return THIN_TIER;
  },
};
