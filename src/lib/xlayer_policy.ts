import { encodeAbiParameters, keccak256 } from "viem";
import type { Account, Address } from "viem";
import { karmaPolicyEnforcerAbi } from "./abi.js";
import { getPublicClient, getWalletClient } from "./xlayer.js";
import { runBoundedWrite, type WriteOutcome } from "./contract.js";

/**
 * X Layer read/write surface for KarmaPolicyEnforcer.sol (AI Season build) — a standalone
 * sidecar deployed next to AgentSkillRegistry, same convention xlayer_rationale.ts already
 * established for RationaleAttestation. Shares xlayer.ts's public/wallet client singletons —
 * same chain, same RPC — but reads its own env var for its own address since it's a distinct
 * deployment.
 */

/** Deployed KarmaPolicyEnforcer address on X Layer from env; throws if not yet deployed. */
export function getPolicyEnforcerAddress(): `0x${string}` {
  const addr = process.env.XLAYER_POLICY_ENFORCER_ADDRESS;
  if (!addr) {
    throw new Error(
      "[KARMA] XLAYER_POLICY_ENFORCER_ADDRESS not set — deploy KarmaPolicyEnforcer to X Layer " +
        "first (forge create contracts/policy/KarmaPolicyEnforcer.sol:KarmaPolicyEnforcer " +
        "--rpc-url $XLAYER_RPC_URL --private-key $KEY).",
    );
  }
  return addr as `0x${string}`;
}

function read<T>(functionName: string, args: readonly unknown[]): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  return getPublicClient().readContract({
    address: getPolicyEnforcerAddress(),
    abi: karmaPolicyEnforcerAbi,
    functionName,
    args,
  } as never) as Promise<T>;
}

const RECEIPT_TIMEOUT_MS = 300_000;

/** Bounded write against KarmaPolicyEnforcer — same broadcast-once/receipt-timeout policy as
 *  xlayer.ts's writeContractBounded (runBoundedWrite, shared so every X Layer contract in this
 *  repo has identical retry/idempotency semantics). Reverts (e.g. PerTransactionLimitExceeded)
 *  surface as a thrown error from `write` — callers that need the structured Section CII
 *  rejection code should catch and decode via `decodePolicyRejection` below. */
export async function writePolicyEnforcerBounded(
  account: Account,
  call: { functionName: string; args: readonly unknown[] },
  timeoutMs: number = RECEIPT_TIMEOUT_MS,
): Promise<WriteOutcome> {
  const publicClient = getPublicClient();
  const walletClient = getWalletClient(account);
  const address = getPolicyEnforcerAddress();
  return runBoundedWrite(
    {
      simulate: async () => {
        const { request } = await publicClient.simulateContract({
          address,
          abi: karmaPolicyEnforcerAbi,
          functionName: call.functionName,
          args: call.args,
          account,
        } as never);
        return { request };
      },
      write: (request) => walletClient.writeContract(request as never),
      waitReceipt: (hash, t) => publicClient.waitForTransactionReceipt({ hash, timeout: t }),
    },
    timeoutMs,
  );
}

/** Deterministic `policyId` derivation — binds chain, contract, principal, subject, action, nonce
 *  and expiry into the id itself, so `issuePolicy`'s "must be unused" check is what makes replay
 *  across any of those dimensions impossible (contract header comment, scope-cut #2). Every
 *  caller of `issuePolicy` should derive `policyId` this same way; the contract itself doesn't
 *  recompute or verify it — that would need the chainid/contract binding to be re-derivable
 *  on-chain too, which `address(this)`/`block.chainid` already give it implicitly by virtue of
 *  which deployment received the call. */
export function computePolicyId(p: {
  principal: Address;
  subject: Address;
  actionDigest: `0x${string}`;
  nonce: bigint;
  expiresAt: bigint;
}): `0x${string}` {
  const chainId = getPublicClient().chain?.id;
  if (chainId == null) throw new Error("[KARMA] cannot compute policyId: X Layer chain id unavailable");
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
      [BigInt(chainId), getPolicyEnforcerAddress(), p.principal, p.subject, p.actionDigest, p.nonce, p.expiresAt],
    ),
  );
}

export interface IssuePolicyParams {
  policyId: `0x${string}`;
  subject: Address;
  actionDigest: `0x${string}`;
  maxPerTransaction: bigint;
  maxCumulativeExposure: bigint;
  expiresAt: bigint;
  nonce: bigint;
  policyHash: `0x${string}`;
}

export function issuePolicy(account: Account, p: IssuePolicyParams): Promise<WriteOutcome> {
  return writePolicyEnforcerBounded(account, {
    functionName: "issuePolicy",
    args: [
      p.policyId,
      p.subject,
      p.actionDigest,
      p.maxPerTransaction,
      p.maxCumulativeExposure,
      p.expiresAt,
      p.nonce,
      p.policyHash,
    ],
  });
}

/** Mirrors `KarmaPolicyEnforcer.PolicyAuthorization` field-for-field — this IS the EIP-712 typed
 *  struct, not a loosely-related shape, so it can be passed directly as `signTypedData`'s
 *  `message` and as `issuePolicyWithSignature`'s `auth` tuple argument. */
