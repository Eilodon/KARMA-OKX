/**
 * Deterministic canonical JSON hashing — shared by anything that needs a stable hash over a
 * structured object regardless of key-insertion order (policy commitments, evidence receipts).
 * Originally lived only in `casper/rwa_provenance_receipt.ts`; pulled out here once the policy
 * compiler kernel (`lib/trust/policy/hash.ts`) needed the same primitive, so there's one
 * implementation, not two that could silently drift.
 *
 * `sha256Hex` is a self-contained SHA-256 (FIPS 180-4) rather than `node:crypto`'s `createHash`
 * on purpose: `docs/media/xlayer_policy_demo.html`'s browser bundle (esbuild
 * `--platform=browser`) imports `compilePolicy` -> `computePolicyHash` -> this module directly,
 * so `policyHash` can be computed client-side, in the browser, with no server round-trip — the
 * same deterministic compiler kernel the Node-side demo scripts and MCP tools use, not a second
 * reimplementation. `node:crypto` doesn't bundle for a browser target. Correctness is pinned
 * against the standard NIST test vectors in `src/__tests__/canonical_hash.test.ts`.
 */

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/** Synchronous SHA-256 over a UTF-8 string, returning lowercase hex — same output shape as
 *  `node:crypto`'s `createHash("sha256").update(input).digest("hex")`, but pure JS/TypedArray so
 *  it runs identically in Node and in a browser bundle. */
export function sha256Hex(input: string): string {
  const msg = new TextEncoder().encode(input);
  const bitLen = msg.length * 8;

  // Padding (FIPS 180-4 §5.1.1): append 0x80, then zeros, then the 64-bit big-endian bit length,
  // total length a multiple of 64 bytes. `+9` = 1 byte (0x80) + 8 bytes (length).
  const paddedLen = Math.ceil((msg.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(msg);
  padded[msg.length] = 0x80;
  const view = new DataView(padded.buffer);
  // Only the low 32 bits of the 64-bit length are set — correct for any input under ~512MB,
  // vastly larger than anything this module ever hashes (policy IRs, evidence bundles).
  view.setUint32(paddedLen - 4, bitLen >>> 0, false);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  const w = new Uint32Array(64);
  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const bigS1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + bigS1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const bigS0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (bigS0 + maj) >>> 0;

      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7].map((x) => x.toString(16).padStart(8, "0")).join("");
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** Deterministic JSON serialization — recursively sorts object keys so the same logical value
 *  hashes identically no matter what order its fields were constructed in. Array element order
 *  is preserved (order can be meaningful, e.g. a sequence of feeds or rule-trace entries).
 *  `bigint` fields (money amounts) are stringified — `JSON.stringify` can't serialize them
 *  natively and this repo's IR types use `bigint` for wei-denominated amounts. */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value), (_key, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
}

export function canonicalHash(value: unknown): string {
  return sha256Hex(canonicalize(value));
}
