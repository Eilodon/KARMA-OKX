import { describe, it, expect, beforeEach, afterEach } from "vitest";
import policyTools from "../plugins/policy.tool.js";
import type { ToolDefinition } from "../mcp/adapter/tool_registry.js";
import { markTrustedRuntime } from "../core/runtime_identity.js";

const find = (tools: ToolDefinition[], name: string) => tools.find((t) => t.name === name)!;

const ENV_KEYS = ["ANTHROPIC_API_KEY", "XLAYER_CONTRACT_ADDRESS", "XLAYER_POLICY_ENFORCER_ADDRESS"] as const;

describe("policy.tool.ts — Economic Trust Compiler MCP surface (AI Season)", () => {
  const ORIGINAL: Record<string, string | undefined> = {};

  beforeEach(() => {
    markTrustedRuntime();
    for (const k of ENV_KEYS) {
      ORIGINAL[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (ORIGINAL[k] === undefined) delete process.env[k];
      else process.env[k] = ORIGINAL[k];
    }
  });

  it("registers all four tools with the expected metadata", () => {
    expect(policyTools.map((t) => t.name).sort()).toEqual([
      "karma_classify_task_risk",
      "karma_execute_with_policy",
      "karma_issue_policy",
      "karma_quote_policy",
    ]);
    expect(find(policyTools, "karma_classify_task_risk").annotations.readOnlyHint).toBe(true);
    expect(find(policyTools, "karma_quote_policy").annotations.readOnlyHint).toBe(true);
    expect(find(policyTools, "karma_issue_policy").annotations.readOnlyHint).toBe(false);
    expect(find(policyTools, "karma_execute_with_policy").annotations.readOnlyHint).toBe(false);
  });

  describe("karma_classify_task_risk", () => {
    it("falls back conservatively when no LLM provider is configured (no ANTHROPIC_API_KEY)", async () => {
      const result = await find(policyTools, "karma_classify_task_risk").handler(
        { taskDescription: "Rebalance the tokenized Treasury book.", amountAtRiskWei: "100", expectedDurationSecs: 3_600 },
        {} as never,
      );
      const structured = result.structuredContent as { source: string; risk: { externalSideEffects: string; custodyRequired: boolean } };
      expect(structured.source).toBe("llm_fallback");
      expect(structured.risk.externalSideEffects).toBe("HIGH");
      expect(structured.risk.custodyRequired).toBe(true);
    });
  });

  describe("karma_quote_policy", () => {
    it("compiles a KarmaPolicyIR whose caps never exceed the principal envelope", async () => {
      const result = await find(policyTools, "karma_quote_policy").handler(
        {
          principal: "0x" + "11".repeat(20),
          subject: "0x" + "22".repeat(20),
          actionClass: "BUY",
          allowedActionsCsv: "BUY,REBALANCE",
          maxPerTransactionWei: "500",
          maxCumulativeExposureWei: "2000",
          validUntilSecs: Math.floor(Date.now() / 1_000) + 86_400,
          amountAtRiskWei: "100",
          expectedDurationSecs: 3_600,
          nonce: "1",
        },
        {} as never,
      );
      const structured = result.structuredContent as {
        policy: { authority: { maxPerTransaction: string; maxCumulativeExposure: string } };
        ruleTrace: Array<{ ruleId: string }>;
      };
      expect(BigInt(structured.policy.authority.maxPerTransaction)).toBeLessThanOrEqual(500n);
      expect(BigInt(structured.policy.authority.maxCumulativeExposure)).toBeLessThanOrEqual(2_000n);
      expect(structured.ruleTrace.length).toBeGreaterThan(0);
    });

    it("omitting `risk` compiles under the conservative fallback, not a permissive default", async () => {
      const args = {
        principal: "0x" + "11".repeat(20),
        subject: "0x" + "22".repeat(20),
        actionClass: "BUY",
        allowedActionsCsv: "BUY",
        maxPerTransactionWei: "1000",
        maxCumulativeExposureWei: "1000",
        validUntilSecs: Math.floor(Date.now() / 1_000) + 86_400,
        successfulJobs: 500,
        successfulSettledValueWei: "1000000",
        amountAtRiskWei: "100",
        expectedDurationSecs: 3_600,
        nonce: "1",
      };
      const withoutRisk = await find(policyTools, "karma_quote_policy").handler(args, {} as never);
      const withLowRisk = await find(policyTools, "karma_quote_policy").handler(
        {
          ...args,
          risk: {
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
          },
        },
        {} as never,
      );
      const capWithout = BigInt((withoutRisk.structuredContent as { policy: { authority: { maxPerTransaction: string } } }).policy.authority.maxPerTransaction);
      const capWithLow = BigInt((withLowRisk.structuredContent as { policy: { authority: { maxPerTransaction: string } } }).policy.authority.maxPerTransaction);
      expect(capWithout).toBeLessThan(capWithLow);
    });

    it("action outside allowedActionsCsv collapses authority to zero", async () => {
      const result = await find(policyTools, "karma_quote_policy").handler(
        {
          principal: "0x" + "11".repeat(20),
          subject: "0x" + "22".repeat(20),
          actionClass: "TRANSFER",
          allowedActionsCsv: "BUY",
          maxPerTransactionWei: "500",
          maxCumulativeExposureWei: "2000",
          validUntilSecs: Math.floor(Date.now() / 1_000) + 86_400,
          amountAtRiskWei: "100",
          expectedDurationSecs: 3_600,
          nonce: "1",
        },
        {} as never,
      );
      const structured = result.structuredContent as { policy: { authority: { maxPerTransaction: string; maxCumulativeExposure: string } } };
      expect(structured.policy.authority.maxPerTransaction).toBe("0");
      expect(structured.policy.authority.maxCumulativeExposure).toBe("0");
    });
  });

  describe("karma_issue_policy / karma_execute_with_policy", () => {
    it("karma_issue_policy rejects an unknown agentId before touching the network", async () => {
      await expect(
        find(policyTools, "karma_issue_policy").handler(
          {
            agentId: "nobody",
            subject: "0x" + "22".repeat(20),
            actionClass: "BUY",
            maxPerTransactionWei: "100",
            maxCumulativeExposureWei: "500",
            expiresAtSecs: Math.floor(Date.now() / 1_000) + 86_400,
            nonce: "1",
            policyHash: "0x" + "ab".repeat(32),
          },
          {} as never,
        ),
      ).rejects.toThrow(/not found in keystore/);
    });

    it("karma_execute_with_policy rejects an unknown agentId before touching the network", async () => {
      await expect(
        find(policyTools, "karma_execute_with_policy").handler(
          { agentId: "nobody", policyId: "0x" + "cd".repeat(32), amountWei: "10" },
          {} as never,
        ),
      ).rejects.toThrow(/not found in keystore/);
    });
  });
});
