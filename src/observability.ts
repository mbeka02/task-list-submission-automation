import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { type DestinationStream, type Logger, pino } from "pino";

/** Attribution is supplied at the entry point, then retained through nested asynchronous work. */
export type EntryPoint =
  | "worker_auth_start"
  | "worker_auth_finish"
  | "worker_once"
  | "worker_startup"
  | "worker_periodic"
  | "worker_status"
  | "worker_api"
  | "delivery_api"
  | "brief_api";
/** Optional library instrumentation; callers choose an approved entry-point label, never sensitive bindings. */
export interface ObservabilityOptions {
  logger?: Logger;
  entryPoint?: EntryPoint;
}
const currentLog = new AsyncLocalStorage<Logger>();
const levels = new Set([
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
]);
const reasons = new Set([
  "credentials_already_exist",
  "execution_unavailable",
  "storage_error",
  "storage_unavailable",
  "invalid_log_level",
  "invalid_arguments",
  "missing_worker_configuration",
  "invalid_calendar_file",
  "invalid_worker_configuration",
  "outbound_requires_activation",
  "brief_publishing_requires_activation",
  "rate_limited",
  "credentials_unavailable",
  "credentials_invalid",
  "destination_denied",
  "outbound_scope_mismatch",
  "delivery_window_expired",
  "claim_expired",
  "claim_lost",
  "claim_active",
  "deduplication_window_expired",
  "reconciliation_required",
  "retry_not_due",
  "transport_or_acknowledgement_unknown",
  "frozen_evidence_unavailable",
  "invalid_delivery_time",
  "restore_review_required",
  "invalid_calendar",
  "invalid_clock",
  "inspection_only",
  "before_activation",
  "not_working_day",
  "invalid_brief_configuration",
  "source_scope_mismatch",
  "unsupported_reply_policy",
  "invalid_reader_configuration",
  "invalid_business_date",
  "before_cutoff",
  "page_limit_reached",
  "invalid_response",
  "invalid_message",
  "source_conflict",
  "policy_scope_mismatch",
  "scan_incomplete",
  "scan_coverage_mismatch",
  "scan_observation_conflict",
  "scan_membership_mismatch",
  "source_identity_conflict",
  "source_version_conflict",
  "known_recall",
  "stale_observation",
  "needs_review",
  "input_too_large",
  "document_not_verified",
  "unapproved_source",
  "invalid_timestamp",
  "outside_business_date",
  "after_cutoff",
  "deleted",
  "non_human_sender",
  "not_original_submission",
  "unsupported_message_type",
  "malformed_content",
  "thread_reply_excluded",
  "thread_policy_unconfirmed",
  "unresolved_identity",
  "unresolved_name",
  "task_list",
  "incomplete_task_list",
  "ambiguous_task_heading",
  "not_task_list",
  "duplicate_sender",
  "credentials_refresh_expired",
  "credentials_revoked",
  "credentials_require_reauthorization",
  "credentials_refresh_uncertain",
  "credentials_refresh_busy",
  "credentials_storage_unsafe",
  "pagination_incomplete",
  "permission_denied",
  "history_unavailable",
  "network_error",
  "timeout",
  "cancelled",
  "invalid_configuration",
  "refused",
  "truncated",
  "invalid_output",
  "billing_required",
  "provider_unavailable",
  "access_denied",
  "model_unavailable",
  "invalid_request",
  "http_error",
  "generation_budget_exhausted",
  "retry_budget_exhausted",
  "credential_scope_mismatch",
  "credentials_expired",
  "credentials_timed_out",
  "authorization_failed",
  "source_access_denied",
  "page_unavailable",
  "memory_only_content_lost",
  "review_required",
  "brief_not_found",
  "invalid_work_deadline",
  "work_window_expired",
  "invalid_generation_time",
  "generation_configuration_mismatch",
  "publication_configuration_mismatch",
  "publishing_not_configured",
  "publication_claim_active",
  "document_operation_unverified",
  "document_creation_unknown",
  "announcement_unavailable",
  "brief_execution_unavailable",
  "brief_capture_incomplete",
  "brief_preparation_blocked",
  "preparation_blocked",
]);
const categories = new Set([
  "ok",
  "blocked",
  "paused",
  "due",
  "not_due",
  "skipped",
  "disabled",
  "pending",
  "retryable",
  "uncertain",
  "sending",
  "sent",
  "failed",
  "not_sent",
  "complete",
  "incomplete",
  "unavailable",
  "review_required",
  "not_working_day",
  "input_frozen",
  "generating",
  "content_ready",
  "creating",
  "writing",
  "verifying",
  "sharing",
  "verified",
  "published",
  "ready",
  "not_started",
  "generated",
  "ai",
  "fallback",
  "empty",
  "names",
  "brief",
  "reminder",
  "report",
  "brief_announcement",
  "gemini",
  "deepseek",
  "transient",
  "permanent",
  "cancelled",
  "capture_only",
  "publish",
  "authenticate",
  "create",
  "privacy",
  "write",
  "verify",
  "share",
]);
const numericFields = new Set([
  "durationMs",
  "messageCount",
  "entryCount",
  "lateCount",
  "attemptCount",
  "attempt",
  "retryAfterMs",
  "providerCode",
  "inputTokens",
  "outputTokens",
  "thinkingTokens",
  "totalTokens",
  "backfillCount",
  "reviewCount",
  "briefBackfillCount",
]);
const categoryFields = new Set([
  "status",
  "state",
  "captureKind",
  "kind",
  "provider",
  "classification",
  "reminderState",
  "reportState",
  "briefState",
  "generationState",
  "publicationState",
  "mode",
  "stage",
]);

