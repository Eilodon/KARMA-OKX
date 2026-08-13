// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {KarmaPolicyEnforcer} from "../contracts/policy/KarmaPolicyEnforcer.sol";

/// @notice Directly covers `KARMA_OKX_MASTER_IMPLEMENTATION_PLAN.md`'s own Definition-of-Done
///         Scenario D (hard cap -> on-chain revert) and the Section CII rejection-code
///         vocabulary, plus the cumulative-exposure, expiry, and revocation paths.
contract KarmaPolicyEnforcerTest is Test {
    KarmaPolicyEnforcer internal enforcer;

    address internal alpha = address(0xA1); // principal
    address internal beta = address(0xB2); // subject/agent
    bytes32 internal constant ACTION_DIGEST = keccak256("BUY_TOKENIZED_TREASURY");
    bytes32 internal constant POLICY_HASH = keccak256("offchain-karma-policy-ir-commitment");

    function setUp() public {
        enforcer = new KarmaPolicyEnforcer();
    }

    function _policyId(uint64 nonce) internal view returns (bytes32) {
        return keccak256(
            abi.encode(block.chainid, address(enforcer), alpha, beta, ACTION_DIGEST, nonce, uint64(block.timestamp + 1 days))
        );
    }

    // ── EIP-712 signing helpers — mirrors OpenZeppelin's own EIP712._buildDomainSeparator /
    //    _hashTypedDataV4 exactly, so a bug here would show up as every signature test failing,
    //    not as a false sense of security from a helper that "agrees with itself." ─────────────
    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant POLICY_AUTHORIZATION_TYPEHASH = keccak256(
        "PolicyAuthorization(bytes32 policyId,address subject,bytes32 actionDigest,uint256 maxPerTransaction,uint256 maxCumulativeExposure,uint64 expiresAt,uint64 nonce,bytes32 policyHash)"
    );

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH, keccak256(bytes("KarmaPolicyEnforcer")), keccak256(bytes("1")), block.chainid, address(enforcer)
            )
        );
    }

    function _digest(KarmaPolicyEnforcer.PolicyAuthorization memory auth) internal view returns (bytes32) {
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
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
    }

    function _sign(uint256 signerPk, KarmaPolicyEnforcer.PolicyAuthorization memory auth) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, _digest(auth));
        return abi.encodePacked(r, s, v);
    }

    function _issue(bytes32 policyId, uint256 maxPerTx, uint256 maxCumulative, uint64 expiresAt, uint64 nonce) internal {
        vm.prank(alpha);
        enforcer.issuePolicy(policyId, beta, ACTION_DIGEST, maxPerTx, maxCumulative, expiresAt, nonce, POLICY_HASH);
    }

    // ── issuePolicy ──────────────────────────────────────────────────────────────────────────

    function test_IssuePolicy_Success() public {
        bytes32 policyId = _policyId(1);
        uint64 expiresAt = uint64(block.timestamp + 1 days);

        vm.expectEmit(true, true, true, true);
        emit KarmaPolicyEnforcer.PolicyIssued(policyId, alpha, beta, ACTION_DIGEST, 100, 500, expiresAt, 1, POLICY_HASH);
        _issue(policyId, 100, 500, expiresAt, 1);

        (
            address principal,
            address subject,
            bytes32 actionDigest,
            uint256 maxPerTransaction,
            uint256 maxCumulativeExposure,
            uint256 cumulativeSpent,
            ,
            uint64 expiresAtStored,
            ,
            bool revoked,
            bytes32 policyHash
        ) = enforcer.policies(policyId);

        assertEq(principal, alpha);
        assertEq(subject, beta);
        assertEq(actionDigest, ACTION_DIGEST);
        assertEq(maxPerTransaction, 100);
        assertEq(maxCumulativeExposure, 500);
        assertEq(cumulativeSpent, 0);
        assertEq(expiresAtStored, expiresAt);
        assertFalse(revoked);
        assertEq(policyHash, POLICY_HASH);
    }

    function test_IssuePolicy_RevertIfAlreadyExists() public {
        bytes32 policyId = _policyId(1);
        _issue(policyId, 100, 500, uint64(block.timestamp + 1 days), 1);

        vm.expectRevert(abi.encodeWithSelector(KarmaPolicyEnforcer.PolicyAlreadyExists.selector, policyId));
        _issue(policyId, 200, 900, uint64(block.timestamp + 1 days), 1);
    }

    function test_IssuePolicy_RevertIfExpiryNotInFuture() public {
        bytes32 policyId = _policyId(1);
        uint64 pastExpiry = uint64(block.timestamp);

        vm.expectRevert(abi.encodeWithSelector(KarmaPolicyEnforcer.InvalidExpiry.selector, policyId, pastExpiry, uint64(block.timestamp)));
        _issue(policyId, 100, 500, pastExpiry, 1);
    }

    // ── validateAndRecordExecution — the actual enforcement path ───────────────────────────────

    function test_ValidateAndRecordExecution_HappyPath_MultipleWithinCap() public {
        bytes32 policyId = _policyId(1);
        _issue(policyId, 100, 500, uint64(block.timestamp + 1 days), 1);

        vm.startPrank(beta);
        assertEq(enforcer.validateAndRecordExecution(policyId, 80), 80);
        assertEq(enforcer.validateAndRecordExecution(policyId, 90), 170);
        assertEq(enforcer.validateAndRecordExecution(policyId, 100), 270);
        vm.stopPrank();

        (,,,,, uint256 cumulativeSpent,,,,,) = enforcer.policies(policyId);
        assertEq(cumulativeSpent, 270);
    }

    /// @dev Master plan Section LXVII's killer-UX example, literally: "Attempt: 150 -> rejected,
    ///      reason: PER_TRANSACTION_LIMIT_EXCEEDED" — this is that revert, on-chain.
    function test_ValidateAndRecordExecution_RevertWhenPerTransactionCapExceeded() public {
        bytes32 policyId = _policyId(1);
        _issue(policyId, 100, 500, uint64(block.timestamp + 1 days), 1);

        vm.prank(beta);
        vm.expectRevert(abi.encodeWithSelector(KarmaPolicyEnforcer.PerTransactionLimitExceeded.selector, policyId, 150, 100));
        enforcer.validateAndRecordExecution(policyId, 150);
    }

    /// @dev Definition-of-Done Scenario E's sibling: two calls that individually pass the
    ///      per-transaction cap must still be blocked once their sum would exceed the cumulative
    ///      cap — the compiler's "Available = Limit - Reserved - Committed" invariant, enforced
    ///      here in its simplest (sequential, non-concurrent) form.
    function test_ValidateAndRecordExecution_RevertWhenCumulativeExposureExceeded() public {
        bytes32 policyId = _policyId(1);
        _issue(policyId, 100, 150, uint64(block.timestamp + 1 days), 1);

        vm.startPrank(beta);
        enforcer.validateAndRecordExecution(policyId, 100);
        vm.expectRevert(abi.encodeWithSelector(KarmaPolicyEnforcer.CumulativeExposureExceeded.selector, policyId, 180, 150));
        enforcer.validateAndRecordExecution(policyId, 80);
        vm.stopPrank();

        // The reverted attempt must not have partially recorded spend.
        (,,,,, uint256 cumulativeSpent,,,,,) = enforcer.policies(policyId);
        assertEq(cumulativeSpent, 100);
    }

    function test_ValidateAndRecordExecution_RevertWhenExpired() public {
        bytes32 policyId = _policyId(1);
        uint64 expiresAt = uint64(block.timestamp + 1 hours);
        _issue(policyId, 100, 500, expiresAt, 1);

        vm.warp(expiresAt + 1);
        vm.prank(beta);
        vm.expectRevert(abi.encodeWithSelector(KarmaPolicyEnforcer.PolicyExpired.selector, policyId, expiresAt, uint64(block.timestamp)));
        enforcer.validateAndRecordExecution(policyId, 10);
    }

    function test_ValidateAndRecordExecution_RevertWhenRevoked() public {
        bytes32 policyId = _policyId(1);
        _issue(policyId, 100, 500, uint64(block.timestamp + 1 days), 1);

        vm.prank(alpha);
        enforcer.revokePolicy(policyId);

        vm.prank(beta);
        vm.expectRevert(abi.encodeWithSelector(KarmaPolicyEnforcer.PolicyRevoked.selector, policyId));
        enforcer.validateAndRecordExecution(policyId, 10);
    }

    function test_ValidateAndRecordExecution_RevertWhenCallerIsNotSubject() public {
        bytes32 policyId = _policyId(1);
        _issue(policyId, 100, 500, uint64(block.timestamp + 1 days), 1);

        address impostor = address(0xBAD);
        vm.prank(impostor);
        vm.expectRevert(abi.encodeWithSelector(KarmaPolicyEnforcer.NotSubject.selector, policyId, impostor));
        enforcer.validateAndRecordExecution(policyId, 10);
    }

    function test_ValidateAndRecordExecution_RevertWhenPolicyNotFound() public {
        bytes32 neverIssued = keccak256("never-issued");
        vm.prank(beta);
        vm.expectRevert(abi.encodeWithSelector(KarmaPolicyEnforcer.PolicyNotFound.selector, neverIssued));
        enforcer.validateAndRecordExecution(neverIssued, 10);
    }

    // ── revokePolicy ─────────────────────────────────────────────────────────────────────────

    function test_RevokePolicy_RevertIfNotPrincipal() public {
        bytes32 policyId = _policyId(1);
        _issue(policyId, 100, 500, uint64(block.timestamp + 1 days), 1);

        vm.prank(beta); // subject, not principal
        vm.expectRevert(abi.encodeWithSelector(KarmaPolicyEnforcer.NotPrincipal.selector, policyId, beta));
        enforcer.revokePolicy(policyId);
    }

    function test_RevokePolicy_DoesNotRewriteAlreadyRecordedSpend() public {
        bytes32 policyId = _policyId(1);
        _issue(policyId, 100, 500, uint64(block.timestamp + 1 days), 1);

        vm.prank(beta);
        enforcer.validateAndRecordExecution(policyId, 60);

        vm.prank(alpha);
        enforcer.revokePolicy(policyId);

        // Section XCIII: "Pause execution != rewrite settlement" — spend already recorded stays.
        (,,,,, uint256 cumulativeSpent,,,, bool revoked,) = enforcer.policies(policyId);
        assertEq(cumulativeSpent, 60);
        assertTrue(revoked);
    }

    // ── Fuzz: Exposure Conservation (master plan Section XXVII/LXXVIII) ────────────────────────
    //
    // "Available = Limit - Reserved - Committed", asserted after every call across a random
    // sequence, not just hand-picked examples — this repo had zero Solidity fuzz tests before
    // this one (confirmed by a prior audit pass: none of the existing `test/*.t.sol` files
    // parameterize a test function, so Foundry's fuzzer never actually ran on any of them).
    // `maxPerTransaction` is set far above every fuzzed amount so this isolates the CUMULATIVE
    // cap specifically, not the per-tx cap already covered by
    // `test_ValidateAndRecordExecution_RevertWhenPerTransactionCapExceeded`.

    function testFuzz_CumulativeSpentNeverExceedsCapAcrossRandomSequence(uint256[12] memory rawAmounts) public {
        bytes32 policyId = _policyId(1);
        uint256 cap = 1_000;
        _issue(policyId, 1_000_000, cap, uint64(block.timestamp + 1 days), 1);

        uint256 accepted = 0;
        for (uint256 i = 0; i < rawAmounts.length; i++) {
            // Deliberately allow amounts both well under and well over the remaining headroom —
            // the fuzzer should hit both "clearly fine" and "clearly over" without being told.
            uint256 amount = bound(rawAmounts[i], 0, cap * 2);

            vm.prank(beta);
            if (accepted + amount > cap) {
                vm.expectRevert();
                enforcer.validateAndRecordExecution(policyId, amount);
                (,,,,, uint256 spentAfterRevert,,,,,) = enforcer.policies(policyId);
                assertEq(spentAfterRevert, accepted, "a reverted attempt must not move cumulativeSpent at all");
            } else {
                enforcer.validateAndRecordExecution(policyId, amount);
                accepted += amount;
                (,,,,, uint256 spentAfterAccept,,,,,) = enforcer.policies(policyId);
                assertEq(spentAfterAccept, accepted, "an accepted attempt must add exactly `amount`, no more, no less");
            }

            (,,,,, uint256 spentNow,,,,,) = enforcer.policies(policyId);
            assertLe(spentNow, cap, "cumulativeSpent must never exceed maxCumulativeExposure, at any point");
        }
    }

    /// @dev The "two concurrent reservations racing for the same budget" scenario (plan's own
    ///      worked example: "Parent remaining = 10. Child A wants 8. Child B wants 8. Không được:
    ///      A sees 10 -> okay. B sees 10 -> okay. mà tổng 16.") has no true concurrency on a
    ///      single EVM chain — a sequencer/miner always serializes transactions within a block,
    ///      so this test makes that guarantee explicit rather than assumed: two calls landing in
    ///      the SAME block (no `vm.roll`/`vm.warp` between them, which is Foundry's default) each
    ///      individually satisfy the per-tx cap, together would exceed the cumulative cap, and
    ///      the second one to execute correctly reverts against state the first one already
    ///      updated — exactly the atomicity a separate off-chain reservation ledger would have to
    ///      work much harder to guarantee.
    function test_TwoSameBlockAttempts_SecondSeesFirstsUpdatedState() public {
        bytes32 policyId = _policyId(1);
        _issue(policyId, 8, 10, uint64(block.timestamp + 1 days), 1);

        vm.prank(beta);
        enforcer.validateAndRecordExecution(policyId, 8); // Child A: within both caps.

        vm.prank(beta);
        vm.expectRevert(abi.encodeWithSelector(KarmaPolicyEnforcer.CumulativeExposureExceeded.selector, policyId, 16, 10));
        enforcer.validateAndRecordExecution(policyId, 8); // Child B: sees cumulativeSpent=8, not 0 — reverts, not 16.

        (,,,,, uint256 cumulativeSpent,,,,,) = enforcer.policies(policyId);
        assertEq(cumulativeSpent, 8, "only Child A's spend was ever recorded - no double-count");
    }

    // ── issuePolicyWithSignature (EIP-712) ──────────────────────────────────────────────────────

    uint256 internal constant SIGNER_PK = 0xA11CE;
    uint256 internal constant OTHER_PK = 0xB0B;

    function _authorization(bytes32 policyId, uint64 nonce, uint64 expiresAt) internal view returns (KarmaPolicyEnforcer.PolicyAuthorization memory) {
        return KarmaPolicyEnforcer.PolicyAuthorization({
            policyId: policyId,
            subject: beta,
            actionDigest: ACTION_DIGEST,
            maxPerTransaction: 100,
            maxCumulativeExposure: 500,
            expiresAt: expiresAt,
            nonce: nonce,
            policyHash: POLICY_HASH
        });
    }

    function test_IssuePolicyWithSignature_Success_PrincipalIsRecoveredSigner() public {
        address signerAddr = vm.addr(SIGNER_PK);
        uint64 expiresAt = uint64(block.timestamp + 1 days);
        bytes32 policyId = keccak256(abi.encode(block.chainid, address(enforcer), signerAddr, beta, ACTION_DIGEST, uint64(1), expiresAt));
        KarmaPolicyEnforcer.PolicyAuthorization memory auth = _authorization(policyId, 1, expiresAt);
        bytes memory sig = _sign(SIGNER_PK, auth);

        vm.expectEmit(true, true, true, true);
        emit KarmaPolicyEnforcer.PolicyIssued(policyId, signerAddr, beta, ACTION_DIGEST, 100, 500, expiresAt, 1, POLICY_HASH);
        address recoveredPrincipal = enforcer.issuePolicyWithSignature(auth, sig);

        assertEq(recoveredPrincipal, signerAddr, "recovered principal must be the actual signer");
        (address storedPrincipal,,,,,,,,,,) = enforcer.policies(policyId);
        assertEq(storedPrincipal, signerAddr);
    }

    /// @dev No key can forge another key's authority: signing the exact same authorization with a
    ///      DIFFERENT private key must recover to that key's own address, never to the address the
    ///      test "intended" — this is the entire security property EIP-712 signing exists to give.
    function test_IssuePolicyWithSignature_DifferentSignerRecoversDifferentPrincipal() public {
        address signerAddr = vm.addr(SIGNER_PK);
        address otherAddr = vm.addr(OTHER_PK);
        uint64 expiresAt = uint64(block.timestamp + 1 days);
        bytes32 policyId = keccak256(abi.encode(block.chainid, address(enforcer), otherAddr, beta, ACTION_DIGEST, uint64(1), expiresAt));
        KarmaPolicyEnforcer.PolicyAuthorization memory auth = _authorization(policyId, 1, expiresAt);

        bytes memory sigFromOther = _sign(OTHER_PK, auth);
        address recovered = enforcer.issuePolicyWithSignature(auth, sigFromOther);

        assertEq(recovered, otherAddr);
        assertNotEq(recovered, signerAddr);
    }

    /// @dev Submitting a signature alongside a TAMPERED authorization (any field changed after
    ///      signing) must not authenticate as the original signer — the recovered address changes
    ///      because the struct hash it's checked against changed, exactly like editing a paper
    ///      contract after it's been signed doesn't make the new terms signed too.
    function test_IssuePolicyWithSignature_TamperedFieldRecoversDifferentPrincipal() public {
        address signerAddr = vm.addr(SIGNER_PK);
        uint64 expiresAt = uint64(block.timestamp + 1 days);
        bytes32 policyId = keccak256(abi.encode(block.chainid, address(enforcer), signerAddr, beta, ACTION_DIGEST, uint64(1), expiresAt));
        KarmaPolicyEnforcer.PolicyAuthorization memory auth = _authorization(policyId, 1, expiresAt);
        bytes memory sig = _sign(SIGNER_PK, auth);

        // Attacker raises the cap after the signature was produced, keeping the same signature bytes.
        auth.maxPerTransaction = 100_000;
        address recovered = enforcer.issuePolicyWithSignature(auth, sig);
        assertNotEq(recovered, signerAddr, "a tampered authorization must not recover as the original signer");
    }

    function test_IssuePolicyWithSignature_RevertIfPolicyIdAlreadyUsed() public {
        address signerAddr = vm.addr(SIGNER_PK);
        uint64 expiresAt = uint64(block.timestamp + 1 days);
        bytes32 policyId = keccak256(abi.encode(block.chainid, address(enforcer), signerAddr, beta, ACTION_DIGEST, uint64(1), expiresAt));
        KarmaPolicyEnforcer.PolicyAuthorization memory auth = _authorization(policyId, 1, expiresAt);
        bytes memory sig = _sign(SIGNER_PK, auth);
        enforcer.issuePolicyWithSignature(auth, sig);

        vm.expectRevert(abi.encodeWithSelector(KarmaPolicyEnforcer.PolicyAlreadyExists.selector, policyId));
        enforcer.issuePolicyWithSignature(auth, sig);
    }

    function test_IssuePolicyWithSignature_RevertOnMalformedSignatureLength() public {
        uint64 expiresAt = uint64(block.timestamp + 1 days);
        KarmaPolicyEnforcer.PolicyAuthorization memory auth = _authorization(_policyId(1), 1, expiresAt);
        bytes memory garbage = hex"deadbeef";

        vm.expectRevert();
        enforcer.issuePolicyWithSignature(auth, garbage);
    }

    /// @dev A policy issued via signature is enforced identically to one issued directly — the
    ///      two entry points share `_storePolicy` and `validateAndRecordExecution` doesn't know or
    ///      care which one was used.
    function test_IssuePolicyWithSignature_IsFullyEnforcedAfterward() public {
        address signerAddr = vm.addr(SIGNER_PK);
        uint64 expiresAt = uint64(block.timestamp + 1 days);
        bytes32 policyId = keccak256(abi.encode(block.chainid, address(enforcer), signerAddr, beta, ACTION_DIGEST, uint64(1), expiresAt));
        KarmaPolicyEnforcer.PolicyAuthorization memory auth = _authorization(policyId, 1, expiresAt);
        enforcer.issuePolicyWithSignature(auth, _sign(SIGNER_PK, auth));

        vm.prank(beta);
        enforcer.validateAndRecordExecution(policyId, 80);

        vm.prank(beta);
        vm.expectRevert(abi.encodeWithSelector(KarmaPolicyEnforcer.PerTransactionLimitExceeded.selector, policyId, 150, 100));
        enforcer.validateAndRecordExecution(policyId, 150);
    }
}
