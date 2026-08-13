/**
 * Deterministic canonical JSON hashing — shared by anything that needs a stable hash over a
 * structured object regardless of key-insertion order (policy commitments, evidence receipts).
 * Originally lived only in `casper/rwa_provenance_receipt.ts`; pulled out here once the policy
 * compiler kernel (`lib/trust/policy/hash.ts`) needed the same primitive, so there's one
 * implementation, not two that could silently drift.
 */

import { createHash } from "node:crypto";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
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
