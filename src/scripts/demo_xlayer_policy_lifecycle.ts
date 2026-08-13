/**
 * X Layer policy lifecycle demo (AI Season build) — Definition-of-Done Scenario A + D from
 * KARMA_OKX_MASTER_IMPLEMENTATION_PLAN.md: two subjects with different economic evidence get
 * different KarmaPolicyIR terms for the SAME RWA task, both policies are issued for real on X
 * Layer testnet, and the weaker subject's over-cap attempt reverts on-chain — not a simulated
 * revert, an actual `PerTransactionLimitExceeded` from `KarmaPolicyEnforcer.validateAndRecordExecution`.
 *
 * Prerequisites:
 *   - KarmaPolicyEnforcer deployed to X Layer testnet, XLAYER_POLICY_ENFORCER_ADDRESS set
 *     (forge create contracts/policy/KarmaPolicyEnforcer.sol:KarmaPolicyEnforcer
 *      --rpc-url $XLAYER_RPC_URL --private-key $KEY)
 *   - PRIVATE_KEY set to a funded X Layer testnet key (https://web3.okx.com/xlayer/faucet) —
 *     this account plays the principal AND funds two ephemeral subject keypairs with gas.
 *
 * Run: PRIVATE_KEY=0x... XLAYER_POLICY_ENFORCER_ADDRESS=0x... pnpm exec tsx src/scripts/demo_xlayer_policy_lifecycle.ts
 */

import { compilePolicy } from "../lib/trust/policy/compiler.js";
import { CONSERVATIVE_RWA_V1 } from "../lib/trust/policy/profiles.js";
import { explainRuleTrace } from "../lib/trust/policy/explain.js";
import type { PrincipalEnvelope } from "../lib/trust/policy/ir.js";
import type { TrustEvidenceBundle } from "../lib/trust/evidence/types.js";
import type { TaskRiskIR } from "../lib/trust/risk/types.js";
import { canonicalHash } from "../lib/canonical_hash.js";
import { fetchUsTreasuryYield } from "../lib/rwa/price_feed.js";
import {
  issuePolicy,
  validateAndRecordExecution,
  computePolicyId,
  decodePolicyRejection,
} from "../lib/xlayer_policy.js";
import { loadPrincipalAccount, generateSubjectAccount, fundSubject, DEMO_SUBJECT_GAS_WEI } from "./xlayer_policy_demo_shared.js";
import { keccak256, toBytes } from "viem";

const ACTION_CLASS = "BUY_TOKENIZED_TREASURY";
const PRINCIPAL_MAX_PER_TX = 100n;
const PRINCIPAL_MAX_CUMULATIVE = 500n;

function evidenceFor(profile: "strong" | "thin", subject: `0x${string}`): TrustEvidenceBundle {
  const economicHistory =
    profile === "strong"
      ? { successfulSettledValue: 20_000n, failedSettledValue: 0n, disputedValue: 0n, successfulJobs: 80, adjudicatedFaults: 0, counterpartyCount: 12 }
      : { successfulSettledValue: 0n, failedSettledValue: 0n, disputedValue: 0n, successfulJobs: 0, adjudicatedFaults: 0, counterpartyCount: 0 };
  return {
    subject,
    economicHistory,
    capital: { activeBond: 0n, historicalSlashedValue: 0n },
    evidenceLegs: [],
    snapshot: { snapshotId: `demo-${profile}`, evidenceRoot: "0x" + canonicalHash(economicHistory), takenAt: Date.now() },
  };
}

const LOW_RISK_TASK: Omit<TaskRiskIR, "amountAtRisk" | "expectedDurationSecs"> = {
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
  classificationConfidence: 0.95,
  source: "llm",
};

