# KARMA-OKX: Plan vs. Reality Audit

Section-by-section check of `KARMA_OKX_MASTER_IMPLEMENTATION_PLAN.md` (122 sections) against what
is actually built and, where claimed, live on X Layer testnet.

Verified via CALM MCP repo index (390 files / 7,686 symbols) + `git log`, as of 2026-08-14. Every
file path below was confirmed to exist; every test count is copied from the repo's own
`docs/AI_SEASON_HACKATHON_CHECKLIST.md`, not estimated.

Legend: 🟢 DONE · 🟡 PARTIAL / FOLDED IN · 🔴 MISSING · ⚪ CUT (explicitly out of scope)

---

## Scorecard — the plan's own "4 most important deliverables" (§CXXI)

| # | Deliverable | Status | Evidence |
|---|---|---|---|
| 1 | `TrustEvidenceBundle` | 🟡 PARTIAL | Types exist (`evidence/types.ts`). No bundle builder, no providers, no dedup. |
| 2 | `TaskRiskIR` | 🟢 DONE | Classifier + zod validation + fallback, reused from `llm_strategy.ts`'s bounded-AI shape. |
| 3 | `KarmaPolicyIR` | 🟢 DONE | 3-layer compiler, deterministic, rule trace, 12 property tests passing. |
| 4 | X Layer Enforcement | 🟢 DONE | Live testnet contract, real revert, real cross-task terms diff — not simulated. |

## Timeline

- **before 2026-08-13** — Plan exists only as a document. None of `src/lib/trust/` or
  `contracts/policy/` present.
- **2026-08-13** `7420250` — ship Economic Trust Compiler MVP (kernel + enforcer + MCP tools)
- **2026-08-13** `bc93f2e` — browser demo page, exposure-conservation fuzz test, portable hashing
- **2026-08-13** `45c51c1` — EIP-712 signed policy issuance
- **2026-08-13** `1098113` — PolicyCredentialProof, policy-context-bound ZK
- **2026-08-14** `507b429` — live X Layer deployment recorded, real tx hashes

Four of the plan's own "most important deliverables" went from nothing to deployed and
transacting on testnet in roughly 36 hours across five commits — a compressed slice through
phases 0, 1, 5, 6, and part of 3 and 10 of the plan's 17-phase roadmap.

---

## §IV–XX Compiler kernel

| Plan calls for | Status | What's actually there |
|---|---|---|
| `TrustEvidenceBundle` / `EvidenceLeg` (§V–VI) | 🟡 PARTIAL | `src/lib/trust/evidence/types.ts` — interfaces exist, provenance fields included. No `bundle.ts`, `normalize.ts`, `dedupe.ts`, or `providers/`. |
| `TaskRiskIR` + classifier (§XI–XV) | 🟢 DONE | `src/lib/trust/risk/{types,classifier}.ts` — zod-validated enum output, impossible-combination check, conservative fallback-closed. 8 tests incl. prompt-injection case. |
| Reuse `llm_strategy.ts` pattern (§XIII) | 🟢 DONE | Same deterministic-filter → AI → schema validation → fallback shape, stricter (real zod, not `typeof` checks). |
| `KarmaPolicyIR` + `TermsCompiler` (§XVI–XVII) | 🟢 DONE | `src/lib/trust/policy/{ir,compiler}.ts` — principal ∩ earned-trust ∩ task-risk intersection, exactly the plan's three-layer model. |
| Policy profiles (§XVIII) | 🟡 PARTIAL | Only `CONSERVATIVE_RWA_V1` (`profiles.ts`), using the plan's own worked-example tier numbers. `AGENT_COMMERCE_V1` / `ENTERPRISE_PAYROLL_V1` / `HIGH_CUSTODY_V1` not built. |
| Rule trace + `explain()` (§XIX, L) | 🟢 DONE | `hash.ts` / `explain.ts` separated from `compiler.ts` as prescribed; trace uses the plan's own `RULE_xxx` naming. |
| Property tests (§LXXVII) | 🟢 DONE | 12 `fast-check` tests: cap never exceeded, risk-up never loosens, fault never improves terms, determinism. |
| Golden vector fixtures (§LXXXI) | 🔴 MISSING | No `test/vectors/policies/` directory. Coverage exists as property tests instead of committed fixture files. |

