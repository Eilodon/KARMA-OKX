import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fc from "fast-check";
import { sha256Hex, canonicalize, canonicalHash } from "../lib/canonical_hash.js";

/** Ground truth for the pinned-vector tests below — Node's own (OpenSSL-backed) SHA-256,
 *  independent of this module's hand-rolled implementation. */
function nodeSha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

describe("sha256Hex — pinned against Node's own crypto module", () => {
  const vectors = [
    ["empty string", ""],
    ["\"abc\"", "abc"],
    ["a 57-byte multi-block message", "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"],
    ["a well-known pangram", "The quick brown fox jumps over the lazy dog"],
    ["exactly 55 bytes (longest single-block message)", "a".repeat(55)],
    ["exactly 56 bytes (shortest to need a second block)", "a".repeat(56)],
    ["exactly 64 bytes (one full block)", "a".repeat(64)],
    ["exactly 119 bytes (two-block boundary)", "a".repeat(119)],
    ["exactly 120 bytes (needs a third block)", "a".repeat(120)],
    ["multi-byte UTF-8 characters", "café — 日本語 — emoji: 🚀"],
  ] as const;

  for (const [label, input] of vectors) {
    it(`matches node:crypto for ${label}`, () => {
      expect(sha256Hex(input)).toBe(nodeSha256Hex(input));
    });
  }

  it("matches node:crypto for randomized inputs (property test)", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 500 }), (s) => {
        expect(sha256Hex(s)).toBe(nodeSha256Hex(s));
      }),
      { numRuns: 300 },
    );
  });

  it("always returns 64 lowercase hex characters", () => {
    expect(sha256Hex("anything")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("canonicalize / canonicalHash — determinism this repo's policyHash relies on", () => {
  it("is insensitive to object key insertion order", () => {
    const a = { z: 1, a: 2, m: { y: 3, b: 4 } };
    const b = { a: 2, z: 1, m: { b: 4, y: 3 } };
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(canonicalHash(a)).toBe(canonicalHash(b));
  });

  it("preserves array element order (order is meaningful there)", () => {
    expect(canonicalize([1, 2, 3])).not.toBe(canonicalize([3, 2, 1]));
  });

  it("stringifies bigint fields instead of throwing", () => {
    expect(() => canonicalize({ amount: 500n })).not.toThrow();
    expect(canonicalize({ amount: 500n })).toBe('{"amount":"500"}');
  });

  it("distinguishes objects that differ only in a bigint value", () => {
    expect(canonicalHash({ amount: 500n })).not.toBe(canonicalHash({ amount: 501n }));
  });
});
