/**
 * `KarmaPolicyIR` — the canonical compiler output, per
 * `KARMA_OKX_MASTER_IMPLEMENTATION_PLAN.md` Section XVI. Every adapter (X Layer enforcement,
 * demo scripts, MCP tools) consumes this same shape — nothing downstream invents its own terms.
 *
 * Scoped down from the full plan's IR for the hackathon MVP: no `evidenceRequirements`
 * (execution-time predicates), no `delegation` block (Contract Graph is explicitly out of scope
 * for this build — see the plan file). `policyHash` is a field on the type for convenience but is
 * always computed over the IR *without* itself (`policy/hash.ts`'s `computePolicyHash` takes an
 * `Omit<KarmaPolicyIR, "policyHash">`) — a struct can't canonically hash its own hash field.
 */

export type SettlementMode = "DIRECT" | "ESCROW";
export type PolicyEvaluationMode = "NONE" | "SINGLE" | "PANEL";

/** What the principal is willing to grant, at most — the compiler only ever attenuates this
 *  (Section III, Invariant 1: `EffectiveAuthority ⊆ PrincipalAuthority`). */
export interface PrincipalEnvelope {
  principal: string;
  subject: string;
  allowedActions: string[];
  maxPerTransaction: bigint;
  maxCumulativeExposure: bigint;
  delegationAllowed: boolean;
  validFrom: number;
  validUntil: number;
}

export interface KarmaPolicyIR {
  schemaVersion: string;

  principal: string;
  subject: string;

  actionDigest: string;
  actionClass: string;

  authority: {
    allowedActions: string[];
    maxPerTransaction: bigint;
    maxCumulativeExposure: bigint;
  };

  settlement: {
    mode: SettlementMode;
    providerBondBps: number;
  };

  evaluation: {
    mode: PolicyEvaluationMode;
  };

  validity: {
    issuedAt: number;
    validFrom: number;
    expiresAt: number;
  };

  evidenceRoot: string;
  taskRiskHash: string;

  policyProfile: string;
  policyVersion: string;
  compilerVersion: string;

  nonce: bigint;

  /** Always recomputed via `computePolicyHash`, never hand-set — present on the type so callers
   *  can carry the finished IR + its hash as one object after compilation. */
  policyHash: string;
}
