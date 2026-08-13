// End-to-end test for PolicyCredentialProof (AI Season build — "Private Underwriting").
//
// Same Groth16 pipeline as agent_credential.test.mjs, same negative-case coverage, PLUS one test
// that's the entire reason this circuit exists as a distinct artifact from AgentCredentialProof:
// proving the SAME underlying credential produces UNLINKABLE nullifiers across two different
// policy requests (Section XL's anti-correlation property) while a single request still can't be
// silently swapped for a different one.
//
// Coverage:
//   1. Happy path                    — valid commitment, score 80 >= minRep 60, leaf at index 0
//   2. Negative: bad commitment      — credentialCommitment doesn't match Poseidon(secret)
//   3. Negative: insufficient rep    — score 40 < minRep 60
//   4. Negative: wrong merkle root   — claimed root differs from the tree's actual root
//   5. Negative: tampered nullifier  — nullifier doesn't match Poseidon(secret, policyRequestId, domain)
//   6. Anti-correlation              — same credential, two different policyRequestIds -> two
//                                       different, unlinkable nullifiers (the actual point of
//                                       this circuit vs. AgentCredentialProof's per-skill one)
//   7. Verifier-side tamper          — a valid proof rejected once a public signal is edited

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CIRCOM = join(ROOT, "bin/circom");
const SNARKJS = join(ROOT, "node_modules/.bin/snarkjs");
const BUILD = join(ROOT, "build/policy_credential");
const CIRCUIT = join(ROOT, "src/policy_credential.circom");
const DEPTH = 8;
const POT_POWER = 13;

const PTAU0 = join(BUILD, `pot${POT_POWER}_0000.ptau`);
const PTAU1 = join(BUILD, `pot${POT_POWER}_0001.ptau`);
const PTAU = join(BUILD, `pot${POT_POWER}_final.ptau`);
const R1CS = join(BUILD, "policy_credential.r1cs");
const WASM = join(BUILD, "policy_credential_js/policy_credential.wasm");
const ZKEY = join(BUILD, "policy_credential_0001.zkey");
const VKEY = join(BUILD, "verification_key.json");

function sh(label, cmd, args) {
  process.stdout.write(`[PolicyCredential] ${label}... `);
  const t = Date.now();
  try {
    execFileSync(cmd, args, { stdio: "pipe" });
    process.stdout.write(`OK (${Date.now() - t}ms)\n`);
  } catch (e) {
    process.stdout.write(`FAIL\n`);
    if (e.stdout) console.error(e.stdout.toString());
    if (e.stderr) console.error(e.stderr.toString());
    throw e;
  }
}

async function setupOnce() {
  if (existsSync(BUILD)) rmSync(BUILD, { recursive: true });
  mkdirSync(BUILD, { recursive: true });

  sh("compile circom", CIRCOM, [CIRCUIT, "--r1cs", "--wasm", "--sym", "-o", BUILD]);
  sh(`powersoftau new (bn128 power ${POT_POWER})`, SNARKJS, [
    "powersoftau", "new", "bn128", String(POT_POWER), PTAU0,
  ]);
  sh("powersoftau contribute", SNARKJS, [
    "powersoftau", "contribute", PTAU0, PTAU1,
    "--name=karma-ai-season", "-e=karma-policy-credential",
  ]);
  sh("powersoftau prepare phase2", SNARKJS, ["powersoftau", "prepare", "phase2", PTAU1, PTAU]);
  sh("groth16 setup", SNARKJS, ["groth16", "setup", R1CS, PTAU, ZKEY]);
  sh("export verification key", SNARKJS, ["zkey", "export", "verificationkey", ZKEY, VKEY]);
}

function buildMerkleProof(poseidon, F, depth, leaf, leafIndex) {
  const ZERO = 0n;
  const zeroNodes = [ZERO];
  for (let i = 0; i < depth; i++) {
    const z = zeroNodes[i];
    zeroNodes.push(F.toObject(poseidon([z, z])));
  }
  let current = leaf;
  let idx = leafIndex;
  const pathElements = [];
  const pathIndices = [];
  for (let i = 0; i < depth; i++) {
    const sibling = zeroNodes[i];
    pathElements.push(sibling.toString());
    const isRight = idx & 1;
    pathIndices.push(isRight);
    const left = isRight ? sibling : current;
    const right = isRight ? current : sibling;
    current = F.toObject(poseidon([left, right]));
    idx >>= 1;
  }
  return { root: current.toString(), pathElements, pathIndices };
}

async function genWitness(input, label) {
  const inputFile = join(BUILD, `${label}.input.json`);
  const wtnsFile = join(BUILD, `${label}.witness.wtns`);
  writeFileSync(inputFile, JSON.stringify(input));
  execFileSync(SNARKJS, ["wtns", "calculate", WASM, inputFile, wtnsFile], { stdio: "pipe" });
  return wtnsFile;
}

async function proveAndVerify(input, label) {
  const wtns = await genWitness(input, label);
  const proofFile = join(BUILD, `${label}.proof.json`);
  const publicFile = join(BUILD, `${label}.public.json`);
  execFileSync(SNARKJS, ["groth16", "prove", ZKEY, wtns, proofFile, publicFile], { stdio: "pipe" });
  const proof = JSON.parse(readFileSync(proofFile, "utf8"));
  const publicSignals = JSON.parse(readFileSync(publicFile, "utf8"));
  const vk = JSON.parse(readFileSync(VKEY, "utf8"));
  return { proof, publicSignals, vk };
}

