# AI Season Hackathon (X Layer) — what's built, what's left, and who does it

Deadline: **21 August 2026, 23:59 UTC** (hackathon period 7–21 Aug). Separate from, and newer
than, the OKX.AI Genesis Hackathon tracked in `docs/OKX_HACKATHON_CHECKLIST.md` (deadline already
passed, 27 July) — that checklist's ASP registration / MCP endpoint work still matters here (see
§0), but this is a distinct submission with its own Google Form and its own AI-RWA track.

Official page: `web3.okx.com/xlayer/build-x-series` (AI Season). Prize pool up to 300,000 USDT:
Hackathon Grant (1st 30K / 2nd 15K / 3rd 5K), **AI-RWA Liquidity Grant 50K USDT** (the track this
submission targets), Launch Grant up to 200K (trading-volume-gated — not applicable to KARMA, not
pursued).

**Strategy in one line, same as Genesis: testnet-only for the hackathon window, mainnet after
(the official FAQ says mainnet deploy happens post-hackathon), submit as soon as the compiler
kernel + on-chain enforcement are provably working.**

Eligibility per the official qualify list: build AI into the product, deploy independently on X
Layer, maintain a dedicated X account, tag @XLayerOfficial when submitting.

## 0. What's already live from Genesis and must not go dark

