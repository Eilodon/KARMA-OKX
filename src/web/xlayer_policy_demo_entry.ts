/**
 * Browser entry point for `docs/media/xlayer_policy_demo.html` (AI Season build). Bundled to
 * `docs/media/xlayer_policy_demo.bundle.js` via `pnpm run build:xlayer-policy-demo-page`
 * (esbuild, browser target) — see that script in package.json.
 *
 * Runs the SAME deterministic compiler kernel (`compilePolicy`) the MCP tools and demo scripts
 * use — imported directly, not reimplemented — so `policyHash` is computed client-side, in the
 * viewer's own browser, with no server round-trip. Only the on-chain half (issue/execute against
 * `KarmaPolicyEnforcer`) needs a wallet: quoting terms works with zero wallet connection.
 *
 * Deliberately does NOT import `lib/xlayer.ts`/`lib/xlayer_policy.ts` — those read
 * `process.env.XLAYER_*`, which doesn't exist in a browser bundle. Chain interaction here uses
 * viem's `custom(window.ethereum)` transport instead (the connected wallet supplies its own RPC),
 * and `policy_rejection.ts` (pure, no env) for decoding reverts — same rejection-code vocabulary
 * `policy.tool.ts` uses server-side.
 */
import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  encodeAbiParameters,
  keccak256,
  toBytes,
  type Address,
} from "viem";
import { karmaPolicyEnforcerAbi } from "../lib/abi.js";
import { decodePolicyRejection } from "../lib/policy_rejection.js";
import { compilePolicy } from "../lib/trust/policy/compiler.js";
import { CONSERVATIVE_RWA_V1 } from "../lib/trust/policy/profiles.js";
import { explainRuleTrace } from "../lib/trust/policy/explain.js";
import { canonicalHash } from "../lib/canonical_hash.js";
import { LlmTaskRiskFieldsSchema, type TaskRiskIR } from "../lib/trust/risk/types.js";
import type { PrincipalEnvelope } from "../lib/trust/policy/ir.js";
import type { TrustEvidenceBundle } from "../lib/trust/evidence/types.js";
import type { RuleTraceEntry } from "../lib/trust/policy/compiler.js";
import type { KarmaPolicyIR } from "../lib/trust/policy/ir.js";

interface EthereumProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
}
declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

const XLAYER_TESTNET_CHAIN_ID = 1952;
const xLayerTestnet = defineChain({
  id: XLAYER_TESTNET_CHAIN_ID,
  name: "X Layer Testnet",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: { default: { http: ["https://testrpc.xlayer.tech"] } },
});

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`[xlayer-policy-demo] missing #${id} in page`);
  return found as T;
}

function setStatus(text: string): void {
  el<HTMLPreElement>("status").textContent = text;
}

const EVIDENCE_PRESETS = {
  alpha: { successfulJobs: 80, successfulSettledValueWei: "20000", adjudicatedFaults: 0 },
  beta: { successfulJobs: 0, successfulSettledValueWei: "0", adjudicatedFaults: 0 },
} as const;

const RISK_PRESETS = {
  lowRisk: {
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
  },
  highRisk: {
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
  },
} as const;

function loadEvidencePreset(name: keyof typeof EVIDENCE_PRESETS): void {
  const p = EVIDENCE_PRESETS[name];
  el<HTMLInputElement>("successful-jobs").value = String(p.successfulJobs);
  el<HTMLInputElement>("successful-settled-value").value = p.successfulSettledValueWei;
  el<HTMLInputElement>("adjudicated-faults").value = String(p.adjudicatedFaults);
}

function loadRiskPreset(name: keyof typeof RISK_PRESETS): void {
  el<HTMLTextAreaElement>("risk-json").value = JSON.stringify(RISK_PRESETS[name], null, 2);
}

let compiledPolicy: KarmaPolicyIR | null = null;
let previousCompiledPolicy: KarmaPolicyIR | null = null;
let lastPolicyId: `0x${string}` | null = null;

