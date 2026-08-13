import { z } from "zod/v4";
import { keccak256, toBytes } from "viem";
import type { ToolDefinition, ToolResult } from "../mcp/adapter/tool_registry.js";
import { jsonSafe } from "../lib/serialize.js";
import { keystoreManager } from "../lib/keystore.js";
import { isTrustedRuntime } from "../core/runtime_identity.js";
import { canonicalHash } from "../lib/canonical_hash.js";
import { classifyTaskRisk, buildTaskRiskProviderFromEnv } from "../lib/trust/risk/classifier.js";
import { LlmTaskRiskFieldsSchema, conservativeFallbackRisk, type TaskRiskIR } from "../lib/trust/risk/types.js";
import { compilePolicy } from "../lib/trust/policy/compiler.js";
import { CONSERVATIVE_RWA_V1 } from "../lib/trust/policy/profiles.js";
import { explainRuleTrace } from "../lib/trust/policy/explain.js";
import type { PrincipalEnvelope } from "../lib/trust/policy/ir.js";
import type { TrustEvidenceBundle } from "../lib/trust/evidence/types.js";
import {
  issuePolicy as xlayerIssuePolicy,
  validateAndRecordExecution as xlayerValidateAndRecordExecution,
  computePolicyId,
  decodePolicyRejection,
} from "../lib/xlayer_policy.js";

/**
 * KARMA Policy tools (AI Season build) — the MCP surface for the Economic Trust Compiler,
 * per KARMA_OKX_MASTER_IMPLEMENTATION_PLAN.md Section LI-LVII, scoped to what this hackathon
 * build actually implements: classify -> quote -> issue -> execute. `karma_issue_policy` /
 * `karma_execute_with_policy` sign and broadcast on X Layer; `karma_classify_task_risk` /
 * `karma_quote_policy` are pure (no chain write), matching Section LIV: "Pure/deterministic.
 * Không ghi chain."
 *
 * MUST run in-process — same reasoning as rationale_attestation.tool.ts (this file follows that
 * file's flat-array-export convention, since it's the closest existing precedent for "a sidecar
 * X Layer contract's MCP tools", not karma.tool.ts's heavier DI-factory pattern): relies on the
 * in-process keystore singleton and the X Layer viem client singletons.
 */
function assertInProcess(): void {
  if (!isTrustedRuntime() || process.env.KARMA_PLUGIN_WORKER === "1") {
    throw new Error(
      "[KARMA] policy.tool.ts must run in the trusted in-process runtime, not the external " +
        "worker. Add it to isTrustedBuiltInPlugin() and MCP_PLUGIN_ALLOWLIST, and keep " +
        "MCP_PLUGIN_ISOLATION_MODE=policy.",
    );
  }
}

const PHASES = ["intake", "execution", "review", "completed"] as const;
const ADDRESS = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected a 0x address");
const HEX32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "expected 0x + 64 hex chars");
const WEI = z.string().regex(/^[0-9]+$/, "expected a base-10 wei string");
const DECIMAL = z.string().regex(/^[0-9]+$/, "expected a base-10 integer string");

const writeAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

function reply(text: string, structured: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], structuredContent: jsonSafe(structured) };
}

function requireSigner(agentId: string) {
  if (!keystoreManager.has(agentId)) {
    throw new Error(`[KARMA] Agent '${agentId}' not found in keystore. Run setup:keystore first.`);
  }
  return keystoreManager.getAccount(agentId);
}

// ── karma_classify_task_risk ────────────────────────────────────────────────────────────────

