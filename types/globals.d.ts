// types/globals.d.ts — ambient type augmentation for the codebase's error idiom.
//
// Throughout the suite we attach structured diagnostic fields to Error objects (mirroring Node's
// own ErrnoException `.code`, and the Mule error taxonomy VALIDATION/CONFLICT/NOT_FOUND/SYSTEM). The
// orchestrator and the MCP server branch on these fields to map a thrown error to the right envelope
// / exit code. This declaration teaches checkJs about those optional fields so the pattern
// type-checks without sprinkling casts at every `err.code` read.
//
// All fields are optional: a plain Error has none of them; our helpers (e.g. tools.js notFoundError,
// jobstore CONFLICT errors) set the relevant subset.
interface Error {
  /** Error taxonomy code, e.g. "NOT_FOUND" | "CONFLICT" | "VALIDATION" | "SYSTEM" (also Node's errno code). */
  code?: string;
  /** Mule-parity error category/type labels surfaced in structured error envelopes. */
  errorType?: string;
  category?: string;
  /** Whether the caller may retry (set on transient/system failures). */
  retryable?: boolean;
  /** Fields that failed validation (set by validationError helpers). */
  invalidFields?: string[];
  /** The conflicting job id when an app lock is already held (CONFLICT). */
  existingJobId?: string;
  /** Process exit code carried on errors thrown from spawned git/gh calls. */
  exitCode?: number;
  /** HTTP status carried on errors thrown from the GitHub REST client. */
  status?: number;
  /** Raw response body carried on GitHub REST client errors. */
  body?: string;
}