function readMandateForm() {
  const principal = el<HTMLInputElement>("principal-address").value.trim() as Address;
  const subject = el<HTMLInputElement>("subject-address").value.trim() as Address;
  const actionClass = el<HTMLInputElement>("action-class").value.trim();
  const allowedActions = el<HTMLInputElement>("allowed-actions").value.split(",").map((s) => s.trim()).filter(Boolean);
  const maxPerTransaction = BigInt(el<HTMLInputElement>("max-per-tx").value || "0");
  const maxCumulativeExposure = BigInt(el<HTMLInputElement>("max-cumulative").value || "0");
  const validUntilSecs = Number(el<HTMLInputElement>("valid-until-secs").value || "86400");
  const successfulJobs = Number(el<HTMLInputElement>("successful-jobs").value || "0");
  const successfulSettledValue = BigInt(el<HTMLInputElement>("successful-settled-value").value || "0");
  const adjudicatedFaults = Number(el<HTMLInputElement>("adjudicated-faults").value || "0");
  return {
    principal,
    subject,
    actionClass,
    allowedActions,
    maxPerTransaction,
    maxCumulativeExposure,
    validUntilSecs,
    successfulJobs,
    successfulSettledValue,
    adjudicatedFaults,
  };
}

function renderPolicy(policy: KarmaPolicyIR, ruleTrace: RuleTraceEntry[]): void {
  el<HTMLPreElement>("rule-trace").textContent = explainRuleTrace(ruleTrace);
  el<HTMLDivElement>("terms-card").innerHTML = `
    <div><strong>maxPerTransaction</strong>: ${policy.authority.maxPerTransaction}</div>
    <div><strong>maxCumulativeExposure</strong>: ${policy.authority.maxCumulativeExposure}</div>
    <div><strong>settlement.mode</strong>: ${policy.settlement.mode}</div>
    <div><strong>providerBondBps</strong>: ${policy.settlement.providerBondBps}</div>
    <div><strong>evaluation.mode</strong>: ${policy.evaluation.mode}</div>
    <div><strong>expiresAt</strong>: ${new Date(policy.validity.expiresAt).toISOString()}</div>
  `;
  el<HTMLDivElement>("policy-hash").textContent = policy.policyHash;

  if (previousCompiledPolicy && previousCompiledPolicy.subject === policy.subject) {
    el<HTMLDivElement>("terms-diff").innerHTML = `
      <table>
        <tr><th></th><th>previous quote</th><th>this quote</th></tr>
        <tr><td>maxPerTransaction</td><td>${previousCompiledPolicy.authority.maxPerTransaction}</td><td>${policy.authority.maxPerTransaction}</td></tr>
        <tr><td>maxCumulativeExposure</td><td>${previousCompiledPolicy.authority.maxCumulativeExposure}</td><td>${policy.authority.maxCumulativeExposure}</td></tr>
        <tr><td>providerBondBps</td><td>${previousCompiledPolicy.settlement.providerBondBps}</td><td>${policy.settlement.providerBondBps}</td></tr>
        <tr><td>evaluation.mode</td><td>${previousCompiledPolicy.evaluation.mode}</td><td>${policy.evaluation.mode}</td></tr>
      </table>
    `;
  }
}