const classifyTaskRiskTool: ToolDefinition = {
  name: "karma_classify_task_risk",
  description:
    "AI risk classification stage of the Economic Trust Compiler (Section XI-XV): reduces a " +
    "natural-language obligation into structured TaskRiskIR. The task description is treated as " +
    "untrusted content, never an instruction. amountAtRiskWei/expectedDurationSecs are trusted " +
    "caller inputs — the model never sets them. On any classifier failure, malformed output, " +
    "internal inconsistency, or low confidence, returns a conservative fallback (never fail-open). " +
    "Pure — makes no chain read/write.",
  inputSchema: {
    taskDescription: z.string().min(1).max(4_000).describe("Untrusted, principal-authored obligation text."),
    amountAtRiskWei: WEI,
    expectedDurationSecs: z.number().int().positive().max(365 * 24 * 3_600),
  },
  capabilities: ["network"],
  allowedPhases: [...PHASES],
  annotations: { ...readAnnotations, openWorldHint: true },
  execution: { taskSupport: "forbidden" },
  handler: async (args) => {
    assertInProcess();
    const a = z
      .object({ taskDescription: z.string().min(1).max(4_000), amountAtRiskWei: WEI, expectedDurationSecs: z.number().int().positive() })
      .parse(args);

    const providerInfo = buildTaskRiskProviderFromEnv();
    const provider =
      providerInfo?.provider ??
      (async () => {
        throw new Error("no task-risk LLM provider configured (set ANTHROPIC_API_KEY)");
      });

    const result = await classifyTaskRisk(
      { taskDescription: a.taskDescription, amountAtRisk: BigInt(a.amountAtRiskWei), expectedDurationSecs: a.expectedDurationSecs },
      provider,
    );
    const taskRiskHash = "0x" + canonicalHash(result.risk);

    return reply(
      result.source === "llm"
        ? `[KARMA] task risk classified: externalSideEffects=${result.risk.externalSideEffects} custody=${result.risk.custodyRequired}`
        : `[KARMA] task risk classification fell back to conservative defaults: ${result.fallbackReason}`,
      { risk: jsonSafe(result.risk), source: result.source, fallbackReason: result.fallbackReason ?? null, taskRiskHash },
    );
  },
};

// ── karma_quote_policy ──────────────────────────────────────────────────────────────────────

const quoteRiskInput = LlmTaskRiskFieldsSchema.partial();