async function main() {
  const principal = loadPrincipalAccount();
  console.log(`[xlayer-policy-demo] principal=${principal.address}`);

  const yieldQuote = await fetchUsTreasuryYield();
  console.log(`[xlayer-policy-demo] live RWA context: ${yieldQuote.feed}=${yieldQuote.price}% (source=${yieldQuote.source})`);

  const alpha = generateSubjectAccount();
  const beta = generateSubjectAccount();
  console.log(`[xlayer-policy-demo] alpha (strong evidence)=${alpha.address}`);
  console.log(`[xlayer-policy-demo] beta  (thin evidence)  =${beta.address}`);

  await fundSubject(principal, alpha.address, DEMO_SUBJECT_GAS_WEI);
  await fundSubject(principal, beta.address, DEMO_SUBJECT_GAS_WEI);

  const actionDigest = keccak256(toBytes(ACTION_CLASS));
  const risk: TaskRiskIR = { ...LOW_RISK_TASK, amountAtRisk: PRINCIPAL_MAX_PER_TX, expectedDurationSecs: 86_400 };

  const results: Record<string, unknown> = {};

  for (const [label, account, profile] of [
    ["alpha", alpha, "strong"],
    ["beta", beta, "thin"],
  ] as const) {
    const principalEnvelope: PrincipalEnvelope = {
      principal: principal.address,
      subject: account.address,
      allowedActions: [ACTION_CLASS],
      maxPerTransaction: PRINCIPAL_MAX_PER_TX,
      maxCumulativeExposure: PRINCIPAL_MAX_CUMULATIVE,
      delegationAllowed: true,
      validFrom: Date.now(),
      validUntil: Date.now() + 86_400_000,
    };

    const { policy, ruleTrace } = compilePolicy({
      evidence: evidenceFor(profile, account.address),
      risk,
      principalEnvelope,
      profile: CONSERVATIVE_RWA_V1,
      actionDigest,
      actionClass: ACTION_CLASS,
      nonce: 1n,
    });

    console.log(`\n── ${label} (${profile} evidence) ──`);
    console.log(explainRuleTrace(ruleTrace));
    console.log(
      `terms: maxPerTx=${policy.authority.maxPerTransaction} maxCumulative=${policy.authority.maxCumulativeExposure} ` +
        `bond=${policy.settlement.providerBondBps}bps evaluator=${policy.evaluation.mode}`,
    );

    const expiresAt = BigInt(Math.floor(policy.validity.expiresAt / 1_000));
    const policyId = computePolicyId({ principal: principal.address, subject: account.address, actionDigest, nonce: 1n, expiresAt });

    const issueOutcome = await issuePolicy(principal, {
      policyId,
      subject: account.address,
      actionDigest,
      maxPerTransaction: policy.authority.maxPerTransaction,
      maxCumulativeExposure: policy.authority.maxCumulativeExposure,
      expiresAt,
      nonce: 1n,
      policyHash: policy.policyHash as `0x${string}`,
    });
    console.log(`issued policyId=${policyId} tx=${issueOutcome.hash}`);

    results[label] = { policyId, issueTx: issueOutcome.hash, terms: policy.authority, attempts: [] as unknown[] };
  }

  // Alpha attempts within cap -> permitted (real on-chain acceptance).
  const alphaExpiresAt = BigInt(Math.floor((Date.now() + 86_400_000) / 1_000));
  const alphaPolicyId = computePolicyId({ principal: principal.address, subject: alpha.address, actionDigest, nonce: 1n, expiresAt: alphaExpiresAt });
  try {
    const outcome = await validateAndRecordExecution(alpha, { policyId: alphaPolicyId, amount: 80n });
    console.log(`\nalpha attempt(80) -> permitted, tx=${outcome.hash}`);
    (results.alpha as { attempts: unknown[] }).attempts.push({ amount: "80", status: "permitted", tx: outcome.hash });
  } catch (err) {
    const reason = decodePolicyRejection(err);
    console.log(`\nalpha attempt(80) -> unexpectedly rejected: ${reason}`);
    (results.alpha as { attempts: unknown[] }).attempts.push({ amount: "80", status: "rejected", reason });
  }

  // Beta attempts OVER its (heavily reduced, thin-evidence) per-transaction cap -> on-chain revert.
  // This is Scenario D, literally: "Beta calls execute(25). Revert."
  const betaExpiresAt = alphaExpiresAt;
  const betaPolicyId = computePolicyId({ principal: principal.address, subject: beta.address, actionDigest, nonce: 1n, expiresAt: betaExpiresAt });
  try {
    const outcome = await validateAndRecordExecution(beta, { policyId: betaPolicyId, amount: 25n });
    console.log(`\nbeta attempt(25) -> unexpectedly permitted, tx=${outcome.hash}`);
    (results.beta as { attempts: unknown[] }).attempts.push({ amount: "25", status: "permitted", tx: outcome.hash });
  } catch (err) {
    const reason = decodePolicyRejection(err);
    console.log(`\nbeta attempt(25) -> rejected, reason=${reason} (expected PER_TRANSACTION_LIMIT_EXCEEDED)`);
    (results.beta as { attempts: unknown[] }).attempts.push({ amount: "25", status: "rejected", reason });
  }

  console.log("\n" + JSON.stringify(results, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
