/**
 * `KarmaPolicyEnforcer.sol` custom-error decoding — pure string/shape matching, no chain client,
 * no env, no Node-specific API. Pulled out of `xlayer_policy.ts` (which re-exports it for
 * backward compatibility) so `docs/media/xlayer_policy_demo.html`'s browser bundle can decode a
 * viem `simulateContract`/`writeContract` revert into the same
 * KARMA_OKX_MASTER_IMPLEMENTATION_PLAN.md Section CII rejection-code vocabulary the server-side
 * MCP tools use, without pulling `xlayer.ts`'s `process.env`-reading chain-client singletons into
 * a browser bundle (which would break: `process` isn't defined there).
 */

/** Rejection codes matching KarmaPolicyEnforcer.sol's custom errors, which in turn match
 *  KARMA_OKX_MASTER_IMPLEMENTATION_PLAN.md Section CII's own rejection-telemetry vocabulary. */
export type PolicyRejectionCode =
  | "POLICY_NOT_FOUND"
  | "POLICY_ALREADY_EXISTS"
  | "INVALID_EXPIRY"
  | "POLICY_EXPIRED"
  | "POLICY_REVOKED"
  | "NOT_SUBJECT"
  | "NOT_PRINCIPAL"
  | "PER_TRANSACTION_LIMIT_EXCEEDED"
  | "CUMULATIVE_EXPOSURE_EXCEEDED"
  | "UNKNOWN";

const ERROR_NAME_TO_CODE: Record<string, PolicyRejectionCode> = {
  PolicyNotFound: "POLICY_NOT_FOUND",
  PolicyAlreadyExists: "POLICY_ALREADY_EXISTS",
  InvalidExpiry: "INVALID_EXPIRY",
  PolicyExpired: "POLICY_EXPIRED",
  PolicyRevoked: "POLICY_REVOKED",
  NotSubject: "NOT_SUBJECT",
  NotPrincipal: "NOT_PRINCIPAL",
  PerTransactionLimitExceeded: "PER_TRANSACTION_LIMIT_EXCEEDED",
  CumulativeExposureExceeded: "CUMULATIVE_EXPOSURE_EXCEEDED",
};

/** Best-effort decode of a viem contract-revert error into KARMA's own rejection vocabulary —
 *  looks for the custom error's name wherever viem surfaces it (varies by error subtype), falls
 *  back to "UNKNOWN" rather than guessing. */
export function decodePolicyRejection(err: unknown): PolicyRejectionCode {
  const name =
    (err as { cause?: { data?: { errorName?: string }; name?: string } } | undefined)?.cause?.data?.errorName ??
    (err as { cause?: { name?: string } } | undefined)?.cause?.name ??
    (err as { name?: string } | undefined)?.name;
  if (typeof name === "string" && name in ERROR_NAME_TO_CODE) {
    return ERROR_NAME_TO_CODE[name];
  }
  const message = err instanceof Error ? err.message : String(err);
  for (const [errorName, code] of Object.entries(ERROR_NAME_TO_CODE)) {
    if (message.includes(errorName)) return code;
  }
  return "UNKNOWN";
}