export interface PolicyAuthorization {
  policyId: `0x${string}`;
  subject: Address;
  actionDigest: `0x${string}`;
  maxPerTransaction: bigint;
  maxCumulativeExposure: bigint;
  expiresAt: bigint;
  nonce: bigint;
  policyHash: `0x${string}`;
}

/** The exact EIP-712 domain `KarmaPolicyEnforcer`'s constructor registers
 *  (`EIP712("KarmaPolicyEnforcer", "1")`) plus this deployment's chain id/address — a signature
 *  produced against any other domain (wrong name/version/chainId/contract) recovers to a
 *  different address than the actual signer, per `ECDSA.recoverCalldata`'s own semantics, so
 *  getting this domain exactly right is what makes a signature "for this contract" at all. */
function policyAuthorizationDomain(chainId: number) {
  return {
    name: "KarmaPolicyEnforcer",
    version: "1",
    chainId,
    verifyingContract: getPolicyEnforcerAddress(),
  } as const;
}

const POLICY_AUTHORIZATION_TYPES = {
  PolicyAuthorization: [
    { name: "policyId", type: "bytes32" },
    { name: "subject", type: "address" },
    { name: "actionDigest", type: "bytes32" },
    { name: "maxPerTransaction", type: "uint256" },
    { name: "maxCumulativeExposure", type: "uint256" },
    { name: "expiresAt", type: "uint64" },
    { name: "nonce", type: "uint64" },
    { name: "policyHash", type: "bytes32" },
  ],
} as const;

/** Principal-side half of the signed-policy flow: produces an EIP-712 signature over `auth`
 *  that `issuePolicyWithSignature` (submitted by anyone — a relayer, the subject itself) will
 *  recover back to `account.address`. The principal never broadcasts a transaction or pays gas
 *  for this step. */
export async function signPolicyAuthorization(account: Account, auth: PolicyAuthorization): Promise<`0x${string}`> {
  const chainId = getPublicClient().chain?.id;
  if (chainId == null) throw new Error("[KARMA] cannot sign a policy authorization: X Layer chain id unavailable");
  const walletClient = getWalletClient(account);
  return walletClient.signTypedData({
    account,
    domain: policyAuthorizationDomain(chainId),
    types: POLICY_AUTHORIZATION_TYPES,
    primaryType: "PolicyAuthorization",
    message: auth,
  });
}

/** Executor-side half: anyone holding `auth` + a valid signature over it can submit this — the
 *  stored policy's `principal` is whoever `ECDSA.recoverCalldata` recovers from the signature,
 *  not `account`/`msg.sender`. */
export function issuePolicyWithSignature(
  account: Account,
  p: { auth: PolicyAuthorization; signature: `0x${string}` },
): Promise<WriteOutcome> {
  return writePolicyEnforcerBounded(account, {
    functionName: "issuePolicyWithSignature",
    args: [p.auth, p.signature],
  });
}

export function validateAndRecordExecution(
  account: Account,
  p: { policyId: `0x${string}`; amount: bigint },
): Promise<WriteOutcome> {
  return writePolicyEnforcerBounded(account, {
    functionName: "validateAndRecordExecution",
    args: [p.policyId, p.amount],
  });
}

export function revokePolicy(account: Account, policyId: `0x${string}`): Promise<WriteOutcome> {
  return writePolicyEnforcerBounded(account, { functionName: "revokePolicy", args: [policyId] });
}

export interface OnChainPolicy {
  principal: Address;
  subject: Address;
  actionDigest: `0x${string}`;
  maxPerTransaction: bigint;
  maxCumulativeExposure: bigint;
  cumulativeSpent: bigint;
  issuedAt: bigint;
  expiresAt: bigint;
  nonce: bigint;
  revoked: boolean;
  policyHash: `0x${string}`;
}

export async function getPolicy(policyId: `0x${string}`): Promise<OnChainPolicy> {
  const tuple = await read<
    [Address, Address, `0x${string}`, bigint, bigint, bigint, bigint, bigint, bigint, boolean, `0x${string}`]
  >("policies", [policyId]);
  const [
    principal,
    subject,
    actionDigest,
    maxPerTransaction,
    maxCumulativeExposure,
    cumulativeSpent,
    issuedAt,
    expiresAt,
    nonce,
    revoked,
    policyHash,
  ] = tuple;
  return {
    principal,
    subject,
    actionDigest,
    maxPerTransaction,
    maxCumulativeExposure,
    cumulativeSpent,
    issuedAt,
    expiresAt,
    nonce,
    revoked,
    policyHash,
  };
}

export const xLayerPolicyReads = { getPolicy };

// Rejection-code decoding is pure (no chain client, no env) and lives in policy_rejection.ts so
// docs/media/xlayer_policy_demo.html's browser bundle can import it without pulling this file's
// process.env-reading chain-client singletons into a browser build. Re-exported here so existing
// server-side callers (policy.tool.ts) don't need to change their import path.
export { decodePolicyRejection, type PolicyRejectionCode } from "./policy_rejection.js";
