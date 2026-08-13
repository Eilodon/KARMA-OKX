/**
 * Trust evidence types — the compiler kernel's input shape for "what has this subject earned
 * economically, and how much should that be trusted." Scoped for the AI Season hackathon MVP:
 * a single evidence leg per source, no cross-chain dedup/correlation yet (see
 * `KARMA_OKX_MASTER_IMPLEMENTATION_PLAN.md` Sections VI/IX-X for the full cross-chain evidence
 * resolver this intentionally leaves for later — `get_cross_chain_trust_score` stays an
 * arithmetic-average advisory read, unrelated to this bundle).
 *
 * Deliberately does NOT include a `karmaScore`/aggregate number anywhere — the compiler
 * (`policy/compiler.ts`) consumes `economicHistory`/`capital` fields directly, never a
 * pre-collapsed scalar (Section V's core anti-pattern: "no karmaScore -> if score>80: bond=20%").
 */

export type EvidenceSourceType =
  | "XLAYER_JOB"
  | "CASPER_JOB"
  | "BOND"
  | "DISPUTE"
  | "RWA_PROVENANCE"
  | "ZK_CREDENTIAL"
  | "IDENTITY"
  | "EXTERNAL_ATTESTATION";

export type FreshnessClass = "LIVE" | "RECENT" | "STALE" | "EXPIRED";

/** One provenance-carrying fact — every number the compiler sees must trace back to one of
 *  these, per Section VI ("87 đến từ đâu? được tính lúc nào? dựa trên history nào?"). */
export interface EvidenceLeg {
  evidenceId: string;
  subject: string;
  sourceType: EvidenceSourceType;
  sourceDomain: string;
  sourceRef: string;
  observedAt: number;
  /** 0-100: how much this source type/issuer should be trusted (Section X — a governance-fed
   *  score and a locally-verifiable settlement history should not weight equally). */
  assuranceLevel: number;
  freshnessClass: FreshnessClass;
  payloadHash: string;
  /** Dedup key for cross-chain mirrors of the same underlying economic event (Section VII —
   *  "one underlying economic event contributes at most once"). Unset in the MVP since no
   *  provider produces cross-chain mirrors yet; the field exists so a future provider can. */
  canonicalEconomicEventId?: string;
}

export interface EvidenceSnapshot {
  snapshotId: string;
  /** Canonical hash over `evidenceLegs` (via `canonicalHash`) — binds a policy to the evidence
   *  state at issuance time (Section V: "Evidence Snapshot"). Not a Merkle tree in the MVP
   *  (Section LXII's per-leaf inclusion proofs are out of scope) — a flat commitment is enough
   *  to prove non-equivocation for a hackathon-scoped compiler. */
  evidenceRoot: string;
  takenAt: number;
}

export interface TrustEvidenceBundle {
  subject: string;

  economicHistory: {
    successfulSettledValue: bigint;
    failedSettledValue: bigint;
    disputedValue: bigint;
    successfulJobs: number;
    adjudicatedFaults: number;
    counterpartyCount: number;
  };

  capital: {
    activeBond: bigint;
    historicalSlashedValue: bigint;
  };

  evidenceLegs: EvidenceLeg[];
  snapshot: EvidenceSnapshot;
}