## §XX–XXXII On-chain enforcement

Plan specifies four separate contracts; the repo shipped one that does the combined job.

| Plan calls for | Status | What's actually there |
|---|---|---|
| `KarmaPolicyRegistry.sol` (§XXI) | 🟡 FOLDED IN | No standalone registry. `issuePolicy` / `issuePolicyWithSignature` live directly on `KarmaPolicyEnforcer.sol`. |
| Signed policy issuance (§XXII) | 🟢 DONE | EIP-712 via OpenZeppelin `EIP712`/`ECDSA`. 6 dedicated tests: wrong-key non-forgery, tampered-field rejection, replay rejection. |
| `PolicyDecisionAttestation.sol` (§XXIII–XXIV) | 🔴 MISSING | No separate attestation sidecar. Policy commitment lives inside the enforcer's own storage instead of a dedicated audit-trail contract. |
| `KarmaPolicyEnforcer.sol` (§XXV) | 🟢 DONE — LIVE | Deployed `0x1c74cbf7…31075`, X Layer testnet. 20 Foundry tests. Rejection errors match §CII's vocabulary verbatim. |
| `ExposureLedger.sol` (§XXVI) | 🟡 FOLDED IN | No standalone ledger or reserve/commit/release lifecycle. Spend accounting is inline state on the enforcer. |
| Concurrency invariant (§XXVII) | 🟢 DONE | `testFuzz_CumulativeSpentNeverExceedsCapAcrossRandomSequence` — 256-run Foundry fuzz, plus explicit same-block race test. First parameterized/fuzzed Solidity test in the repo. |
| Revocation (§XCII) | 🟢 DONE | `revokePolicy(policyId)`, principal-only, blocks future execution without touching already-recorded spend — confirmed in contract source. |
| Policy-aware escrow / Registry V2 (§XXVIII) | 🔴 MISSING | No `createJobWithPolicy` entrypoint; `AgentSkillRegistry.sol` untouched, per the plan's own "freeze v1" instruction — just not extended yet either. |
| EVM dispute parity (§XXIX) | ⚪ CUT | Explicitly named out of scope in the checklist's own §9. Casper/Odra panel-arbitration semantics not ported to EVM. |

## §XXXVIII–XLII Zero-knowledge / private underwriting

| Plan calls for | Status | What's actually there |
|---|---|---|
| `PolicyCredentialProof` (§XXXIX) | 🟢 DONE | `circuits/src/policy_credential.circom` — Poseidon commitment + range-check + Merkle membership, same skeleton as the pre-existing `agent_credential.circom` (kept unmodified). |
| Nullifier bound to policy context (§XL) | 🟢 DONE | Exactly the plan's spec: `Poseidon(credentialSecret, policyRequestId, domain)`. Test asserts two different `policyRequestId`s produce unlinkable nullifiers from the same credential. |
| Onchain verifier (§XLI) | 🟢 DONE | `contracts/policy/PolicyCredentialVerifier.sol` — real `snarkjs`-generated Groth16 verifier, BN254 pairing precompile. 4 Foundry tests feed literal proof bytes from the circuit's own test suite — no mocking. |

## §LI–LVII MCP tool surface

| Planned tool | Status | Notes |
|---|---|---|
| `karma_classify_task_risk` | 🟢 DONE | Live in `policy.tool.ts`, pure/no chain write. |
| `karma_quote_policy` | 🟢 DONE | Live, pure/deterministic as specified. |
| `karma_issue_policy` | 🟢 DONE | Writes to X Layer testnet. |
| `karma_execute_with_policy` | 🟢 DONE | Decodes reverts through `decodePolicyRejection` into the §CII vocabulary. |
| `karma_get_trust_evidence` | 🔴 MISSING | No standalone tool — evidence isn't yet assembled into a bundle to expose. |
| `karma_verify_policy` | 🔴 MISSING | Not built. |
| `karma_explain_policy` | 🔴 MISSING | `explain.ts` exists as a library function; not exposed as its own MCP tool. |
| `karma_underwrite_mandate` (orchestrator) | 🔴 MISSING | Not built. |