function handleCompile(): void {
  try {
    const m = readMandateForm();
    if (!m.principal || !m.subject || !m.actionClass) {
      setStatus("Fill in principal, subject, and actionClass first.");
      return;
    }

    const riskRaw: unknown = JSON.parse(el<HTMLTextAreaElement>("risk-json").value);
    const parsedRisk = LlmTaskRiskFieldsSchema.safeParse(riskRaw);
    if (!parsedRisk.success) {
      setStatus(`Risk JSON invalid: ${parsedRisk.error.issues[0]?.message ?? "unknown error"}`);
      return;
    }
    const amountAtRisk = BigInt(el<HTMLInputElement>("amount-at-risk").value || "0");
    const expectedDurationSecs = Number(el<HTMLInputElement>("duration-secs").value || "86400");
    const risk: TaskRiskIR = { ...parsedRisk.data, amountAtRisk, expectedDurationSecs, source: "llm" };

    const economicHistory = {
      successfulSettledValue: m.successfulSettledValue,
      failedSettledValue: 0n,
      disputedValue: 0n,
      successfulJobs: m.successfulJobs,
      adjudicatedFaults: m.adjudicatedFaults,
      counterpartyCount: 0,
    };
    const evidence: TrustEvidenceBundle = {
      subject: m.subject,
      economicHistory,
      capital: { activeBond: 0n, historicalSlashedValue: 0n },
      evidenceLegs: [],
      snapshot: { snapshotId: `browser-${Date.now()}`, evidenceRoot: "0x" + canonicalHash(economicHistory), takenAt: Date.now() },
    };
    const principalEnvelope: PrincipalEnvelope = {
      principal: m.principal,
      subject: m.subject,
      allowedActions: m.allowedActions,
      maxPerTransaction: m.maxPerTransaction,
      maxCumulativeExposure: m.maxCumulativeExposure,
      delegationAllowed: true,
      validFrom: Date.now(),
      validUntil: Date.now() + m.validUntilSecs * 1_000,
    };
    const actionDigest = keccak256(toBytes(m.actionClass));

    const { policy, ruleTrace } = compilePolicy({
      evidence,
      risk,
      principalEnvelope,
      profile: CONSERVATIVE_RWA_V1,
      actionDigest,
      actionClass: m.actionClass,
      nonce: BigInt(Date.now()),
    });

    previousCompiledPolicy = compiledPolicy;
    compiledPolicy = policy;
    renderPolicy(policy, ruleTrace);
    setStatus(`Compiled in your browser — policyHash=${policy.policyHash}`);
  } catch (err) {
    setStatus(`Compile error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── On-chain: issue + execute against a deployed KarmaPolicyEnforcer ────────────────────────

let connectedAccount: Address | null = null;

async function connectWallet(): Promise<void> {
  if (!window.ethereum) {
    setStatus("No injected wallet found (install MetaMask or an EIP-1193 wallet).");
    return;
  }
  const accounts = (await window.ethereum.request({ method: "eth_requestAccounts" })) as string[];
  connectedAccount = accounts[0] as Address;
  el<HTMLDivElement>("connected").textContent = `Connected: ${connectedAccount}`;
  if (!el<HTMLInputElement>("principal-address").value) el<HTMLInputElement>("principal-address").value = connectedAccount;
}

async function addXLayerTestnetToWallet(): Promise<void> {
  if (!window.ethereum) {
    setStatus("No injected wallet found.");
    return;
  }
  try {
    await window.ethereum.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: "0x" + XLAYER_TESTNET_CHAIN_ID.toString(16),
          chainName: "X Layer Testnet",
          nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
          rpcUrls: ["https://testrpc.xlayer.tech"],
          blockExplorerUrls: ["https://www.oklink.com/xlayer-test"],
        },
      ],
    });
    setStatus("X Layer Testnet added (or already present) in your wallet.");
  } catch (err) {
    setStatus(`wallet_addEthereumChain failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function getClients() {
  if (!window.ethereum) throw new Error("no injected wallet");
  const transport = custom(window.ethereum);
  return {
    publicClient: createPublicClient({ chain: xLayerTestnet, transport }),
    walletClient: createWalletClient({ chain: xLayerTestnet, transport }),
  };
}

/** Client-side mirror of `xlayer_policy.ts`'s `computePolicyId` — same derivation (chainId,
 *  contract address, principal, subject, actionDigest, nonce, expiry), reimplemented here rather
 *  than imported because the server version pulls in `xlayer.ts`'s env-reading client
 *  singletons, which don't exist in a browser bundle. Both must stay in lockstep with
 *  `KarmaPolicyEnforcer.sol`'s `issuePolicy`'s "unused policyId" check — see that function's
 *  contract-header comment for the full domain-separation rationale. */
function computeClientPolicyId(p: {
  chainId: bigint;
  contract: Address;
  principal: Address;
  subject: Address;
  actionDigest: `0x${string}`;
  nonce: bigint;
  expiresAt: bigint;
}): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "bytes32" },
        { type: "uint64" },
        { type: "uint64" },
      ],
      [p.chainId, p.contract, p.principal, p.subject, p.actionDigest, p.nonce, p.expiresAt],
    ),
  );
}

