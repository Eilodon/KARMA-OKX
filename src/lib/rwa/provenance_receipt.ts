/**
 * Full RWA-oracle provenance receipt (T14) — the 10-field schema a genuine audit trail needs,
 * beyond the abbreviated `{ feeds, providerPublicKeyHex, signatureHex }` shape the original live
 * demo (`demo_casper_rwa_oracle_lifecycle_live.ts`) used. One receipt per feed/source, not one
 * bundling multiple feeds — every field below is singular-value-oriented (one `sourceUrl`, one
 * `normalizedValue`). The on-chain `result_hash` binding is unchanged: `sha256(canonicalize(receipts))`
 * over the array of these, same mechanism the original demo used, just each element enriched.
 *
 * Moved here from `casper/rwa_provenance_receipt.ts` (AI Season build) — every field/validator
 * here is chain-agnostic (pure TS/HTTP/crypto), so it's shared between the Casper RWA oracle
 * demo and the X Layer policy demo rather than forked. `canonicalize`/`sha256Hex` now delegate
 * to `lib/canonical_hash.ts`, which the policy compiler kernel also uses, instead of keeping a
 * second copy of the same hashing logic. `casper/rwa_provenance_receipt.ts` re-exports from here
 * for backward compatibility; import from here for anything new.
 */

import { canonicalize, sha256Hex } from "../canonical_hash.js";
import type { RwaPriceQuote } from "./price_feed.js";

export { canonicalize, sha256Hex };

export const RECEIPT_VERSION = "1.0";

export interface RwaProvenanceReceipt {
  receiptVersion: string;
  jobId: string;
  requestHash: string;
  sourceUrl: string;
  retrievalTime: number;
  freshnessExpiry: number;
  rawPayloadSha256: string;
  normalizedValue: string;
  providerPublicKey: string;
  providerSignature: string;
}

/** Domains this repo actually fetches RWA feeds from (`rwa_price_feed.ts`) — anything else is
 *  rejected outright, regardless of whether its hash/signature checks out. */
const TRUSTED_SOURCE_HOSTS = ["api.coingecko.com", "api.fiscaldata.treasury.gov"];

/** Builds one full-schema receipt for a single `RwaPriceQuote`. Caller must reject a
 *  `source === "fallback"` quote (via `assertNotFallback`) *before* calling this — a receipt is
 *  never built from a value that was never actually retrieved live. */
export function buildProvenanceReceipt(input: {
  jobId: bigint | string;
  requestHash: string;
  quote: RwaPriceQuote;
  freshnessMs: number;
  providerPublicKey: string;
  providerSignature: string;
}): RwaProvenanceReceipt {
  return {
    receiptVersion: RECEIPT_VERSION,
    jobId: input.jobId.toString(),
    requestHash: input.requestHash,
    sourceUrl: input.quote.sourceUrl,
    retrievalTime: input.quote.timestamp,
    freshnessExpiry: input.quote.timestamp + input.freshnessMs,
    rawPayloadSha256: sha256Hex(input.quote.rawPayloadText),
    normalizedValue: input.quote.price,
    providerPublicKey: input.providerPublicKey,
    providerSignature: input.providerSignature,
  };
}

// ── Validators — each throws a specific, fail-closed error; none silently downgrade. ──────────

export function assertNotFallback(source: RwaPriceQuote["source"]): void {
  if (source === "fallback") {
    throw new Error(
      "[provenance-receipt] source is \"fallback\" — refusing to sign/sell a non-live quote as evidence.",
    );
  }
}

export function assertFresh(receipt: RwaProvenanceReceipt, now: number = Date.now()): void {
  if (now > receipt.freshnessExpiry) {
    throw new Error(
      `[provenance-receipt] expired: freshnessExpiry=${receipt.freshnessExpiry} < now=${now} ` +
        `(${now - receipt.freshnessExpiry}ms stale) — refusing to trust a stale quote.`,
    );
  }
}

export function assertTrustedSource(receipt: RwaProvenanceReceipt): void {
  let host: string;
  try {
    host = new URL(receipt.sourceUrl).host;
  } catch {
    throw new Error(`[provenance-receipt] sourceUrl is not a valid URL: ${receipt.sourceUrl}`);
  }
  if (!TRUSTED_SOURCE_HOSTS.includes(host)) {
    throw new Error(
      `[provenance-receipt] untrusted source host "${host}" — expected one of: ${TRUSTED_SOURCE_HOSTS.join(", ")}.`,
    );
  }
}

export function assertPayloadIntegrity(receipt: RwaProvenanceReceipt, rawPayloadText: string): void {
  const recomputed = sha256Hex(rawPayloadText);
  if (recomputed !== receipt.rawPayloadSha256) {
    throw new Error(
      `[provenance-receipt] payload tampered: rawPayloadSha256=${receipt.rawPayloadSha256} does not match ` +
        `recomputed sha256=${recomputed} of the supplied raw payload.`,
    );
  }
}