const quotePolicyTool: ToolDefinition = {
  name: "karma_quote_policy",
  description:
    "Deterministic compiler stage (Section XVI-XIX): intersects a principal's maximum authority, " +
    "the subject's earned-trust tier (from economic-history evidence), and task risk restrictions " +
    "into a KarmaPolicyIR with a reproducible policyHash and a rule trace. Pure — makes no chain " +
    "write; the result is a proposal the principal still has to authorize via karma_issue_policy. " +
    "Omitting `risk` compiles under the conservative fallback risk posture, not a permissive default.",
  inputSchema: {
    principal: ADDRESS,
    subject: ADDRESS,
    actionClass: z.string().min(1).max(64),
    allowedActionsCsv: z.string().min(1).describe("Comma-separated actionClasses the principal authorizes at all."),
    maxPerTransactionWei: WEI,
    maxCumulativeExposureWei: WEI,
    delegationAllowed: z.boolean().default(true),
    validUntilSecs: z.number().int().positive(),
    successfulJobs: z.number().int().min(0).default(0),
    successfulSettledValueWei: WEI.default("0"),
    adjudicatedFaults: z.number().int().min(0).default(0),
    amountAtRiskWei: WEI,
    expectedDurationSecs: z.number().int().positive(),
    risk: quoteRiskInput.optional().describe("Usually the `risk` object from karma_classify_task_risk's output."),
    nonce: DECIMAL,
  },
  capabilities: ["network"],
  allowedPhases: [...PHASES],
  annotations: { ...readAnnotations, openWorldHint: false },
  execution: { taskSupport: "forbidden" },
  handler: async (args) => {
    assertInProcess();
    const a = z
      .object({
        principal: ADDRESS,
        subject: ADDRESS,
        actionClass: z.string().min(1).max(64),
        allowedActionsCsv: z.string().min(1),
        maxPerTransactionWei: WEI,
        maxCumulativeExposureWei: WEI,
        delegationAllowed: z.boolean().default(true),
        validUntilSecs: z.number().int().positive(),
        successfulJobs: z.number().int().min(0).default(0),
        successfulSettledValueWei: WEI.default("0"),
        adjudicatedFaults: z.number().int().min(0).default(0),
        amountAtRiskWei: WEI,
        expectedDurationSecs: z.number().int().positive(),
        risk: quoteRiskInput.optional(),
        nonce: DECIMAL,
      })
      .parse(args);

    const principalEnvelope: PrincipalEnvelope = {
      principal: a.principal,
      subject: a.subject,
      allowedActions: a.allowedActionsCsv.split(",").map((s) => s.trim()).filter(Boolean),
      maxPerTransaction: BigInt(a.maxPerTransactionWei),
      maxCumulativeExposure: BigInt(a.maxCumulativeExposureWei),
      delegationAllowed: a.delegationAllowed,
      validFrom: Date.now(),
      validUntil: a.validUntilSecs * 1_000,
    };

    const economicHistory = {
      successfulSettledValue: BigInt(a.successfulSettledValueWei),
      failedSettledValue: 0n,
      disputedValue: 0n,
      successfulJobs: a.successfulJobs,
      adjudicatedFaults: a.adjudicatedFaults,
      counterpartyCount: 0,
    };
    const evidence: TrustEvidenceBundle = {
      subject: a.subject,
      economicHistory,
      capital: { activeBond: 0n, historicalSlashedValue: 0n },
      evidenceLegs: [],
      // Flat commitment over the evidence this quote was compiled from, not a Merkle tree
      // (Section LXII's per-leaf inclusion proofs are out of scope for this build — see
      // lib/trust/evidence/types.ts's EvidenceSnapshot doc comment).
      snapshot: { snapshotId: `mcp-quote-${Date.now()}`, evidenceRoot: "0x" + canonicalHash(economicHistory), takenAt: Date.now() },
    };

    const amountAtRisk = BigInt(a.amountAtRiskWei);
    const risk: TaskRiskIR = a.risk
      ? { ...(LlmTaskRiskFieldsSchema.parse(a.risk)), amountAtRisk, expectedDurationSecs: a.expectedDurationSecs, source: "llm" }
      : conservativeFallbackRisk({ amountAtRisk, expectedDurationSecs: a.expectedDurationSecs });

    const actionDigest = keccak256(toBytes(a.actionClass));
    const { policy, ruleTrace } = compilePolicy({
      evidence,
      risk,
      principalEnvelope,
      profile: CONSERVATIVE_RWA_V1,
      actionDigest,
      actionClass: a.actionClass,
      nonce: BigInt(a.nonce),
    });

    return reply(explainRuleTrace(ruleTrace), {
      policy: jsonSafe(policy),
      ruleTrace,
      explanation: explainRuleTrace(ruleTrace),
    });
  },
};

// ── karma_issue_policy ──────────────────────────────────────────────────────────────────────