async function handleIssuePolicy(): Promise<void> {
  if (!compiledPolicy) {
    setStatus("Compile a policy first.");
    return;
  }
  if (!connectedAccount) {
    setStatus("Connect a wallet first.");
    return;
  }
  const contractAddress = el<HTMLInputElement>("contract-address").value.trim() as Address;
  if (!contractAddress) {
    setStatus("Enter the deployed KarmaPolicyEnforcer address first.");
    return;
  }
  try {
    const { publicClient, walletClient } = getClients();
    const expiresAt = BigInt(Math.floor(compiledPolicy.validity.expiresAt / 1_000));
    const policyId = computeClientPolicyId({
      chainId: BigInt(XLAYER_TESTNET_CHAIN_ID),
      contract: contractAddress,
      principal: connectedAccount,
      subject: compiledPolicy.subject as Address,
      actionDigest: compiledPolicy.actionDigest as `0x${string}`,
      nonce: compiledPolicy.nonce,
      expiresAt,
    });

    setStatus(`Simulating issuePolicy (policyId=${policyId})...`);
    const { request } = await publicClient.simulateContract({
      address: contractAddress,
      abi: karmaPolicyEnforcerAbi,
      functionName: "issuePolicy",
      args: [
        policyId,
        compiledPolicy.subject,
        compiledPolicy.actionDigest,
        compiledPolicy.authority.maxPerTransaction,
        compiledPolicy.authority.maxCumulativeExposure,
        expiresAt,
        compiledPolicy.nonce,
        compiledPolicy.policyHash,
      ],
      account: connectedAccount,
    } as never);
    const hash = await walletClient.writeContract(request as never);
    lastPolicyId = policyId;
    el<HTMLInputElement>("policy-id-display").value = policyId;
    setStatus(`Issued. policyId=${policyId} tx=${hash}`);
  } catch (err) {
    setStatus(`Issue rejected: ${decodePolicyRejection(err)} (${err instanceof Error ? err.message : String(err)})`);
  }
}

async function handleAttemptExecution(): Promise<void> {
  const policyId = (el<HTMLInputElement>("policy-id-display").value.trim() || lastPolicyId) as `0x${string}` | null;
  if (!policyId) {
    setStatus("Issue a policy first (or paste a policyId).");
    return;
  }
  if (!connectedAccount) {
    setStatus("Connect a wallet first.");
    return;
  }
  const contractAddress = el<HTMLInputElement>("contract-address").value.trim() as Address;
  const amount = BigInt(el<HTMLInputElement>("attempt-amount").value || "0");
  try {
    const { publicClient, walletClient } = getClients();
    setStatus(`Simulating validateAndRecordExecution(amount=${amount})...`);
    const { request } = await publicClient.simulateContract({
      address: contractAddress,
      abi: karmaPolicyEnforcerAbi,
      functionName: "validateAndRecordExecution",
      args: [policyId, amount],
      account: connectedAccount,
    } as never);
    const hash = await walletClient.writeContract(request as never);
    setStatus(`Attempt(${amount}) -> PERMITTED. tx=${hash}`);
  } catch (err) {
    setStatus(`Attempt(${amount}) -> REJECTED. reason=${decodePolicyRejection(err)}`);
  }
}

function main(): void {
  el<HTMLButtonElement>("load-alpha").addEventListener("click", () => loadEvidencePreset("alpha"));
  el<HTMLButtonElement>("load-beta").addEventListener("click", () => loadEvidencePreset("beta"));
  el<HTMLButtonElement>("load-low-risk").addEventListener("click", () => loadRiskPreset("lowRisk"));
  el<HTMLButtonElement>("load-high-risk").addEventListener("click", () => loadRiskPreset("highRisk"));
  el<HTMLButtonElement>("compile-btn").addEventListener("click", handleCompile);
  el<HTMLButtonElement>("connect-wallet-btn").addEventListener("click", () => void connectWallet());
  el<HTMLButtonElement>("add-chain-btn").addEventListener("click", () => void addXLayerTestnetToWallet());
  el<HTMLButtonElement>("issue-policy-btn").addEventListener("click", () => void handleIssuePolicy());
  el<HTMLButtonElement>("attempt-btn").addEventListener("click", () => void handleAttemptExecution());

  loadEvidencePreset("alpha");
  loadRiskPreset("lowRisk");
  setStatus("Ready. \"Compile Policy\" runs entirely in your browser — no server, no chain call.");
}

main();
