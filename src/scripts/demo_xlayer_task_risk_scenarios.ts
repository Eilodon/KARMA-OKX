/**
 * X Layer task-risk scenarios demo (AI Season build) — Definition-of-Done Scenario B from
 * KARMA_OKX_MASTER_IMPLEMENTATION_PLAN.md, arguably the more important of the two headline
 * demos (plan Section XLVII: "demo thứ hai còn quan trọng hơn"): the SAME subject, with the SAME
 * economic evidence, gets DIFFERENT KarmaPolicyIR terms depending on what it's being asked to do
 * — proof that KARMA underwrites the task/obligation, not a wallet score. Both policies are
 * issued for real on X Layer testnet so the terms-diff isn't just a console table.
 *
 * Prerequisites: same as demo_xlayer_policy_lifecycle.ts (KarmaPolicyEnforcer deployed,
 * XLAYER_POLICY_ENFORCER_ADDRESS set, PRIVATE_KEY funded).
 *
 * Run: PRIVATE_KEY=0x... XLAYER_POLICY_ENFORCER_ADDRESS=0x... pnpm exec tsx src/scripts/demo_xlayer_task_risk_scenarios.ts
 */

import { keccak256, toBytes } from "viem";
import { compilePolicy } from "../lib/trust/policy/compiler.js";
import { CONSERVATIVE_RWA_V1 } from "../lib/trust/policy/profiles.js";
import { explainRuleTrace } from "../lib/trust/policy/explain.js";
import type { PrincipalEnvelope } from "../lib/trust/policy/ir.js";
import type { TrustEvidenceBundle } from "../lib/trust/evidence/types.js";
import type { TaskRiskIR } from "../lib/trust/risk/types.js";
import { canonicalHash } from "../lib/canonical_hash.js";
import { issuePolicy, computePolicyId } from "../lib/xlayer_policy.js";
import { loadPrincipalAccount, generateSubjectAccount, fundSubject, DEMO_SUBJECT_GAS_WEI } from "./xlayer_policy_demo_shared.js";

const TASK_A_ACTION = "REBALANCE_TREASURY";
const TASK_B_ACTION = "SUBCONTRACT_EXTERNAL_TRANSFER";
const PRINCIPAL_MAX_PER_TX = 100n;
const PRINCIPAL_MAX_CUMULATIVE = 500n;

const TASK_A_LOW_RISK: TaskRiskIR = {
  actionClass: "REBALANCE",
  assetClass: "RWA",
  capitalMovement: true,
  custodyRequired: false,
  externalTransfer: false,
  reversible: "FULL",
  delegationRequired: false,
  externalSideEffects: "LOW",
  counterpartyDependency: "LOW",
  dataSensitivity: "PUBLIC",
  semanticFlags: ["limited-custody-rebalance"],
  classificationConfidence: 0.95,
  amountAtRisk: PRINCIPAL_MAX_PER_TX,
  expectedDurationSecs: 86_400,
  source: "llm",
};

const TASK_B_HIGH_RISK: TaskRiskIR = {
  actionClass: "SUBCONTRACT",
  assetClass: "RWA",
  capitalMovement: true,
  custodyRequired: true,
  externalTransfer: true,
  reversible: "NONE",
  delegationRequired: true,
  externalSideEffects: "HIGH",
  counterpartyDependency: "HIGH",
  dataSensitivity: "RESTRICTED",
  semanticFlags: ["external-transfer", "subcontract"],
  classificationConfidence: 0.9,
  amountAtRisk: PRINCIPAL_MAX_PER_TX,
  expectedDurationSecs: 86_400,
  source: "llm",
};

function strongEvidenceFor(subject: `0x${string}`): TrustEvidenceBundle {
  const economicHistory = {
    successfulSettledValue: 20_000n,
    failedSettledValue: 0n,
    disputedValue: 0n,
    successfulJobs: 80,
    adjudicatedFaults: 0,
    counterpartyCount: 12,
  };
  return {
    subject,
    economicHistory,
    capital: { activeBond: 0n, historicalSlashedValue: 0n },
    evidenceLegs: [],
    snapshot: { snapshotId: "demo-alpha-task-risk", evidenceRoot: "0x" + canonicalHash(economicHistory), takenAt: Date.now() },
  };
}

async function main() {
  const principal = loadPrincipalAccount();
  const alpha = generateSubjectAccount();
  console.log(`[xlayer-task-risk-demo] principal=${principal.address}`);
  console.log(`[xlayer-task-risk-demo] alpha (same subject, both tasks)=${alpha.address}`);

  await fundSubject(principal, alpha.address, DEMO_SUBJECT_GAS_WEI);

  const evidence = strongEvidenceFor(alpha.address);
  const results: Record<string, unknown> = {};

  for (const [label, actionClass, risk] of [
    ["taskA_lowRisk_rebalance", TASK_A_ACTION, TASK_A_LOW_RISK],
    ["taskB_highRisk_custodyExternalTransfer", TASK_B_ACTION, TASK_B_HIGH_RISK],
  ] as const) {
    const actionDigest = keccak256(toBytes(actionClass));
    const principalEnvelope: PrincipalEnvelope = {
      principal: principal.address,
      subject: alpha.address,
      allowedActions: [TASK_A_ACTION, TASK_B_ACTION],
      maxPerTransaction: PRINCIPAL_MAX_PER_TX,
      maxCumulativeExposure: PRINCIPAL_MAX_CUMULATIVE,
      delegationAllowed: true,
      validFrom: Date.now(),
      validUntil: Date.now() + 86_400_000,
    };

    const { policy, ruleTrace } = compilePolicy({
      evidence,
      risk,
      principalEnvelope,
      profile: CONSERVATIVE_RWA_V1,
      actionDigest,
      actionClass,
      nonce: 1n,
    });

    console.log(`\n── ${label} ──`);
    console.log(explainRuleTrace(ruleTrace));

    const expiresAt = BigInt(Math.floor(policy.validity.expiresAt / 1_000));
    const policyId = computePolicyId({ principal: principal.address, subject: alpha.address, actionDigest, nonce: 1n, expiresAt });
    const outcome = await issuePolicy(principal, {
      policyId,
      subject: alpha.address,
      actionDigest,
      maxPerTransaction: policy.authority.maxPerTransaction,
      maxCumulativeExposure: policy.authority.maxCumulativeExposure,
      expiresAt,
      nonce: 1n,
      policyHash: policy.policyHash as `0x${string}`,
    });
    console.log(`issued policyId=${policyId} tx=${outcome.hash}`);

    results[label] = { policyId, issueTx: outcome.hash, terms: policy.authority, settlement: policy.settlement, evaluation: policy.evaluation };
  }

  console.log("\n── TERMS DIFF (same subject, same evidence, different obligation) ──");
  console.log(
    JSON.stringify(
      {
        subject: alpha.address,
        principalMaximum: { maxPerTransaction: PRINCIPAL_MAX_PER_TX.toString(), maxCumulativeExposure: PRINCIPAL_MAX_CUMULATIVE.toString() },
        ...results,
      },
      (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v),
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