- `AgentSkillRegistry` on X Layer testnet:
  [`0xBF285628869c2EFaf6731F8503B39B7130474Cd2`](https://www.oklink.com/xlayer-test/address/0xBF285628869c2EFaf6731F8503B39B7130474Cd2).
- ASP/MCP endpoint `https://karma-trust-oracle.fly.dev/mcp` — health-checked 200 OK this session
  (`tools/list` returns `karma_pattern_debt`, `karma_ping`, `get_cross_chain_trust_score`). X
  Layer has publicly warned offline ASPs get delisted during review — **re-check this before
  submitting**, don't assume it's still up from a prior session.

## 0.5. `KarmaPolicyEnforcer` — LIVE on X Layer testnet, both demo scenarios run for real

**Deployed:** [`0x1c74cbf7544ee10cbc3be9f424fe16e9a4731075`](https://www.oklink.com/xlayer-test/address/0x1c74cbf7544ee10cbc3be9f424fe16e9a4731075)
(tx [`0x2978d02e018f83757002f8c876edc0a544c593e5fbeaab7c7339dbd2039a5089`](https://www.oklink.com/xlayer-test/tx/0x2978d02e018f83757002f8c876edc0a544c593e5fbeaab7c7339dbd2039a5089),
block 38244118, deployer `0x2143e36C9DF45fb98AE9aE116C4E99B7800a39d7`, signed via the repo's own
`KeystoreManager` — the raw private key never left that class, matching its own documented
security design). Set `XLAYER_POLICY_ENFORCER_ADDRESS=0x1c74cbf7544ee10cbc3be9f424fe16e9a4731075`
in `.env` to use it.

**Both Definition-of-Done demo scenarios run live against it this session, not simulated:**

Scenario A (Alpha vs Beta, same task) — Alpha (strong evidence) got 100/500 terms, attempted 80,
[**PERMITTED**](https://www.oklink.com/xlayer-test/tx/0x92395d48333f9914a617161f6b450c63c5f8eacf8c46c514206496858862a0bc).
Beta (thin evidence) got 10/50 terms, attempted 25,
[**REJECTED on-chain**](https://www.oklink.com/xlayer-test/tx/0xd43b1b5ca0a351c02a9f766f1ad5389d106353f5ef47be9f54cbb26f3fc05beb)
with `PER_TRANSACTION_LIMIT_EXCEEDED` — the plan's own Scenario D ("Beta calls execute(25).
Revert.") literally, on real testnet, with a real reverted transaction.

Scenario B (same subject, different task risk) — the SAME subject/evidence: a low-risk rebalance
task compiled to 100/500 terms, evaluator NONE, 20% bond
([issued](https://www.oklink.com/xlayer-test/tx/0x4deda90c476e60c7785ab37cd3f4254b852ac46bd16c8d28265747348f13fc02));
a high-risk custody+external-transfer task compiled to 50/250 terms, evaluator PANEL, 50% bond
([issued](https://www.oklink.com/xlayer-test/tx/0xc24e2bc2519d194fea6ad627c521bf0d8f23e46d261d0982bf2256bb24cc3822))
— same subject, same reputation, provably different terms because the obligation differs. This is
the plan's own central claim (Section XLVII), proven with real transactions, not asserted.

This makes §2/§4's "ready to run the moment a funded key exists" no longer conditional — it
happened.

## 1. Economic Trust Compiler kernel — DONE (this session, pure TS, no chain)

The four core deliverables the whole master-plan thesis hinges on
(`KARMA_OKX_MASTER_IMPLEMENTATION_PLAN.md` Section CXXI), scoped to what a hackathon window can
actually prove:

- [x] `TrustEvidenceBundle` / `EvidenceLeg` types — `src/lib/trust/evidence/types.ts`
- [x] `TaskRiskIR` + `TaskRiskClassifier` — `src/lib/trust/risk/types.ts`,
      `src/lib/trust/risk/classifier.ts`. Reuses `autonomous_loop/llm_strategy.ts`'s bounded-AI
      shape (deterministic pre-filter is trivial here → forced structured LLM call → **real zod
      schema validation, enum-only fields** → fallback-closed), with two things stricter than
      that file's own pattern: real schema validation instead of ad-hoc `typeof` checks, and a
      deterministic "impossible combination" check (Section XIV).
- [x] `KarmaPolicyIR` + deterministic `compiler.ts` — `src/lib/trust/policy/{ir,compiler,profiles,hash,explain}.ts`.
      One profile, `CONSERVATIVE_RWA_V1`, with the exact thin/established/strong tier numbers
      from the plan's own Section XVIII worked example. Three-layer intersection (principal cap ∩
      earned trust ∩ task risk), machine-readable rule trace using the plan's own `RULE_xxx`
      naming.
- [x] Property tests (`fast-check`, newly added devDependency) — `src/__tests__/policy_compiler.test.ts`:
      principal cap never exceeded, risk-up never loosens terms, adjudicated fault never improves
      terms, determinism (same input → same `policyHash`). 12 tests, all passing.
- [x] `TaskRiskClassifier` tests — `src/__tests__/task_risk_classifier.test.ts`, 8 tests including
      a prompt-injection case (attacker text embedded in a free-text field never reaches an enum
      the compiler branches on).
- [x] `policyHash`/`evidenceRoot`/`taskRiskHash` hashing is a self-contained SHA-256
      (`src/lib/canonical_hash.ts`), not `node:crypto` — pinned against `node:crypto` itself via a
      300-run property test plus block-boundary/UTF-8 edge cases
      (`src/__tests__/canonical_hash.test.ts`, 16 tests). Deliberate: this is what lets the
      compiler run **client-side, in a browser**, with no server round-trip (§6).

Verify: `pnpm exec vitest run src/__tests__/policy_compiler.test.ts src/__tests__/task_risk_classifier.test.ts src/__tests__/canonical_hash.test.ts`

## 2. X Layer hard enforcement — contract DONE, deploy NEEDS A HUMAN

- [x] `contracts/policy/KarmaPolicyEnforcer.sol` — additive sidecar (same convention as
      `RationaleAttestation.sol`), custom errors matching the plan's Section CII rejection-code
      vocabulary literally (`PerTransactionLimitExceeded`, `CumulativeExposureExceeded`,
      `PolicyExpired`, `PolicyRevoked`, ...). **Two issuance paths, both fully enforced
      identically afterward:**
      1. `issuePolicy` — direct, `msg.sender` is the principal.
      2. `issuePolicyWithSignature` — EIP-712 (OpenZeppelin's `EIP712`/`ECDSA`, not a hand-rolled
         digest), principal recovered from a `PolicyAuthorization` signature instead of paying gas
         itself; anyone (relayer, the subject) can submit it. This was originally a documented
         scope-cut ("direct issuance only") — built this session once the direct path was proven
         solid; see the contract's header comment for the full domain-separation rationale (two
         layers now: the EIP-712 domain separator itself, plus `policyId`'s own derivation).
- [x] `test/KarmaPolicyEnforcer.t.sol` — 20 Foundry tests, all passing (`forge test --match-contract
      KarmaPolicyEnforcerTest`), directly covering Definition-of-Done Scenario D (hard cap → revert)
      and Scenario H-style "revocation doesn't rewrite already-recorded spend." Includes:
      - `testFuzz_CumulativeSpentNeverExceedsCapAcrossRandomSequence` — a genuine 256-run Foundry
        fuzz test (this repo had **zero** parameterized/fuzzed Solidity tests before this one —
        every pre-existing `test/*.t.sol` file takes no arguments, so Foundry's fuzzer never ran
        on any of them) proving Section XXVII's "Available = Limit - Reserved - Committed"
        invariant holds across random call sequences, plus an explicit same-block "two
        reservations race for the same budget" test.
      - 6 `issuePolicyWithSignature` tests: a different signing key recovers to *that* key's own
        address (never forges another principal), a tampered field after signing recovers to a
        different address (doesn't silently authenticate), malformed signature bytes revert,
        reused `policyId` reverts the same as the direct path, and a signed policy is enforced by
        `validateAndRecordExecution` exactly like a directly-issued one.
- [x] `src/lib/abi.ts` (`karmaPolicyEnforcerAbi`) + structural drift-guard test extended in
      `src/__tests__/karma_contract.test.ts` — this genuinely caught a real gap while wiring EIP-712
      in: inheriting OpenZeppelin's `EIP712` adds `eip712Domain()`/`EIP712DomainChanged` (ERC-5267)
      and `ECDSAInvalidSignature*`/`InvalidShortString`/`StringTooLong` errors to the contract's
      real ABI that a hand-transcription would otherwise silently miss — the guard failed loudly
      until those were added.
- [x] `src/lib/xlayer_policy.ts` — TS read/write binding, copied skeleton-for-skeleton from
      `xlayer_rationale.ts`; `signPolicyAuthorization`/`issuePolicyWithSignature` added for the
      signed path (`walletClient.signTypedData` against the exact same EIP-712 domain the
      contract's constructor registers).
- [x] **Deployed to X Layer testnet.** [`0x1c74cbf7544ee10cbc3be9f424fe16e9a4731075`](https://www.oklink.com/xlayer-test/address/0x1c74cbf7544ee10cbc3be9f424fe16e9a4731075) —
      see §0.5. Signed via `KeystoreManager` + `viem`'s `deployContract` (not a raw `forge create
      --private-key`) so the deployer's private key never left the keystore-decryption class, in
      keeping with that class's own stated security design.

## 3. MCP tool surface — DONE (this session)

`src/plugins/policy.tool.ts`, registered in `isTrustedBuiltInPlugin()`:

- [x] `karma_classify_task_risk`, `karma_quote_policy` (pure, no chain write)
- [x] `karma_issue_policy`, `karma_execute_with_policy` (X Layer writes, decode reverts into the
      Section CII rejection vocabulary via `decodePolicyRejection`)
- [x] `src/__tests__/policy_tool.test.ts` — 7 tests, all passing, including "action outside the
      principal's allowedActions collapses authority to zero" and "omitting risk compiles under
      the conservative fallback, not a permissive default."

These tools are additive on the *existing, already-approved* MCP endpoint (§0) — no new ASP
review cycle needed once deployed and wired to a live env.

## 4. Demo scripts (Scenario A + B) — DONE, both run live against the real deployment

- [x] `src/scripts/demo_xlayer_policy_lifecycle.ts` (`pnpm demo:xlayer:policy-lifecycle`) —
      Definition-of-Done Scenario A + D: Alpha (strong evidence) vs. Beta (thin evidence), same
      RWA task, different `KarmaPolicyIR`, both issued on X Layer testnet, Beta's over-cap attempt
      reverts on-chain for real.
- [x] `src/scripts/demo_xlayer_task_risk_scenarios.ts` (`pnpm demo:xlayer:task-risk`) — Scenario B
      (plan Section XLVII's own "quan trọng hơn" scenario): the SAME subject, SAME evidence, two
      different task descriptions, two different sets of terms, both issued on-chain — the direct
      rebuttal to "KARMA is just a wallet score."
- [x] **Both scenarios actually run against X Layer testnet this session — see §0.5 for every tx
      hash.** Run inline against `KeystoreManager` rather than the scripts' own `PRIVATE_KEY`-env
      convenience path (same compiler/xlayer_policy functions either way) so the funded key never
      left keystore-decryption. To re-run via the committed scripts themselves:
      `XLAYER_POLICY_ENFORCER_ADDRESS=0x1c74cbf7544ee10cbc3be9f424fe16e9a4731075 PRIVATE_KEY=0x...
      pnpm demo:xlayer:policy-lifecycle` (and `:task-risk`).

## 5. RWA evidence port — DONE

- [x] `src/lib/casper/rwa_price_feed.ts` / `rwa_provenance_receipt.ts` moved to
      `src/lib/rwa/` (confirmed 100% chain-agnostic — no Casper SDK dependency), old paths kept as
      thin re-export shims so the existing Casper demo scripts/tests need zero changes (22
      pre-existing tests re-verified passing through the shim).
- [x] `canonicalize`/`sha256Hex` deduplicated into `src/lib/canonical_hash.ts`, shared by both the
      RWA receipt module and the policy compiler's `policyHash`.

## 6. Demo webpage — DONE, live-verified in a real browser (Playwright)

- [x] `docs/media/xlayer_policy_demo.html` + `src/web/xlayer_policy_demo_entry.ts`
      (`pnpm run build:xlayer-policy-demo-page`) — same esbuild/browser-bundle convention as
      `casper_human_payer.html`. Two independent modes:
      1. **Quote mode (no wallet needed)**: runs the real `compilePolicy` kernel entirely
         client-side — same code the MCP tools and demo scripts use, not a reimplementation —
         producing a real `policyHash` in the visitor's own browser. Verified live via Playwright
         this session: compiling Alpha's low-risk quote produced
         `policyHash=0xf634d9…c4883634e` with the exact expected rule trace
         (`RULE_001`→`RULE_120 evidence_tier_strong`); switching to the high-risk preset and
         recompiling correctly tightened terms (`RULE_211`/`RULE_240`/`RULE_301`, evaluator
         NONE→PANEL, cap cut in half) and rendered a live terms-diff table. Malformed risk JSON
         and "no wallet installed" both fail with a clear on-page message, not a console crash —
         also verified live.
      2. **On-chain mode (needs a wallet + deployed contract)**: `window.ethereum` via viem's
         `custom()` transport — `issuePolicy`/`validateAndRecordExecution` against a
         user-supplied `KarmaPolicyEnforcer` address, decoding reverts through the same
         `policy_rejection.ts` vocabulary `policy.tool.ts` uses server-side.
- [x] `src/lib/canonical_hash.ts`'s `node:crypto` dependency was replaced with a self-contained
      SHA-256 specifically to make this possible (esbuild `--platform=browser` can't bundle
      `node:crypto`) — see §1.
- [x] `src/lib/policy_rejection.ts` extracted from `xlayer_policy.ts` (pure, no `process.env`
      access) so the browser bundle can decode contract reverts without pulling in
      `xlayer.ts`'s env-reading chain-client singletons, which would throw `process is not
      defined` in a browser.
- [ ] The demo webpage's on-chain mode still only exercises the direct `issuePolicy` path, not the
      newer `issuePolicyWithSignature` (§2) — the contract/TS binding/tests for the signed path
      are done, wiring a "sign gas-lessly, let someone else submit" button into the page (and a
      matching `karma_issue_policy_via_signature` MCP tool) is additive follow-up, not required
      for AI Season eligibility.

## 7. EIP-712 signed policies — DONE (originally scoped out, built once the direct path proved solid)

- [x] `issuePolicyWithSignature` on `KarmaPolicyEnforcer.sol` (§2) — see that section for the full
      test list. Uses OpenZeppelin's `EIP712`/`ECDSA`, the same standard library every serious
      EIP-712 integration uses, not a hand-rolled digest.
- [x] `signPolicyAuthorization`/`issuePolicyWithSignature` in `src/lib/xlayer_policy.ts` (§2).

## 8. ZK `PolicyCredentialProof` — DONE, real proof verified on a real EVM precompile

"Private Underwriting" per the plan's Section XXXIX-XLII, closing the exact gap Section XL names:
`agent_credential.circom`'s existing `AgentCredentialProof` nullifier
(`Poseidon(credentialSecret, skillId)`) is bound only to *which skill*, so the same credential
produces the same nullifier across every policy request against that skill — different
underwriting requests for the same agent are linkable to each other. Not a hypothetical fix —
built, compiled, proved, and verified end-to-end this session:

- [x] `circuits/src/policy_credential.circom` — same proven Poseidon-commitment + range-check +
      Merkle-membership skeleton as `AgentCredentialProof` (kept unmodified, backward-compatible),
      nullifier changed to `Poseidon(credentialSecret, policyRequestId, domain)` — three inputs,
      exactly Section XL's own list.
- [x] `circuits/test/policy_credential.test.mjs` — full `circom` → Groth16 trusted setup → prove →
      verify pipeline, run for real this session (not simulated): happy path, 4 negative cases
      (bad commitment/low reputation/wrong root/tampered nullifier), and the property that's the
      actual point of this circuit — **the same credential, two different `policyRequestId`s,
      produce two different, unlinkable nullifiers** — asserted directly, not just claimed.
- [x] `contracts/policy/PolicyCredentialVerifier.sol` — real `snarkjs zkey export
      solidityverifier` output (renamed contract, otherwise unmodified generated code), the
      EVM/X-Layer-native path (BN254 pairing precompile, `ecPairing` at `0x08`) rather than the
      Stellar track's native-host-function byte-packing.
- [x] `test/PolicyCredentialVerifier.t.sol` — 4 Foundry tests feeding the verifier the **literal
      proof bytes** the circuit test suite generated (via `snarkjs zkey export soliditycalldata`)
      — a genuine off-chain-generated ZK proof, verified by a real EVM precompile call, zero
      mocking on either side. `test_VerifiesRealProof_FromCircuitTestSuite` is the actual
      happy-path proof; three negative tests (tampered public signal, wrong `policyRequestId`,
      mangled curve point) confirm the verifier actually rejects, not just accepts everything.

Verify: `cd circuits && make policy-credential` (installs `circom`/`snarkjs` if needed, ~2 min),
then `forge test --match-contract PolicyCredentialVerifierTest -vv` from the repo root.

## 9. Not done — explicitly cut for this build (documented, not forgotten)

Recursive delegation/Contract Graph, cross-chain evidence dedup, EVM panel-arbitration port, an
event indexer. None of these gate AI Season eligibility or the judging criteria (application of
AI, innovation, product completeness, user value, X Layer integration, growth potential,
ecosystem contribution) — they're legitimate future work once this kernel is proven live.
(Concurrency fuzzing for Exposure Conservation, EIP-712 signed policies, and ZK
`PolicyCredentialProof` — all three originally on this list — are now done, see §2/§7/§8.)

## 10. Submission — owned by the user, not this agent session

Per explicit instruction this session: **X account, video, and the Google Form are the user's own
responsibility**, not something to automate here. What this checklist owes that process:

- A working, testable, and now **live** story: kernel (§1) proven by 36 passing property/unit
  tests, contract (§2) proven by 20 passing Foundry tests (including a 256-run fuzz test and 6
  EIP-712 signature tests) AND deployed for real to X Layer testnet, MCP surface (§3) proven by 7
  passing tests, both demo scenarios (§4) actually run against that live deployment with real tx
  hashes for every step (§0.5) — including a real on-chain revert — a live, interactive,
  Playwright-verified demo webpage (§6) that needs no wallet at all to show the compiler actually
  working, and a genuine ZK circuit (§8) — real proof, real EVM pairing-precompile verification,
  real anti-correlation property — not a circuit that exists only as a plan-document description.
- The AI-RWA framing is not a stretch: `fetchUsTreasuryYield`/`fetchBtcUsdPrice` (real, live,
  keyless public APIs, not stubs) already feed both demo scripts' narrative context.