/** Diagnostics can inspect ledger metadata only while an operational sink is attached. */
export function hasOperationalLogger(): boolean {
  return Boolean(currentLog.getStore());
}

/** A fixed metadata allowlist also protects callers using their own Pino instance. */
function safeFields(fields: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (
      numericFields.has(key) &&
      (value === null ||
        (typeof value === "number" &&
          Number.isSafeInteger(value) &&
          value >= 0))
    )
      safe[key] = value;
    else if (
      categoryFields.has(key) &&
      typeof value === "string" &&
      categories.has(value)
    )
      safe[key] = value;
    else if (key === "reviewRequired" && typeof value === "boolean")
      safe[key] = value;
    else if (
      key === "businessDate" &&
      typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(value)
    )
      safe[key] = value;
    else if (
      (key === "deliveryId" || key === "briefId") &&
      typeof value === "string" &&
      /^[a-f0-9]{64}$/.test(value)
    )
      safe[key] = value;
    else if (
      ["reason", "reportReason", "briefReason"].includes(key) &&
      typeof value === "string"
    )
      safe[key] = reasons.has(value) ? value : "unclassified";
    else if (key === "reasons" && Array.isArray(value))
      safe[key] = value
        .slice(0, 10)
        .map((reason) => (reasons.has(reason) ? reason : "unclassified"));
  }
  return safe;
}

/** JSON to stderr keeps telemetry separate from machine-readable command results on stdout. */
export function createOperationalLogger(
  options: { level?: string; destination?: DestinationStream } = {},
): Logger {
  const level = options.level ?? "info";
  if (!levels.has(level)) throw new Error("invalid_log_level");
  return pino(
    {
      level,
      base: { service: "task-list", pid: process.pid },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      redact: {
        paths: [
          "password",
          "authorization",
          "apiKey",
          "token",
          "secret",
          "taskText",
          "text",
          "content",
          "documentUrl",
          "displayName",
        ],
        remove: true,
      },
    },
    options.destination ?? pino.destination({ dest: 2, sync: true }),
  );
}

/** Reuse a caller's correlation context; direct API calls receive their own run ID. */
export function withObservedRun<T>(
  options: ObservabilityOptions,
  entryPoint: EntryPoint,
  work: () => T,
  fields: Record<string, unknown> = {},
): T {
  const parent = currentLog.getStore();
  const logger = parent ?? options.logger;
  if (!logger) return work();
  let child: Logger;
  try {
    child = logger.child({
      ...(!parent
        ? { runId: randomUUID(), entryPoint: options.entryPoint ?? entryPoint }
        : {}),
      ...safeFields(fields),
    });
  } catch {
    return work();
  }
  return currentLog.run(child, work);
}

/** Call sites pass operational metadata only; sink failure must never change durable work. */
export function operationalEvent(
  level: "debug" | "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown> = {},
) {
  try {
    currentLog.getStore()?.[level]({ event, ...safeFields(fields) });
  } catch {
    // Logging is best-effort; a failed sink must not turn an acknowledged send into a retry.
  }
}
