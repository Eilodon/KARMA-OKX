/**
 * Backward-compatibility re-export — this module's real implementation moved to
 * `lib/rwa/provenance_receipt.ts` (AI Season build) once the X Layer policy demo needed the
 * same chain-agnostic provenance/freshness/integrity logic the Casper RWA oracle demo already
 * had. Import from `lib/rwa/provenance_receipt.ts` directly in new code; this file exists only
 * so existing Casper scripts/tests don't need to change their import path.
 */
export * from "../rwa/provenance_receipt.js";
