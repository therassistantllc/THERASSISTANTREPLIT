// File: lib/clearinghouse/eligibilityErrors.ts
//
// Structured errors for the real-time eligibility path. Kept in their
// own module so adapter, service, and API route can all instanceof-check
// them without pulling adapter implementation details into shared types.

/**
 * Raised when the 20-second real-time SLA defined by CAQH CORE
 * Eligibility & Benefits Infrastructure Rule vEB.2.0 §4 expires before
 * the payer returns either a 271 or a 999.
 *
 * Callers should treat this as a definitive failure for the current
 * request — no retries inside the same 20s window — and surface it on
 * the originating edi_transactions row with ack_status='timeout' and
 * timed_out_at = the wall-clock deadline.
 */
export class EligibilityTimeoutError extends Error {
  readonly code = "ELIGIBILITY_TIMEOUT" as const;
  readonly deadlineMs: number;
  readonly elapsedMs: number;
  readonly correlationId?: string | null;

  constructor(opts: { deadlineMs: number; elapsedMs: number; correlationId?: string | null; message?: string }) {
    super(
      opts.message ??
        `Real-time eligibility request exceeded the ${opts.deadlineMs}ms CAQH CORE SLA (elapsed ${opts.elapsedMs}ms).`,
    );
    this.name = "EligibilityTimeoutError";
    this.deadlineMs = opts.deadlineMs;
    this.elapsedMs = opts.elapsedMs;
    this.correlationId = opts.correlationId ?? null;
  }
}

function isEligibilityTimeoutError(err: unknown): err is EligibilityTimeoutError {
  return err instanceof EligibilityTimeoutError;
}

/**
 * Default real-time deadline in milliseconds. CAQH CORE Eligibility &
 * Benefits Infrastructure Rule vEB.2.0 §4 specifies 20 seconds; we
 * leave a small headroom inside that window for the caller to record
 * the timeout before its own request handler is killed.
 */
const DEFAULT_REALTIME_DEADLINE_MS = 20_000;

export function resolveRealtimeDeadlineMs(): number {
  const raw = process.env.AVAILITY_REALTIME_TIMEOUT_MS;
  if (!raw) return DEFAULT_REALTIME_DEADLINE_MS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_REALTIME_DEADLINE_MS;
  // Refuse to silently exceed the rule — clamp to 20s ceiling.
  return Math.min(n, DEFAULT_REALTIME_DEADLINE_MS);
}