4 of 8 named tools shipped, all with passing tests (7 in `policy_tool.test.ts`) — the write/read
pair that lets the two Definition-of-Done demo scenarios run end to end.

---

## Explicitly not built (cut per checklist §9)

None of these gate the current milestone; they gate the next one.

- **Recursive delegation / Contract Graph** — no `PolicyLineage`, no parent/child exposure caps, no
  delegation adapter (§XXXIII–XXXVII).
- **Cross-chain evidence resolver** — `get_cross_chain_evidence`, identity correspondence,
  duplicate-event detection not built; the legacy oracle is still the arithmetic-average score the
  plan itself criticizes (§IX–X).
- **Economic Evidence Indexer** — no `indexer/` directory, no `EconomicEvent` normalization, no
  Merkle `evidenceRoot` builder (§LVIII–LXII).
- **RWA Mandate Adapter / envelope** — only the evidence side (price feed, provenance) was ported
  to `src/lib/rwa/`; `RwaMandateEnvelope` and the adapter that lowers a policy into RWA-rail terms
  don't exist (§XLIII–XLVII).
- **`src/lib/trust/adapters/`** — the whole planned folder (delegation, escrow, rwa_mandate,
  commerce) is absent.
- **Developer SDK / reproducible CLI** — no `karma.policy.compile()` object, no
  `karma policy compile` command; the compiler is reachable only via MCP tools and the browser
  demo (§XLIX, CVIII).
- **ADRs, threat model, architecture spec** — none of `ADR-001…012`,
  `docs/security/TRUST_COMPILER_THREAT_MODEL.md`, or
  `docs/architecture/ECONOMIC_TRUST_COMPILER.md` exist. The hackathon checklist is currently doing
  the job of a spec document (§CV–CVI, LXXV).

---

## §CXVII Definition of Done — scenarios A–O

Two proven live with real transactions; most of the rest untouched.

| Scenario | Description | Status |
|---|---|---|
| A — different agent, same task | Alpha 100/500 vs Beta 10/50, same RWA task | 🟢 Live on-chain |
| B — same agent, different task | Same subject/evidence, low-risk vs high-risk task → different terms | 🟢 Live on-chain |
| C — principal limit | Principal cap must dominate earned trust | 🟢 Property-tested |
| D — hard cap | Beta cap 10, attempt 25 → revert | 🟢 Live on-chain |
| E — exposure race | Two concurrent reservations, only one succeeds | 🟢 Fuzz-tested |
| F — stale trust | Evidence expires between quote and funding | 🔴 Not attempted |
| G — post-quote slash | Fault adjudicated before funding | 🔴 Not attempted |
| H — funded obligation | Later reputation change doesn't rewrite a running job | 🟡 Partial — revoke tested |
| I — replay | Policy replayed to a different chain/domain/action | 🔴 Not attempted |
| J — ZK predicate | Threshold proof accepted without revealing exact score | 🟢 Proof verified |
| K — cross-chain duplicate | Same event from two sources, no double privilege | ⚪ Cut |
| L — recursive delegation | Children can't exceed parent exposure | ⚪ Cut |
| M — delegation widening | Child can't request a wider action than parent | ⚪ Cut |
| N — prompt injection | Task text tries to set bond=0, risk=low directly | 🟢 Tested |
| O — dispute | Adjudicated fault tightens future policy, not past | ⚪ Cut |

---

## §CXXII What the plan's own priority order says is next

The plan orders itself: *kernel before adapters, evidence before scores, provenance before
aggregation.* Read that way against the gaps above, the next load-bearing piece isn't a new
adapter — it's finishing the evidence side the kernel already assumes.

**Highest-leverage next step:** a real `TrustEvidenceBundle` builder (`bundle.ts` + at least one
`EvidenceProvider`, e.g. wrapping `flow_reputation.ts`) so `karma_quote_policy` stops taking
evidence as a hand-built object and starts reading it from the chain — everything downstream (more
profiles, the RWA mandate envelope, the SDK) is a thinner layer once that exists.

---

*Plan reference: `KARMA_OKX_MASTER_IMPLEMENTATION_PLAN.md` (122 sections). Repo state captured:
2026-08-14.*
