export type AuthoringErrorCode =
  | "invalid_transaction"
  | "transaction_too_large"
  | "invalid_hash"
  | "project_mismatch"
  | "stale_head"
  | "transaction_id_collision"
  | "unknown_adapter"
  | "adapter_not_allowed"
  | "preflight_failed"
  | "capture_failed"
  | "state_guard_conflict"
  | "apply_failed"
  | "rollback_failed"
  | "writer_poisoned"
  | "compensation_not_found"
  | "compensation_not_supported"
  | "compensation_conflict"
  | "already_compensated";

/** Stable, machine-readable failure raised by the authoring transaction boundary. */
export class AuthoringError extends Error {
  readonly code: AuthoringErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: AuthoringErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "AuthoringError";
    this.code = code;
    this.details = details;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
