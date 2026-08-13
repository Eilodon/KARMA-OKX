import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { compilePolicy } from "../lib/trust/policy/compiler.js";
import { CONSERVATIVE_RWA_V1 } from "../lib/trust/policy/profiles.js";
import { computePolicyHash } from "../lib/trust/policy/hash.js";
import { explainRuleTrace } from "../lib/trust/policy/explain.js";
import { conservativeFallbackRisk, type TaskRiskIR } from "../lib/trust/risk/types.js";
import type { PrincipalEnvelope } from "../lib/trust/policy/ir.js";
import type { TrustEvidenceBundle } from "../lib/trust/evidence/types.js";

const NOW = 1_700_000_000_000;

function principalEnvelope(overrides: Partial<PrincipalEnvelope> = {}): PrincipalEnvelope {
  return {
    principal: "0xPrincipal",
    subject: "0xSubject",
    allowedActions: ["BUY"],
    maxPerTransaction: 500n,
    maxCumulativeExposure: 2_000n,
    delegationAllowed: true,
    validFrom: NOW - 1_000,
    validUntil: NOW + 86_400_000,
    ...overrides,
  };
}

function evidence(overrides: Partial<TrustEvidenceBundle["economicHistory"]> = {}): TrustEvidenceBundle {
  return {
    subject: "0xSubject",
    economicHistory: {
      successfulSettledValue: 0n,
      failedSettledValue: 0n,
      disputedValue: 0n,
      successfulJobs: 0,
      adjudicatedFaults: 0,
      counterpartyCount: 0,
      ...overrides,
    },
    capital: { activeBond: 0n, historicalSlashedValue: 0n },
    evidenceLegs: [],
    snapshot: { snapshotId: "snap-1", evidenceRoot: "0xroot", takenAt: NOW },
  };
}

function risk(overrides: Partial<TaskRiskIR> = {}): TaskRiskIR {
  return {
    actionClass: "BUY",
    assetClass: "RWA",
    capitalMovement: true,
    custodyRequired: false,
    externalTransfer: false,
    reversible: "FULL",
    delegationRequired: false,
    externalSideEffects: "LOW",
    counterpartyDependency: "LOW",
    dataSensitivity: "PUBLIC",
    semanticFlags: [],
    classificationConfidence: 0.9,
    amountAtRisk: 100n,
    expectedDurationSecs: 3_600,
    source: "llm",
    ...overrides,
  };
}

function compile(over: {
  principal?: Partial<PrincipalEnvelope>;
  evidenceHistory?: Partial<TrustEvidenceBundle["economicHistory"]>;
  risk?: Partial<TaskRiskIR>;
  nonce?: bigint;
} = {}) {
  return compilePolicy({
    evidence: evidence(over.evidenceHistory),
    risk: risk(over.risk),
    principalEnvelope: principalEnvelope(over.principal),
    profile: CONSERVATIVE_RWA_V1,
    actionDigest: "0xactiondigest",
    actionClass: "BUY",
    nonce: over.nonce ?? 1n,
    issuedAt: NOW,
  });
}

describe("compilePolicy — example scenarios", () => {
  it("thin-history subject gets the THIN tier's 10% cap and 100% bond floor", () => {
    const { policy, ruleTrace } = compile();
    expect(policy.authority.maxPerTransaction).toBe(50n); // 10% of 500
    expect(policy.authority.maxCumulativeExposure).toBe(200n); // 10% of 2000
    expect(policy.settlement.providerBondBps).toBe(10_000);
    expect(ruleTrace.some((r) => r.ruleId === "RULE_104")).toBe(true);
  });

  it("strong-history subject with a low-risk task gets close to full principal authority", () => {
    const { policy } = compile({
      evidenceHistory: { successfulJobs: 80, successfulSettledValue: 20_000n },
    });
    expect(policy.authority.maxPerTransaction).toBe(500n);
    expect(policy.authority.maxCumulativeExposure).toBe(2_000n);
    expect(policy.settlement.providerBondBps).toBe(2_000);
    expect(policy.evaluation.mode).toBe("NONE");
  });

  it("Section XLVI/XLVII — same subject, higher-risk task tightens terms vs a low-risk task", () => {
    const strongEvidence = { successfulJobs: 80, successfulSettledValue: 20_000n };
    const lowRisk = compile({ evidenceHistory: strongEvidence });
    const highRisk = compile({
      evidenceHistory: strongEvidence,
      risk: { custodyRequired: true, externalTransfer: true, reversible: "NONE", externalSideEffects: "HIGH" },
    });
    expect(highRisk.policy.authority.maxPerTransaction).toBeLessThan(lowRisk.policy.authority.maxPerTransaction);
    expect(highRisk.policy.authority.maxCumulativeExposure).toBeLessThan(
      lowRisk.policy.authority.maxCumulativeExposure,
    );
    expect(highRisk.policy.settlement.providerBondBps).toBeGreaterThan(lowRisk.policy.settlement.providerBondBps);
    expect(highRisk.policy.evaluation.mode).toBe("PANEL");
    expect(lowRisk.policy.evaluation.mode).toBe("NONE");
  });

  it("Section III — an unauthorized action collapses authority to zero, not a discount", () => {
    const { policy } = compile({ principal: { allowedActions: ["SELL"] } });
    expect(policy.authority.maxPerTransaction).toBe(0n);
    expect(policy.authority.maxCumulativeExposure).toBe(0n);
    expect(policy.authority.allowedActions).toEqual([]);
  });

  it("adjudicated fault forces THIN tier even with huge settled volume", () => {
    const { policy } = compile({
      evidenceHistory: { successfulJobs: 500, successfulSettledValue: 1_000_000n, adjudicatedFaults: 1 },
    });
    expect(policy.settlement.providerBondBps).toBe(10_000);
    expect(policy.authority.maxPerTransaction).toBe(50n);
  });

  it("classification fallback (source=llm_fallback, confidence=0) tightens further, never loosens", () => {
    const strongEvidence = { successfulJobs: 80, successfulSettledValue: 20_000n };
    const normal = compile({ evidenceHistory: strongEvidence });
    const fallback = compile({
      evidenceHistory: strongEvidence,
      risk: conservativeFallbackRisk({ amountAtRisk: 100n, expectedDurationSecs: 3_600 }),
    });
    expect(fallback.policy.authority.maxPerTransaction).toBeLessThanOrEqual(normal.policy.authority.maxPerTransaction);
  });

  it("determinism — identical input compiles to the identical policyHash", () => {
    const a = compile();
    const b = compile();
    expect(a.policy.policyHash).toBe(b.policy.policyHash);
    const { policyHash: _omit, ...withoutHash } = a.policy;
    expect(a.policy.policyHash).toBe(computePolicyHash(withoutHash));
  });

  it("explainRuleTrace renders every rule id from the trace", () => {
    const { ruleTrace } = compile();
    const text = explainRuleTrace(ruleTrace);
    for (const r of ruleTrace) expect(text).toContain(r.ruleId);
  });
});

