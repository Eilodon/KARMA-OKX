/**
 * Canonical `policyHash` — the reproducibility anchor for `KarmaPolicyIR` (Section III:
 * "compiler determinism", Section XLIX's `karma policy verify` concept). Reuses the same
 * canonical-JSON hashing `rwa_provenance_receipt.ts` uses for its `result_hash`, pulled into
 * `lib/canonical_hash.ts` once a second caller needed it.
 */

import { canonicalHash } from "../../canonical_hash.js";
import type { KarmaPolicyIR } from "./ir.js";

export function computePolicyHash(ir: Omit<KarmaPolicyIR, "policyHash">): string {
  return "0x" + canonicalHash(ir);
}