async function main() {
  await setupOnce();

  const poseidon = await buildPoseidon();
  const F = poseidon.F;

  const credentialSecret = 12345678901234567890n;
  const policyRequestId = 111n; // e.g. a field-element digest of principal+subject+actionDigest+nonce
  const domain = 222n; // principal/subject binding context (Section XL)
  const nullifier = F.toObject(poseidon([credentialSecret, policyRequestId, domain])).toString();
  const reputationScore = 80n;
  const minReputation = 60n;
  const credentialCommitment = F.toObject(poseidon([credentialSecret, reputationScore])).toString();

  const { root, pathElements, pathIndices } = buildMerkleProof(
    poseidon, F, DEPTH, F.toObject(poseidon([credentialSecret, reputationScore])), 0,
  );

  const happyInput = {
    policyRequestId: policyRequestId.toString(),
    domain: domain.toString(),
    minReputation: minReputation.toString(),
    nullifier,
    credentialCommitment,
    issuerRoot: root,
    credentialSecret: credentialSecret.toString(),
    reputationScore: reputationScore.toString(),
    pathElements,
    pathIndices: pathIndices.map(String),
  };

  process.stdout.write("[PolicyCredential] happy path: prove + verify... ");
  const { proof, publicSignals, vk } = await proveAndVerify(happyInput, "happy");
  const ok = await snarkjs.groth16.verify(vk, publicSignals, proof);
  process.stdout.write(ok ? "OK\n" : "FAIL\n");
  if (!ok) process.exit(1);
  console.log(`       public signals: ${publicSignals.join(", ")}`);

  const expectedPublicOrder = [
    policyRequestId.toString(),
    domain.toString(),
    minReputation.toString(),
    nullifier,
    credentialCommitment,
    root,
  ];
  if (JSON.stringify(publicSignals) !== JSON.stringify(expectedPublicOrder)) {
    console.error("FAIL: publicSignals order mismatch");
    console.error("  got:    ", publicSignals);
    console.error("  expect: ", expectedPublicOrder);
    process.exit(1);
  }
  console.log("[PolicyCredential] public-signals order matches on-chain verifier expectation");

  try {
    await genWitness({ ...happyInput, credentialCommitment: "9999" }, "bad_commit");
    console.error("FAIL: bad credentialCommitment was accepted");
    process.exit(1);
  } catch {
    console.log("[PolicyCredential] negative bad-commitment: rejected ✓");
  }

  const lowScore = 40n;
  const lowCommitment = F.toObject(poseidon([credentialSecret, lowScore])).toString();
  const lowTree = buildMerkleProof(
    poseidon, F, DEPTH, F.toObject(poseidon([credentialSecret, lowScore])), 0,
  );
  try {
    await genWitness({
      ...happyInput,
      reputationScore: lowScore.toString(),
      credentialCommitment: lowCommitment,
      issuerRoot: lowTree.root,
      pathElements: lowTree.pathElements,
      pathIndices: lowTree.pathIndices.map(String),
    }, "low_rep");
    console.error("FAIL: insufficient reputation was accepted");
    process.exit(1);
  } catch {
    console.log("[PolicyCredential] negative low-reputation: rejected ✓");
  }

  try {
    await genWitness({ ...happyInput, issuerRoot: "7" }, "bad_root");
    console.error("FAIL: wrong merkle root was accepted");
    process.exit(1);
  } catch {
    console.log("[PolicyCredential] negative bad-merkle-root: rejected ✓");
  }

  try {
    await genWitness({ ...happyInput, nullifier: "13" }, "bad_null");
    console.error("FAIL: tampered nullifier was accepted");
    process.exit(1);
  } catch {
    console.log("[PolicyCredential] negative bad-nullifier: rejected ✓");
  }

  // 6) Anti-correlation: the SAME credentialSecret + SAME reputationScore/commitment/tree,
  //    but a DIFFERENT policyRequestId, must derive a DIFFERENT nullifier — proving two policy
  //    requests against the same underlying credential are not linkable to each other via the
  //    nullifier. This is the property AgentCredentialProof's per-skill nullifier does NOT have
  //    (two different policy requests for the same skill would share one nullifier there).
  const secondPolicyRequestId = 999n;
  const secondNullifier = F.toObject(poseidon([credentialSecret, secondPolicyRequestId, domain])).toString();
  if (secondNullifier === nullifier) {
    console.error("FAIL: nullifier did not change across different policyRequestIds");
    process.exit(1);
  }
  const secondInput = {
    ...happyInput,
    policyRequestId: secondPolicyRequestId.toString(),
    nullifier: secondNullifier,
  };
  const second = await proveAndVerify(secondInput, "second_request");
  const secondOk = await snarkjs.groth16.verify(second.vk, second.publicSignals, second.proof);
  if (!secondOk) {
    console.error("FAIL: second policy request's own valid proof was rejected");
    process.exit(1);
  }
  console.log(
    `[PolicyCredential] anti-correlation: request A nullifier != request B nullifier ` +
      `(${nullifier.slice(0, 12)}... != ${secondNullifier.slice(0, 12)}...) ✓`,
  );

  process.stdout.write("[PolicyCredential] verifier rejects tampered public input... ");
  const tampered = [...publicSignals];
  tampered[2] = "0"; // claim minReputation=0 (index 2: policyRequestId, domain, minReputation, ...)
  const okBad = await snarkjs.groth16.verify(vk, tampered, proof);
  process.stdout.write(!okBad ? "OK\n" : "FAIL\n");
  if (okBad) process.exit(1);

  console.log("[PolicyCredential] PASS — PolicyCredentialProof end-to-end");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
