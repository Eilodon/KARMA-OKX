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
}
