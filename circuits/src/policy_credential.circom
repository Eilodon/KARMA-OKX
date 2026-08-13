pragma circom 2.1.0;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/comparators.circom";
include "../node_modules/circomlib/circuits/mux1.circom";
include "../node_modules/circomlib/circuits/bitify.circom";

// PolicyCredentialProof (AI Season build) — "Private Underwriting" per
// KARMA_OKX_MASTER_IMPLEMENTATION_PLAN.md Section XXXIX-XLII. Same proven Poseidon-commitment +
// range-check + Merkle-membership skeleton as `agent_credential.circom`'s AgentCredentialProof
// (kept, unmodified, for backward compatibility — see that file), with ONE deliberate change to
// close the exact gap Section XL calls out by name:
//
//   AgentCredentialProof's nullifier = Poseidon(credentialSecret, skillId) — bound only to
//   WHICH SKILL, so the same credential produces the same nullifier for every policy quote
//   requested against that skill. Two different principals underwriting the same agent for the
//   same skill, or the same principal issuing two different policies to it over time, are all
//   linkable to each other via that one nullifier — a real privacy/anti-correlation leak for a
//   feature whose whole point is "prove the threshold, reveal nothing else."
//
// PolicyCredentialProof's nullifier = Poseidon(credentialSecret, policyRequestId, domain) —
// THREE inputs, exactly Section XL's own list ("credentialSecret + policyRequestId +
// principal/domain"). `policyRequestId` ties the proof to one specific underwriting request (a
// field-element digest of principal+subject+actionDigest+nonce — the same identifying context
// `computePolicyId` already derives off-chain); `domain` additionally binds the
// principal/subject pairing itself. Two different policy requests for the same underlying
// credential now produce two UNLINKABLE nullifiers, while a single request still can't be
// replayed twice (the nullifier for that exact request is deterministic and checkable on-chain).
//
// Public  (verified on-chain):
//   policyRequestId       identifies the specific underwriting request this proof is for
//   domain                principal/subject binding context (Section XL)
//   minReputation         the policy profile's required reputation threshold
//   nullifier             Poseidon(credentialSecret, policyRequestId, domain)
//   credentialCommitment  Poseidon(credentialSecret, reputationScore) — same binding role as
//                         AgentCredentialProof: a holder cannot attach a self-declared score
//   issuerRoot            the issuer-published merkle root the leaf must live under
//
// Private (NEVER revealed): credentialSecret, reputationScore, pathElements/pathIndices.
//
// Tree depth: 8 (same hackathon-scoped choice as AgentCredentialProof — see that file's own note
// on production depth/ptau sizing).

template MerkleProof(depth) {
    signal input leaf;
    signal input pathElements[depth];
    signal input pathIndices[depth];
    signal output root;

    component hashers[depth];
    component muxL[depth];
    component muxR[depth];
    signal current[depth + 1];
    current[0] <== leaf;

    for (var i = 0; i < depth; i++) {
        pathIndices[i] * (1 - pathIndices[i]) === 0;

        muxL[i] = Mux1();
        muxL[i].c[0] <== current[i];
        muxL[i].c[1] <== pathElements[i];
        muxL[i].s <== pathIndices[i];

        muxR[i] = Mux1();
        muxR[i].c[0] <== pathElements[i];
        muxR[i].c[1] <== current[i];
        muxR[i].s <== pathIndices[i];

        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== muxL[i].out;
        hashers[i].inputs[1] <== muxR[i].out;
        current[i + 1] <== hashers[i].out;
    }

    root <== current[depth];
}

template PolicyCredentialProof(depth) {
    // Public inputs (verified on-chain).
    signal input policyRequestId;
    signal input domain;
    signal input minReputation;
    signal input nullifier;
    signal input credentialCommitment;
    signal input issuerRoot;

    // Private inputs.
    signal input credentialSecret;
    signal input reputationScore;
    signal input pathElements[depth];
    signal input pathIndices[depth];

    // (1) credentialCommitment == Poseidon(credentialSecret, reputationScore) — identical binding
    //     role to AgentCredentialProof: a holder of `credentialSecret` cannot attach any score
    //     other than the one actually committed by the issuer at leaf-creation time.
    component commitHash = Poseidon(2);
    commitHash.inputs[0] <== credentialSecret;
    commitHash.inputs[1] <== reputationScore;
    commitHash.out === credentialCommitment;

    // (2) reputationScore in [0, 100], and >= minReputation.
    component repBits = Num2Bits(7);
    repBits.in <== reputationScore;
    component minBits = Num2Bits(7);
    minBits.in <== minReputation;

    component lt100 = LessEqThan(7);
    lt100.in[0] <== reputationScore;
    lt100.in[1] <== 100;
    lt100.out === 1;

    component gte = GreaterEqThan(7);
    gte.in[0] <== reputationScore;
    gte.in[1] <== minReputation;
    gte.out === 1;

    // (3) credentialCommitment is a leaf under issuerRoot.
    component merkle = MerkleProof(depth);
    merkle.leaf <== credentialCommitment;
    for (var i = 0; i < depth; i++) {
        merkle.pathElements[i] <== pathElements[i];
        merkle.pathIndices[i] <== pathIndices[i];
    }
    merkle.root === issuerRoot;

    // (4) nullifier == Poseidon(credentialSecret, policyRequestId, domain) — policy-context-bound
    //     replay guard (Section XL), not the per-skill-only binding AgentCredentialProof uses.
    component nullHash = Poseidon(3);
    nullHash.inputs[0] <== credentialSecret;
    nullHash.inputs[1] <== policyRequestId;
    nullHash.inputs[2] <== domain;
    nullHash.out === nullifier;
}

component main { public [policyRequestId, domain, minReputation, nullifier, credentialCommitment, issuerRoot] } = PolicyCredentialProof(8);
