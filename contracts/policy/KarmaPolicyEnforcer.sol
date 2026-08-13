// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title KarmaPolicyEnforcer — hard on-chain enforcement of a `KarmaPolicyIR` (AI Season build).
/// @notice A principal issues a policy (per-transaction cap, cumulative exposure cap, expiry) for
///         a subject/action; the subject's own calls to `validateAndRecordExecution` are the only
///         way spend against that policy is recorded, and they revert outright once a cap or the
///         expiry is hit. This is the actual product KARMA's architecture proposal is built
///         around: "Agent A thật sự không thể vượt các term này trên X Layer" — not a dashboard,
///         not an AI recommendation, a revert.
///
///         Deployed standalone next to `AgentSkillRegistry`/`RationaleAttestation` (same
///         additive-sidecar convention those use) rather than folding policy logic into either —
///         this contract has no dependency on the registry at all; the `KarmaPolicyIR` a policy
///         commits to is produced entirely off-chain (`src/lib/trust/policy/compiler.ts`).
///
///         One deliberate scope-cut for this build, documented rather than silently dropped:
///         this merges what the full architecture proposal calls `KarmaPolicyRegistry`
///         (commitment storage) and `KarmaPolicyEnforcer` (validation) into one contract.
///         Splitting them is a compatible follow-up once this is proven, not a rewrite.
///
///         Two ways to issue a policy, both landing in the same `policies` mapping and both
///         equally enforced by `validateAndRecordExecution` — the architecture proposal's own
///         Section XXII: "Hai model đều được." `issuePolicy` is direct on-chain issuance
///         (`msg.sender` IS the principal — no gas-less flow, but zero signature-verification
///         surface). `issuePolicyWithSignature` recovers the principal from an EIP-712
///         `PolicyAuthorization` signature instead (OpenZeppelin's `EIP712`/`ECDSA`, not a
///         hand-rolled digest — this is exactly the class of code not worth reimplementing), so
///         a principal can authorize a policy off-chain, for free, and let anyone (a relayer, the
///         subject itself) submit it — composable in the way the plan prefers, per Section XXII:
///         "Mình nghiêng về signed policy vì composable hơn."
///
///         Domain/replay separation holds two ways at once: the EIP-712 domain separator itself
///         (name/version/chainId/verifyingContract, built into `_hashTypedDataV4`) binds a
///         signature to this exact deployment, AND `policyId` — meant to be computed off-chain as
///         `keccak256(abi.encode(block.chainid, address(this), principal, subject, actionDigest,
///         nonce, expiresAt))` (see `src/lib/trust/policy/ir.ts` / `xlayer_policy.ts`) — is
///         required unused by both entry points before either accepts it. A policy literally
///         cannot be replayed onto a different chain, contract, principal, subject, action, or
///         nonce and still resolve to the same `policyId`.
contract KarmaPolicyEnforcer is EIP712 {
    struct Policy {
        address principal;
        address subject;
        bytes32 actionDigest;
        uint256 maxPerTransaction;
        uint256 maxCumulativeExposure;
        uint256 cumulativeSpent;
        uint64 issuedAt;
        uint64 expiresAt;
        uint64 nonce;
        bool revoked;
        /// @dev Commitment to the full off-chain `KarmaPolicyIR` this policy was compiled from —
        ///      not re-derived or checked on-chain; a verifier replays the compiler offline and
        ///      compares hashes (Section XLIX's `karma policy verify`), same non-equivocation
        ///      role `RationaleAttestation`'s `rationaleHash` plays for job rationale.
        bytes32 policyHash;
    }

    mapping(bytes32 => Policy) public policies;

    event PolicyIssued(
        bytes32 indexed policyId,
        address indexed principal,
        address indexed subject,
        bytes32 actionDigest,
        uint256 maxPerTransaction,
        uint256 maxCumulativeExposure,
        uint64 expiresAt,
        uint64 nonce,
        bytes32 policyHash
    );
    event PolicyExecuted(bytes32 indexed policyId, address indexed subject, uint256 amount, uint256 cumulativeSpent);
    event PolicyRevocation(bytes32 indexed policyId, address indexed principal);

    /// @dev Rejection codes match `KARMA_OKX_MASTER_IMPLEMENTATION_PLAN.md` Section CII's
    ///      structured rejection-telemetry vocabulary literally, so an MCP tool or demo UI can
    ///      surface the exact same code the plan specifies without a translation layer.
    error PolicyAlreadyExists(bytes32 policyId);
    error InvalidExpiry(bytes32 policyId, uint64 expiresAt, uint64 nowTs);
    error PolicyNotFound(bytes32 policyId);
    error PolicyExpired(bytes32 policyId, uint64 expiresAt, uint64 nowTs);
    error PolicyRevoked(bytes32 policyId);
    error NotSubject(bytes32 policyId, address caller);
    error NotPrincipal(bytes32 policyId, address caller);
    error PerTransactionLimitExceeded(bytes32 policyId, uint256 amount, uint256 maxPerTransaction);
    error CumulativeExposureExceeded(bytes32 policyId, uint256 attemptedTotal, uint256 maxCumulativeExposure);

    /// @dev Field order/types here ARE the EIP-712 type string below — keep them in lockstep.
    ///      `principal` is deliberately NOT a field: it's recovered from the signature itself,
    ///      the same way a checking account doesn't need to print its own owner's name on a
    ///      cheque for the signature to prove who wrote it.
    struct PolicyAuthorization {
        bytes32 policyId;
        address subject;
        bytes32 actionDigest;
        uint256 maxPerTransaction;
        uint256 maxCumulativeExposure;
        uint64 expiresAt;
        uint64 nonce;
        bytes32 policyHash;
    }

    bytes32 private constant POLICY_AUTHORIZATION_TYPEHASH = keccak256(
        "PolicyAuthorization(bytes32 policyId,address subject,bytes32 actionDigest,uint256 maxPerTransaction,uint256 maxCumulativeExposure,uint64 expiresAt,uint64 nonce,bytes32 policyHash)"
    );

    constructor() EIP712("KarmaPolicyEnforcer", "1") {}

    /// @notice Issue a new policy. `msg.sender` is the principal (direct issuance). Reverts if
    ///         `policyId` is already used, which is what makes replay across
    ///         chain/contract/principal/subject/action/nonce impossible as long as the caller
    ///         derives `policyId` the documented way.
    function issuePolicy(
        bytes32 policyId,
        address subject,
        bytes32 actionDigest,
        uint256 maxPerTransaction,
        uint256 maxCumulativeExposure,
        uint64 expiresAt,
        uint64 nonce,
        bytes32 policyHash
    ) external {
        _storePolicy(policyId, msg.sender, subject, actionDigest, maxPerTransaction, maxCumulativeExposure, expiresAt, nonce, policyHash);
    }

    /// @notice Issue a new policy on behalf of whichever address signed `auth` as an EIP-712
    ///         `PolicyAuthorization` — the principal never sends this transaction or pays its
    ///         gas; `msg.sender` here can be a relayer, the subject itself, or anyone holding a
    ///         validly-signed authorization. Reverts under the exact same `PolicyAlreadyExists`/
    ///         `InvalidExpiry` conditions as `issuePolicy`; an invalid/malformed signature reverts
    ///         with OpenZeppelin `ECDSA`'s own error (`ECDSAInvalidSignature` and friends), not a
    ///         silently-wrong recovered address.
    function issuePolicyWithSignature(
        PolicyAuthorization calldata auth,
        bytes calldata signature
    ) external returns (address principal) {
        bytes32 structHash = keccak256(
            abi.encode(
                POLICY_AUTHORIZATION_TYPEHASH,
                auth.policyId,
                auth.subject,
                auth.actionDigest,
                auth.maxPerTransaction,
                auth.maxCumulativeExposure,
                auth.expiresAt,
                auth.nonce,
                auth.policyHash
            )
        );
        principal = ECDSA.recoverCalldata(_hashTypedDataV4(structHash), signature);

        _storePolicy(
            auth.policyId,
            principal,
            auth.subject,
            auth.actionDigest,
            auth.maxPerTransaction,
            auth.maxCumulativeExposure,
            auth.expiresAt,
            auth.nonce,
            auth.policyHash
        );
    }

    function _storePolicy(
        bytes32 policyId,
        address principal,
        address subject,
        bytes32 actionDigest,
        uint256 maxPerTransaction,
        uint256 maxCumulativeExposure,
        uint64 expiresAt,
        uint64 nonce,
        bytes32 policyHash
    ) internal {
        if (policies[policyId].principal != address(0)) revert PolicyAlreadyExists(policyId);
        if (expiresAt <= block.timestamp) revert InvalidExpiry(policyId, expiresAt, uint64(block.timestamp));

        policies[policyId] = Policy({
            principal: principal,
            subject: subject,
            actionDigest: actionDigest,
            maxPerTransaction: maxPerTransaction,
            maxCumulativeExposure: maxCumulativeExposure,
            cumulativeSpent: 0,
            issuedAt: uint64(block.timestamp),
            expiresAt: expiresAt,
            nonce: nonce,
            revoked: false,
            policyHash: policyHash
        });

        emit PolicyIssued(
            policyId, principal, subject, actionDigest, maxPerTransaction, maxCumulativeExposure, expiresAt, nonce, policyHash
        );
    }

    /// @notice The enforcement point: `subject` calls this to record an economic action against
    ///         its policy. Reverts (does not silently clamp) on any cap/expiry/revocation
    ///         violation — the caller never spends more than the policy allows because the
    ///         transaction never lands. `amount` is whatever unit the off-chain `KarmaPolicyIR`
    ///         was compiled in (this contract makes no assumption about wei vs. an external
    ///         asset's decimals — the compiler and this call site must agree).
    function validateAndRecordExecution(bytes32 policyId, uint256 amount) external returns (uint256 newCumulativeSpent) {
        Policy storage policy = policies[policyId];
        if (policy.principal == address(0)) revert PolicyNotFound(policyId);
        if (policy.revoked) revert PolicyRevoked(policyId);
        if (block.timestamp > policy.expiresAt) {
            revert PolicyExpired(policyId, policy.expiresAt, uint64(block.timestamp));
        }
        if (msg.sender != policy.subject) revert NotSubject(policyId, msg.sender);
        if (amount > policy.maxPerTransaction) {
            revert PerTransactionLimitExceeded(policyId, amount, policy.maxPerTransaction);
        }

        newCumulativeSpent = policy.cumulativeSpent + amount;
        if (newCumulativeSpent > policy.maxCumulativeExposure) {
            revert CumulativeExposureExceeded(policyId, newCumulativeSpent, policy.maxCumulativeExposure);
        }

        policy.cumulativeSpent = newCumulativeSpent;
        emit PolicyExecuted(policyId, msg.sender, amount, newCumulativeSpent);
    }

    /// @notice Only the principal can revoke. Revocation blocks all future
    ///         `validateAndRecordExecution` calls; it does not (and cannot) undo spend already
    ///         recorded — matches the plan's Section XCIII: "Pause execution ≠ rewrite
    ///         settlement."
    function revokePolicy(bytes32 policyId) external {
        Policy storage policy = policies[policyId];
        if (policy.principal == address(0)) revert PolicyNotFound(policyId);
        if (msg.sender != policy.principal) revert NotPrincipal(policyId, msg.sender);
        policy.revoked = true;
        emit PolicyRevocation(policyId, msg.sender);
    }
}