const issuePolicyTool: ToolDefinition = {
  name: "karma_issue_policy",
  description:
    "Principal authorizes a quoted policy on X Layer (Section XXII: direct on-chain issuance — " +
    "see contracts/policy/KarmaPolicyEnforcer.sol's header for why this build uses direct " +
    "issuance rather than an EIP-712 signed policy). `agentId` must be the PRINCIPAL's keystore " +
    "agent, not the subject's. policyId is derived deterministically on this side from chain id, " +
    "the deployed contract address, principal, subject, actionClass, nonce and expiry — the same " +
    "inputs karma_quote_policy compiled the policy from, so re-issuing identical terms with the " +
    "same nonce reverts (PolicyAlreadyExists) instead of silently overwriting.",
  inputSchema: {
    agentId: z.string().describe("Principal's keystore agent id."),
    subject: ADDRESS,
    actionClass: z.string().min(1).max(64),
    maxPerTransactionWei: WEI,
    maxCumulativeExposureWei: WEI,
    expiresAtSecs: z.number().int().positive(),
    nonce: DECIMAL,
    policyHash: HEX32.describe("policyHash from karma_quote_policy's output."),
  },
  capabilities: ["network"],
  allowedPhases: [...PHASES],
  annotations: writeAnnotations,
  execution: { taskSupport: "forbidden" },
  handler: async (args) => {
    assertInProcess();
    const a = z
      .object({
        agentId: z.string(),
        subject: ADDRESS,
        actionClass: z.string().min(1).max(64),
        maxPerTransactionWei: WEI,
        maxCumulativeExposureWei: WEI,
        expiresAtSecs: z.number().int().positive(),
        nonce: DECIMAL,
        policyHash: HEX32,
      })
      .parse(args);

    const account = requireSigner(a.agentId);
    const actionDigest = keccak256(toBytes(a.actionClass));
    const nonce = BigInt(a.nonce);
    const expiresAt = BigInt(a.expiresAtSecs);
    const policyId = computePolicyId({ principal: account.address, subject: a.subject as `0x${string}`, actionDigest, nonce, expiresAt });

    try {
      const outcome = await xlayerIssuePolicy(account, {
        policyId,
        subject: a.subject as `0x${string}`,
        actionDigest,
        maxPerTransaction: BigInt(a.maxPerTransactionWei),
        maxCumulativeExposure: BigInt(a.maxCumulativeExposureWei),
        expiresAt,
        nonce,
        policyHash: a.policyHash as `0x${string}`,
      });
      return reply(`[KARMA] policy issued policyId=${policyId} tx=${outcome.hash}`, {
        status: "issued",
        policyId,
        txHash: outcome.hash,
      });
    } catch (err) {
      const reason = decodePolicyRejection(err);
      return reply(`[KARMA] karma_issue_policy rejected: ${reason}`, { status: "rejected", reason, policyId });
    }
  },
};

// ── karma_execute_with_policy ───────────────────────────────────────────────────────────────

const executeWithPolicyTool: ToolDefinition = {
  name: "karma_execute_with_policy",
  description:
    "The enforcement point (Section LXVII's 'killer UX', made real): the SUBJECT calls this to " +
    "record spend against an issued policy. Reverts do not fail this tool call silently — they " +
    "come back as a structured rejection reason (PER_TRANSACTION_LIMIT_EXCEEDED, " +
    "CUMULATIVE_EXPOSURE_EXCEEDED, POLICY_EXPIRED, POLICY_REVOKED, ...), matching Section CII's " +
    "rejection-code vocabulary literally, so a caller can show the same proof the plan describes: " +
    "'Attempt: 150 -> rejected, reason: PER_TRANSACTION_LIMIT_EXCEEDED'.",
  inputSchema: {
    agentId: z.string().describe("Subject's keystore agent id — must match the policy's subject address."),
    policyId: HEX32,
    amountWei: WEI,
  },
  capabilities: ["network"],
  allowedPhases: [...PHASES],
  annotations: writeAnnotations,
  execution: { taskSupport: "forbidden" },
  handler: async (args) => {
    assertInProcess();
    const a = z.object({ agentId: z.string(), policyId: HEX32, amountWei: WEI }).parse(args);
    const account = requireSigner(a.agentId);

    try {
      const outcome = await xlayerValidateAndRecordExecution(account, {
        policyId: a.policyId as `0x${string}`,
        amount: BigInt(a.amountWei),
      });
      return reply(`[KARMA] execution permitted: policyId=${a.policyId} amount=${a.amountWei} tx=${outcome.hash}`, {
        status: "permitted",
        policyId: a.policyId,
        txHash: outcome.hash,
      });
    } catch (err) {
      const reason = decodePolicyRejection(err);
      return reply(`[KARMA] execution rejected: policyId=${a.policyId} reason=${reason}`, {
        status: "rejected",
        policyId: a.policyId,
        reason,
      });
    }
  },
};

const policyTools: ToolDefinition[] = [classifyTaskRiskTool, quotePolicyTool, issuePolicyTool, executeWithPolicyTool];

export default policyTools;
