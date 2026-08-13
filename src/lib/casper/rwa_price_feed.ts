/**
 * Backward-compatibility re-export — this module's real implementation moved to
 * `lib/rwa/price_feed.ts` (AI Season build) once the X Layer policy demo needed the same
 * chain-agnostic price-feed logic the Casper RWA oracle demo already had. Import from
 * `lib/rwa/price_feed.ts` directly in new code; this file exists only so
 * `demo_casper_rwa_oracle_lifecycle_live.ts`, `demo_casper_x402_live.ts`, and their tests don't
 * need to change their import path.
 */
export * from "../rwa/price_feed.js";