// ── Property tests — the plan's own invariants (Section LXXVII), not just example fixtures ────

const evidenceArb = fc.record({
  successfulJobs: fc.integer({ min: 0, max: 1_000 }),
  successfulSettledValue: fc.bigInt({ min: 0n, max: 10_000_000n }),
  adjudicatedFaults: fc.integer({ min: 0, max: 5 }),
});

const principalCapArb = fc.record({
  maxPerTransaction: fc.bigInt({ min: 0n, max: 1_000_000n }),
  maxCumulativeExposure: fc.bigInt({ min: 0n, max: 10_000_000n }),
});

const riskFlagsArb = fc.record({
  custodyRequired: fc.boolean(),
  externalTransfer: fc.boolean(),
  externalSideEffects: fc.constantFrom("LOW", "MEDIUM", "HIGH") as fc.Arbitrary<"LOW" | "MEDIUM" | "HIGH">,
  reversible: fc.constantFrom("FULL", "PARTIAL", "NONE") as fc.Arbitrary<"FULL" | "PARTIAL" | "NONE">,
});

describe("compilePolicy — property tests (fast-check)", () => {
  it("Property 2: compiled authority never exceeds the principal's caps", () => {
    fc.assert(
      fc.property(evidenceArb, principalCapArb, riskFlagsArb, (ev, caps, riskFlags) => {
        const { policy } = compile({
          evidenceHistory: ev,
          principal: caps,
          risk: riskFlags,
        });
        expect(policy.authority.maxPerTransaction).toBeLessThanOrEqual(caps.maxPerTransaction);
        expect(policy.authority.maxCumulativeExposure).toBeLessThanOrEqual(caps.maxCumulativeExposure);
      }),
      { numRuns: 200 },
    );
  });

  it("Property 3: raising externalSideEffects from LOW to HIGH (all else equal) never loosens terms", () => {
    fc.assert(
      fc.property(evidenceArb, principalCapArb, (ev, caps) => {
        const low = compile({ evidenceHistory: ev, principal: caps, risk: { externalSideEffects: "LOW" } });
        const high = compile({ evidenceHistory: ev, principal: caps, risk: { externalSideEffects: "HIGH" } });
        expect(high.policy.authority.maxPerTransaction).toBeLessThanOrEqual(low.policy.authority.maxPerTransaction);
        expect(high.policy.authority.maxCumulativeExposure).toBeLessThanOrEqual(
          low.policy.authority.maxCumulativeExposure,
        );
        expect(high.policy.settlement.providerBondBps).toBeGreaterThanOrEqual(low.policy.settlement.providerBondBps);
      }),
      { numRuns: 200 },
    );
  });

  it("Property 5: adding an adjudicated fault (all else equal) never improves terms", () => {
    fc.assert(
      fc.property(evidenceArb, principalCapArb, riskFlagsArb, (ev, caps, riskFlags) => {
        const clean = compile({
          evidenceHistory: { ...ev, adjudicatedFaults: 0 },
          principal: caps,
          risk: riskFlags,
        });
        const faulted = compile({
          evidenceHistory: { ...ev, adjudicatedFaults: ev.adjudicatedFaults + 1 },
          principal: caps,
          risk: riskFlags,
        });
        expect(faulted.policy.authority.maxPerTransaction).toBeLessThanOrEqual(clean.policy.authority.maxPerTransaction);
        expect(faulted.policy.settlement.providerBondBps).toBeGreaterThanOrEqual(clean.policy.settlement.providerBondBps);
      }),
      { numRuns: 200 },
    );
  });

  it("Determinism: identical input always compiles to the identical policyHash", () => {
    fc.assert(
      fc.property(evidenceArb, principalCapArb, riskFlagsArb, (ev, caps, riskFlags) => {
        const a = compile({ evidenceHistory: ev, principal: caps, risk: riskFlags, nonce: 7n });
        const b = compile({ evidenceHistory: ev, principal: caps, risk: riskFlags, nonce: 7n });
        expect(a.policy.policyHash).toBe(b.policy.policyHash);
      }),
      { numRuns: 100 },
    );
  });
});
