import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import {
  evaluateSubmissions,
  type SubmissionInput,
} from "./evaluate-submissions.js";
import {
  hasOperationalLogger,
  type ObservabilityOptions,
  operationalEvent,
  withObservedRun,
} from "./observability.js";
import {
  type ReportRecipient,
  recipientFromKey,
  scopedRecipientOptions,
} from "./report-recipient.js";
import {
  dailyBriefs,
  deliveries,
  type EvidenceObservation,
  messages,
  observations,
  reportEntries,
} from "./storage/schema.js";
import { requiresRestoreReview } from "./storage-recovery.js";

/** Accessible history coverage for one business date, not an atomic snapshot or full edit history. */
export interface CompleteScan {
  status: "complete";
  appId: string;
  sourceChatId: string;
  businessDate: string;
  observedAtMs: number;
  fromMs: number;
  throughMs: number;
  replyPolicy: "include" | "exclude";
  messages: SubmissionInput["messages"];
}
/** Submission rules with the policy version retained alongside the frozen report. */
export type ReportPolicy = SubmissionInput["policy"] & {
  policyVersion: string;
};
/** History and policy to validate before freezing; incomplete scans cannot produce a report. */
export interface PrepareReportInput {
  businessDate: string;
  scan:
    | CompleteScan
    | (Omit<CompleteScan, "status"> & { status: "incomplete" | "unavailable" });
  policy: ReportPolicy;
}
/** Frozen app, destination, text and UUID reused on retries, with deadlines for this attempt. */
export interface OutboundReport {
  appId: string;
  destinationChatId: string;
  text: string;
  uuid: string;
  /** Latest safe start time for an uncertain replay; recheck after obtaining credentials. */
  retryDeadlineMs?: number;
  /** Last safe POST start while leaving 15 seconds inside the claim lease. */
  claimDeadlineMs?: number;
  /** Exclusive publication end (reminder cutoff or scheduler deadline); recheck after credentials. */
  deliveryDeadlineMs?: number;
}
/** Acknowledged success, proven non-acceptance, or an expired safety deadline; thrown errors are uncertain. */
export type TransportOutcome =
  | { messageId: string }
  | { webhookAccepted: true }
  | {
      status: "retryable";
      reason: "rate_limited" | "credentials_unavailable";
      retryAfterMs: number;
    }
  | {
      status: "uncertain";
      reason: "deduplication_window_expired" | "claim_expired";
    }
  | {
      status: "failed";
      reason:
        | "destination_denied"
        | "outbound_scope_mismatch"
        | "credentials_invalid"
        | "invalid_delivery_time"
        | "message_too_large"
        | "delivery_window_expired";
    };

/** One outbound attempt; only the app API adapter declares the documented one-hour UUID contract. */
export type DeliveryTransport = ((
  request: OutboundReport,
) => Promise<TransportOutcome>) & {
  deduplication?: "lark_uuid_one_hour";
  kind?: "lark_webhook";
  /** Non-secret endpoint fingerprint, never the webhook URL or signing key. */
  binding?: string;
};

/** SQLite and fixed app/group scope; without a transport, ledger operations cannot contact Lark. */
export interface LedgerOptions extends ObservabilityOptions {
  databasePath: string;
  /** Inspect an existing migrated ledger without migrations or writes. */
  readOnly?: boolean;
  appId: string;
  sourceChatId: string;
  /** Prefer a typed recipient; legacy group callers may still supply destinationChatId. */
  recipient?: ReportRecipient;
  destinationChatId?: string;
  transport?: DeliveryTransport;
  clock?: () => number;
  newSendUuid?: () => string;
}

/**
 * Reviewed outcome with operator evidence; the attempt number fences stale decisions.
 * App-API sent decisions require an observed message ID; webhooks allow evidenced receipt review without one.
 * Not-sent only makes a later attempt eligible, preserving the original endpoint binding.
 */
export interface ReconcileDeliveryInput {
  deliveryId: string;
  now: number;
  decision: "sent" | "not-sent";
  expectedAttempt: number;
  operator: string;
  reason: string;
  messageId?: string;
}

const CLAIM_LEASE_MS = 60_000;
const REQUEST_BUDGET_MS = 15_000;
// Lark documents one hour; reserve five minutes for network delay and clock uncertainty.
const UNCERTAIN_REPLAY_MS = 55 * 60_000;
const MIN_RETRY_MS = 30_000;

/** Source evidence contradicts an earlier observation, so report preparation must stop. */
class EvidenceConflict extends Error {}

/**
 * Open an app/group-scoped ledger and apply migrations unless inspection is read-only.
 * Returned operations freeze reports, inspect state, attempt delivery or record reviewed recovery.
 */
export function openReportLedger(input: LedgerOptions) {
  const options = scopedRecipientOptions(input);
  const sqlite = new Database(options.databasePath, {
    readonly: options.readOnly ?? false,
    fileMustExist: options.readOnly ?? false,
  });
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  if (!options.readOnly) sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = FULL");
  const db = drizzle(sqlite);
  try {
    if (!options.readOnly)
      migrate(db, {
        migrationsFolder: fileURLToPath(
          new URL("../drizzle/", import.meta.url),
        ),
      });
  } catch (error) {
    sqlite.close();
    throw error;
  }
  /** Load a scoped delivery with ordered frozen entries and their evidence; foreign IDs return null. */
  function getDelivery(deliveryId: string) {
    const row = db
      .select()
      .from(deliveries)
      .where(
        and(
          eq(deliveries.id, deliveryId),
          eq(deliveries.appId, options.appId),
          eq(deliveries.sourceChatId, options.sourceChatId),
          eq(deliveries.destinationChatId, options.destinationChatId),
        ),
      )
      .get();
    if (!row) return null;
    const recipient = recipientFromKey(row.destinationChatId);
    // Preserve the older public shape for deliveries that predate endpoint binding.
    const { transportBinding, ...record } = row;
    return row
      ? {
          ...record,
          ...(transportBinding === null ? {} : { transportBinding }),
          ...(recipient?.type === "open_id" ? { recipient } : {}),
          entries: db
            .select()
            .from(reportEntries)
            .where(eq(reportEntries.deliveryId, deliveryId))
            .orderBy(asc(reportEntries.position))
            .all()
            .map((entry) => ({
              ...entry.payload,
              observation: entry.observationKey
                ? (db
                    .select()
                    .from(observations)
                    .where(eq(observations.id, entry.observationKey))
                    .get()?.payload ?? null)
                : null,
            })),
        }
      : null;
  }
  /** Return preparation reasons and any retained evidence needed for operator review. */
  function blocked(
    reasons: string[],
    evidenceVersions: EvidenceObservation[] = [],
  ) {
    return { status: "blocked" as const, reasons, evidenceVersions };
  }
  /** Find the initial logical delivery for a date/kind without requiring its generated ID. */
  function getDailyDelivery(businessDate: string, kind: "report" | "reminder") {
    const row = db
      .select({ id: deliveries.id })
      .from(deliveries)
      .where(
        and(
          eq(deliveries.appId, options.appId),
          eq(deliveries.sourceChatId, options.sourceChatId),
          eq(deliveries.destinationChatId, options.destinationChatId),
          eq(deliveries.businessDate, businessDate),
          eq(deliveries.kind, kind),
          eq(deliveries.revision, 1),
        ),
      )
      .get();
    return row ? getDelivery(row.id) : null;
  }

  /** Read bounded date-range state for discovery without loading source bodies or report entries. */
  function listDailyDeliveries(
    fromDate: string,
    throughDate: string,
    kind: "report" | "reminder",
  ) {
    return db
      .select({
        id: deliveries.id,
        businessDate: deliveries.businessDate,
        state: deliveries.state,
      })
      .from(deliveries)
      .where(
        and(
          eq(deliveries.appId, options.appId),
          eq(deliveries.sourceChatId, options.sourceChatId),
          eq(deliveries.destinationChatId, options.destinationChatId),
          eq(deliveries.kind, kind),
          eq(deliveries.revision, 1),
          sql`${deliveries.businessDate} >= ${fromDate}`,
          lte(deliveries.businessDate, throughDate),
        ),
      )
      .orderBy(asc(deliveries.businessDate))
      .all();
  }

  /** Freeze a source-group reminder independently of submission evidence and report delivery. */
  function prepareReminder(input: {
    businessDate: string;
    text: string;
    policyVersion: string;
  }) {
    const id = createHash("sha256")
      .update(
        JSON.stringify([
          options.appId,
          input.businessDate,
          options.sourceChatId,
          options.destinationChatId,
          "reminder",
          1,
        ]),
      )
      .digest("hex");
    try {
      return db.transaction(
        (tx) => {
          const existing = getDailyDelivery(input.businessDate, "reminder");
          if (existing)
            return { status: "frozen" as const, delivery: existing };
          tx.insert(deliveries)
            .values({
              id,
              appId: options.appId,
              businessDate: input.businessDate,
              sourceChatId: options.sourceChatId,
              destinationChatId: options.destinationChatId,
              kind: "reminder",
              policyVersion: input.policyVersion,
              text: input.text,
              sendUuid: (options.newSendUuid ?? randomUUID)(),
              state: "pending",
              cutoffMs: Date.parse(`${input.businessDate}T09:30:00.000+03:00`),
              textHash: createHash("sha256").update(input.text).digest("hex"),
            })
            .run();
          const delivery = getDelivery(id);
          if (!delivery) throw new Error("Frozen reminder unavailable");
          return { status: "frozen" as const, delivery };
        },
        { behavior: "immediate" },
      );
    } catch {
      return blocked(["storage_error"]);
    }
  }
  /** Freeze only the verified Doc's link; repeated calls preserve the announcement UUID. */
  function prepareBriefAnnouncement({ briefId }: { briefId: string }) {
    if (requiresRestoreReview(options.databasePath))
      return blocked(["restore_review_required"]);
    try {
      return db.transaction(
        (tx) => {
          const brief = tx
            .select()
            .from(dailyBriefs)
            .where(
              and(
                eq(dailyBriefs.id, briefId),
                eq(dailyBriefs.appId, options.appId),
                eq(dailyBriefs.sourceChatId, options.sourceChatId),
                eq(dailyBriefs.destinationChatId, options.destinationChatId),
              ),
            )
            .get();
          if (
            !brief ||
            !["verified", "published"].includes(brief.publicationState) ||
            !brief.documentUrl ||
            !brief.documentHash ||
            brief.documentRevision === null
          )
            return blocked(["document_not_verified"]);
          if (brief.announcementDeliveryId) {
            const delivery = getDelivery(brief.announcementDeliveryId);
            if (!delivery) return blocked(["announcement_unavailable"]);
            return { status: "frozen" as const, delivery };
          }
          const id = createHash("sha256")
            .update(JSON.stringify([brief.id, "brief"]))
            .digest("hex");
          const text = `Today's brief — ${brief.businessDate}\n${brief.documentUrl}`;
          tx.insert(deliveries)
            .values({
              id,
              appId: options.appId,
              sourceChatId: options.sourceChatId,
              destinationChatId: options.destinationChatId,
              businessDate: brief.businessDate,
              kind: "brief",
              revision: brief.revision,
              policyVersion: brief.policyVersion,
              text,
              textHash: createHash("sha256").update(text).digest("hex"),
              sendUuid: (options.newSendUuid ?? randomUUID)(),
              state: "pending",
              cutoffMs: brief.captureThroughMs,
            })
            .run();
          tx.update(dailyBriefs)
            .set({ announcementDeliveryId: id })
            .where(eq(dailyBriefs.id, briefId))
            .run();
          const delivery = getDelivery(id);
          if (!delivery) throw new Error("Announcement unavailable");
          return { status: "frozen" as const, delivery };
        },
        { behavior: "immediate" },
      );
    } catch {
      return blocked(["storage_error"]);
    }
  }
  /**
   * Validate coverage and submissions, then persist evidence and freeze a report atomically.
   * A valid repeat reuses the existing frozen report; no network request happens here.
   */
  function prepareDailyReport(input: PrepareReportInput) {
    if (
      input.policy.appId !== options.appId ||
      input.policy.sourceChatId !== options.sourceChatId ||
      input.policy.timeZone !== "Africa/Nairobi" ||
      !input.policy.policyVersion.trim()
    )
      return blocked(["policy_scope_mismatch"]);
    if (input.scan.status !== "complete") return blocked(["scan_incomplete"]);
    const startMs = Date.parse(`${input.businessDate}T00:00:00.000+03:00`);
    const cutoffMs = Date.parse(`${input.businessDate}T10:01:00.000+03:00`);
    if ((options.clock ?? Date.now)() < cutoffMs)
      return blocked(["before_cutoff"]);
    const current = input.scan;
    if (
      current.appId !== options.appId ||
      current.sourceChatId !== options.sourceChatId ||
      current.businessDate !== input.businessDate ||
      current.replyPolicy !== input.policy.replyPolicy ||
      !Number.isSafeInteger(current.fromMs) ||
      current.fromMs > startMs ||
      !Number.isSafeInteger(current.throughMs) ||
      current.throughMs < cutoffMs ||
      !Number.isSafeInteger(current.observedAtMs) ||
      current.observedAtMs < cutoffMs ||
      current.observedAtMs < current.throughMs
    )
      return blocked(["scan_coverage_mismatch"]);
    const evaluation = evaluateSubmissions({
      businessDate: input.businessDate,
      policy: input.policy,
      messages: input.scan.messages,
    });
    if (evaluation.status === "not_working_day")
      return blocked(["not_working_day"]);
    if (
      new Set(current.messages.map((message) => message.messageId)).size !==
        current.messages.length ||
      new Set(current.messages.map((message) => message.observationId)).size !==
        current.messages.length
    )
      return blocked(["scan_observation_conflict"]);
    const sourceTimes = new Map(
      current.messages.map((message) => [message.messageId, message.createdMs]),
    );
    evaluation.entries.sort((a, b) => {
      const time =
        (sourceTimes.get(a.evidence.messageId) ?? 0) -
        (sourceTimes.get(b.evidence.messageId) ?? 0);
      const first = JSON.stringify([
        a.senderIdentity.appId,
        a.senderIdentity.tenantKey,
        a.senderIdentity.openId,
      ]);
      const second = JSON.stringify([
        b.senderIdentity.appId,
        b.senderIdentity.tenantKey,
        b.senderIdentity.openId,
      ]);
      return time || (first < second ? -1 : first > second ? 1 : 0);
    });
    const id = createHash("sha256")
      .update(
        JSON.stringify([
          options.appId,
          input.businessDate,
          options.sourceChatId,
          options.destinationChatId,
          "report",
          1,
        ]),
      )
      .digest("hex");
    try {
      return db.transaction(
        (tx) => {
          const keys = new Map<string, string>();
          const messageKeys = new Set<string>();
          input.scan.messages.forEach((message, index) => {
            const decision = evaluation.decisions[index];
            const messageKey = JSON.stringify([
              options.appId,
              message.messageId,
            ]);
            const prior = tx
              .select()
              .from(messages)
              .where(eq(messages.id, messageKey))
              .get();
            if (
              !decision ||
              decision.reason === "unapproved_source" ||
              decision.reason === "invalid_timestamp" ||
              (decision.outcome === "excluded" &&
                decision.reason !== "duplicate_sender" &&
                decision.reason !== "deleted" &&
                !prior)
            )
              return;
            if (
              prior &&
              (prior.sourceChatId !== message.sourceChatId ||
                prior.createdMs !== message.createdMs ||
                (prior.senderIdentity.openId &&
                  message.sender.openId &&
                  prior.senderIdentity.openId !== message.sender.openId) ||
                (prior.senderIdentity.tenantKey &&
                  message.sender.tenantKey &&
                  prior.senderIdentity.tenantKey !== message.sender.tenantKey))
            )
              throw new EvidenceConflict("source_identity_conflict");
            messageKeys.add(messageKey);
            const fingerprint = createHash("sha256")
              .update(
                JSON.stringify([
                  message.updatedMs,
                  message.messageType,
                  message.content,
                  message.deleted,
                ]),
              )
              .digest("hex");
            const observationKey = JSON.stringify([messageKey, fingerprint]);
            if (prior?.deleted && !message.deleted)
              throw new EvidenceConflict("known_recall");
            if (prior && message.updatedMs < prior.updatedMs)
              throw new EvidenceConflict("stale_observation");
            if (
              prior &&
              message.updatedMs === prior.updatedMs &&
              !message.deleted &&
              !tx
                .select()
                .from(observations)
                .where(eq(observations.id, observationKey))
                .get()
            )
              throw new EvidenceConflict("source_version_conflict");
            tx.insert(messages)
              .values({
                id: messageKey,
                appId: options.appId,
                sourceChatId: message.sourceChatId,
                sourceMessageId: message.messageId,
                senderIdentity: message.sender,
                createdMs: message.createdMs,
                updatedMs: message.updatedMs,
                deleted: message.deleted,
              })
              .onConflictDoUpdate({
                target: messages.id,
                set: {
                  senderIdentity: {
                    ...prior?.senderIdentity,
                    ...message.sender,
                    ...(prior?.senderIdentity.openId
                      ? { openId: prior.senderIdentity.openId }
                      : {}),
                    ...(prior?.senderIdentity.tenantKey
                      ? { tenantKey: prior.senderIdentity.tenantKey }
                      : {}),
                  },
                  updatedMs: message.updatedMs,
                  deleted: message.deleted,
                },
              })
              .run();
            tx.insert(observations)
              .values({
                id: observationKey,
                messageKey,
                fingerprint,
                payload: {
                  ...message,
                  observedAtMs: message.observedAtMs ?? input.scan.observedAtMs,
                  normalizedText: decision.normalizedText,
                  reason: decision.reason,
                  detectorVersion: "task-list-v2",
                },
              })
              .onConflictDoNothing()
              .run();
            keys.set(message.observationId, observationKey);
          });
          const existing = getDelivery(id);
          if (existing)
            return { status: "frozen" as const, delivery: existing };
          if (evaluation.status === "needs_review") {
            const evidenceVersions = messageKeys.size
              ? tx
                  .select()
                  .from(observations)
                  .where(inArray(observations.messageKey, [...messageKeys]))
                  .all()
                  .map((row) => row.payload)
                  .sort(
                    (a, b) =>
                      a.updatedMs - b.updatedMs ||
                      a.observedAtMs - b.observedAtMs,
                  )
              : [];
            return blocked(
              evaluation.decisions
                .filter((decision) => decision.outcome === "review")
                .map((decision) => decision.reason),
              evidenceVersions,
            );
          }
          const date = new Intl.DateTimeFormat("en-GB", {
            timeZone: "Africa/Nairobi",
            day: "numeric",
            month: "long",
            year: "numeric",
          }).format(new Date(`${input.businessDate}T12:00:00.000Z`));
          const text = `${date}\n${evaluation.entries.length ? evaluation.entries.map((entry, index) => `${index + 1}. ${entry.displayName}`).join("\n") : "No valid submissions found by the approved cutoff"}`;
          tx.insert(deliveries)
            .values({
              id,
              appId: options.appId,
              businessDate: input.businessDate,
              sourceChatId: options.sourceChatId,
              destinationChatId: options.destinationChatId,
              policyVersion: input.policy.policyVersion,
              text,
              sendUuid: (options.newSendUuid ?? randomUUID)(),
              state: "pending",
              cutoffMs,
              textHash: createHash("sha256").update(text).digest("hex"),
            })
            .run();
          evaluation.entries.forEach((entry, position) => {
            const observationKey = keys.get(entry.evidence.observationId);
            const version = observationKey
              ? tx
                  .select()
                  .from(observations)
                  .where(eq(observations.id, observationKey))
                  .get()
              : undefined;
            if (!version) throw new Error("Source evidence unavailable");
            tx.insert(reportEntries)
              .values({
                deliveryId: id,
                position,
                payload: {
                  ...entry,
                  evidence: {
                    ...entry.evidence,
                    observationId: version.payload.observationId,
                  },
                },
                observationKey,
                senderIdentityKey: JSON.stringify([
                  entry.senderIdentity.appId,
                  entry.senderIdentity.tenantKey,
                  entry.senderIdentity.openId,
                ]),
              })
              .run();
          });
          const delivery = getDelivery(id);
          if (!delivery) throw new Error("Frozen report unavailable");
          return { status: "frozen" as const, delivery };
        },
        { behavior: "immediate" },
      );
    } catch (error) {
      if (error instanceof EvidenceConflict)
        return { ...blocked([error.message]), deliveryId: id };
      return { ...blocked(["storage_error"]), deliveryId: id };
    }
  }
  /** Persist a claim before networking; storage failure before that point cannot send. */
  async function deliverDelivery(input: {
    deliveryId: string;
    now: number;
    deliveryDeadlineMs?: number;
  }) {
    return withObservedRun(
      options,
      "delivery_api",
      async () => {
        const started = performance.now();
        let result: Awaited<ReturnType<typeof deliverAttempt>>;
        try {
          result = await deliverAttempt(input);
        } catch {
          result = { status: "not_sent" as const, reason: "storage_error" };
        }
        // Diagnostic reads never affect the returned delivery outcome or authorize another send.
        let delivery: ReturnType<typeof getDelivery> = null;
        if (hasOperationalLogger()) {
          try {
            delivery = getDelivery(input.deliveryId);
          } catch {
            /* Storage may be the original failure. */
          }
        }
        operationalEvent(
          result.status === "failed" ||
            ("reason" in result && result.reason === "storage_error")
            ? "error"
            : result.status === "not_sent"
              ? "debug"
              : result.status === "sent"
                ? "info"
                : "warn",
          "delivery_completed",
          {
            status: result.status,
            businessDate: delivery?.businessDate,
            kind: delivery?.kind,
            attemptCount: delivery?.attemptCount,
            adapterKind: delivery?.adapterKind,
            reason: "reason" in result ? result.reason : delivery?.lastError,
            durationMs: Math.round(performance.now() - started),
          },
        );
        return result;
      },
      { deliveryId: input.deliveryId },
    );
  }

  /** Recover expired claims, enforce retry eligibility, claim one attempt and persist its outcome. */
  async function deliverAttempt(input: {
    deliveryId: string;
    now: number;
    deliveryDeadlineMs?: number;
  }) {
    if (requiresRestoreReview(options.databasePath))
      return { status: "not_sent" as const, reason: "restore_review_required" };
    let delivery = getDelivery(input.deliveryId);
    // A crashed worker may have reached Lark before losing its acknowledgement.
    if (
      delivery &&
      delivery.state === "sending" &&
      Number.isSafeInteger(input.now) &&
      delivery.claimExpiresMs !== null &&
      input.now >= delivery.claimExpiresMs
    ) {
      db.update(deliveries)
        .set({
          state: "uncertain",
          lastError: "claim_expired",
          nextAttemptMs: input.now + MIN_RETRY_MS,
          claimToken: null,
          claimExpiresMs: null,
        })
        .where(
          and(
            eq(deliveries.id, delivery.id),
            eq(deliveries.state, "sending"),
            eq(deliveries.claimToken, delivery.claimToken ?? ""),
            eq(deliveries.claimExpiresMs, delivery.claimExpiresMs),
          ),
        )
        .run();
      delivery = getDelivery(input.deliveryId);
    }
    if (!delivery || !options.transport) return { status: "not_sent" as const };
    // Never replace damaged frozen content or missing evidence with a newly rendered report.
    if (
      delivery.cutoffMs === null ||
      delivery.textHash !==
        createHash("sha256").update(delivery.text).digest("hex") ||
      delivery.entries.some((entry) => !entry.observation)
    )
      return {
        status: "not_sent" as const,
        reason: "frozen_evidence_unavailable",
      };
    if (
      !Number.isSafeInteger(input.now) ||
      input.now < delivery.cutoffMs ||
      !Number.isSafeInteger(input.now + CLAIM_LEASE_MS)
    )
      return { status: "not_sent" as const, reason: "invalid_delivery_time" };
    if (
      delivery.kind === "reminder" &&
      input.now >= Date.parse(`${delivery.businessDate}T10:00:00.000+03:00`)
    )
      return { status: "not_sent" as const, reason: "delivery_window_expired" };
    if (
      input.deliveryDeadlineMs !== undefined &&
      (!Number.isSafeInteger(input.deliveryDeadlineMs) ||
        input.now >= input.deliveryDeadlineMs)
    )
      return { status: "not_sent" as const, reason: "delivery_window_expired" };
    if (
      delivery.attemptCount > 0 &&
      delivery.adapterKind === "lark_webhook" &&
      (options.transport.kind !== "lark_webhook" ||
        delivery.transportBinding !== options.transport.binding)
    )
      return {
        status: "not_sent" as const,
        reason: "transport_binding_changed",
      };
    // Both the current transport and the original attempt must support the same UUID contract.
    if (
      delivery.state === "uncertain" &&
      (options.transport.deduplication !== "lark_uuid_one_hour" ||
        delivery.adapterKind !== "lark_app_api")
    )
      return { status: "not_sent" as const, reason: "reconciliation_required" };
    if (
      delivery.state === "uncertain" &&
      (delivery.firstAttemptMs === null ||
        input.now >= delivery.firstAttemptMs + UNCERTAIN_REPLAY_MS)
    )
      return {
        status: "not_sent" as const,
        reason: "deduplication_window_expired",
      };
    if (
      (delivery.state === "retryable" || delivery.state === "uncertain") &&
      (delivery.nextAttemptMs === null || input.now < delivery.nextAttemptMs)
    )
      return { status: "not_sent" as const, reason: "retry_not_due" };
    // The guarded update lets one worker claim this state/attempt; the token fences late results.
    // Keep the earliest attempt time so retries cannot extend the UUID safety window.
    const claimToken = randomUUID();
    const claimed = db
      .update(deliveries)
      .set({
        state: "sending",
        adapterKind:
          options.transport.kind === "lark_webhook"
            ? "lark_webhook"
            : options.transport.deduplication === "lark_uuid_one_hour"
              ? "lark_app_api"
              : "unverified",
        transportBinding:
          options.transport.kind === "lark_webhook"
            ? (options.transport.binding ?? null)
            : null,
        claimToken,
        claimExpiresMs: input.now + CLAIM_LEASE_MS,
        attemptCount: sql`${deliveries.attemptCount} + 1`,
        firstAttemptMs: sql`coalesce(${deliveries.firstAttemptMs}, ${input.now})`,
      })
      .where(
        and(
          eq(deliveries.id, delivery.id),
          eq(deliveries.state, delivery.state),
          eq(deliveries.attemptCount, delivery.attemptCount),
          or(
            eq(deliveries.state, "pending"),
            lte(deliveries.nextAttemptMs, input.now),
          ),
          inArray(deliveries.state, ["pending", "retryable", "uncertain"]),
        ),
      )
      .returning()
      .get();
    if (!claimed) return { status: "not_sent" as const };
    // The claim is already committed. Network latency must not hold a SQLite transaction open.
    try {
      const ack = await options.transport({
        appId: claimed.appId,
        destinationChatId: claimed.destinationChatId,
        text: claimed.text,
        uuid: claimed.sendUuid,
        ...(claimed.kind === "reminder" ||
        input.deliveryDeadlineMs !== undefined
          ? {
              deliveryDeadlineMs: Math.min(
                claimed.kind === "reminder"
                  ? Date.parse(`${claimed.businessDate}T10:00:00.000+03:00`)
                  : Number.POSITIVE_INFINITY,
                input.deliveryDeadlineMs ?? Number.POSITIVE_INFINITY,
              ),
            }
          : {}),
        ...(options.transport.deduplication === "lark_uuid_one_hour"
          ? { claimDeadlineMs: input.now + CLAIM_LEASE_MS - REQUEST_BUDGET_MS }
          : {}),
        ...(delivery.state === "uncertain" && claimed.firstAttemptMs !== null
          ? { retryDeadlineMs: claimed.firstAttemptMs + UNCERTAIN_REPLAY_MS }
          : {}),
      });
      if ("status" in ack) {
        // Rejection of this replay says nothing about whether an earlier request arrived.
        const completedMs = Math.max(input.now, (options.clock ?? Date.now)());
        // Persist bounded backoff for later scheduler checks instead of sleeping inside a worker.
        const delayMs = Math.min(
          900_000,
          MIN_RETRY_MS * 2 ** Math.min(claimed.attemptCount - 1, 5),
        );
        if (
          ack.status === "retryable" &&
          (!Number.isSafeInteger(ack.retryAfterMs) ||
            ack.retryAfterMs < 0 ||
            !Number.isSafeInteger(
              completedMs + Math.max(delayMs, ack.retryAfterMs),
            ))
        )
          throw new Error("Invalid retry delay");
        const state = delivery.state === "uncertain" ? "uncertain" : ack.status;
        const saved = db
          .update(deliveries)
          .set({
            state,
            lastError: ack.reason,
            nextAttemptMs:
              ack.status === "retryable"
                ? completedMs + Math.max(delayMs, ack.retryAfterMs)
                : null,
            claimToken: null,
            claimExpiresMs: null,
          })
          .where(
            and(
              eq(deliveries.id, delivery.id),
              eq(deliveries.claimToken, claimToken),
              eq(deliveries.state, "sending"),
            ),
          )
          .returning()
          .get();
        return saved ? { status: state } : { status: "uncertain" as const };
      }
      if (
        !("messageId" in ack && ack.messageId?.trim()) &&
        !(
          "webhookAccepted" in ack &&
          ack.webhookAccepted === true &&
          claimed.adapterKind === "lark_webhook"
        )
      )
        throw new Error("Missing acknowledgement");
      // The claim token fences completions from a worker superseded by recovery/review.
      const saved = db
        .update(deliveries)
        .set({
          state: "sent",
          nextAttemptMs: null,
          lastError: null,
          messageId: "messageId" in ack ? ack.messageId : null,
          acknowledgedMs: (options.clock ?? Date.now)(),
          claimToken: null,
          claimExpiresMs: null,
        })
        .where(
          and(
            eq(deliveries.id, delivery.id),
            eq(deliveries.claimToken, claimToken),
            eq(deliveries.state, "sending"),
          ),
        )
        .returning()
        .get();
      return saved
        ? { status: "sent" as const }
        : { status: "uncertain" as const };
    } catch {
      // A transport error or failed acknowledgement write leaves the send's outcome unknown.
      try {
        db.update(deliveries)
          .set({
            state: "uncertain",
            lastError: "transport_or_acknowledgement_unknown",
            nextAttemptMs: input.now + MIN_RETRY_MS,
            claimToken: null,
            claimExpiresMs: null,
          })
          .where(
            and(
              eq(deliveries.id, delivery.id),
              eq(deliveries.claimToken, claimToken),
              eq(deliveries.state, "sending"),
            ),
          )
          .run();
      } catch {
        /* The durable in-flight claim remains; never issue another send. */
      }
      return { status: "uncertain" as const };
    }
  }

  /** Resolve an uncertain, failed or expired in-flight attempt with an audited local decision. */
  function reconcileDelivery(input: ReconcileDeliveryInput) {
    if (
      (input.decision !== "sent" && input.decision !== "not-sent") ||
      (input.decision === "sent"
        ? input.messageId !== undefined &&
          !/^om_[A-Za-z0-9_-]+$/.test(input.messageId)
        : input.messageId !== undefined) ||
      !input.operator.trim() ||
      input.operator.length > 200 ||
      !input.reason.trim() ||
      input.reason.length > 2000 ||
      !Number.isSafeInteger(input.expectedAttempt) ||
      input.expectedAttempt < 1 ||
      !Number.isSafeInteger(input.now) ||
      input.now < 0
    )
      return { status: "blocked" as const, reason: "invalid_reconciliation" };
    // An immediate transaction keeps the state check, decision and appended evidence together.
    try {
      return db.transaction(
        (tx) => {
          const delivery = getDelivery(input.deliveryId);
          // Webhook receipts contain no message ID. Reviewed group evidence can resolve them.
          if (
            delivery &&
            input.decision === "sent" &&
            delivery.adapterKind !== "lark_webhook" &&
            input.messageId === undefined
          )
            return {
              status: "blocked" as const,
              reason: "invalid_reconciliation",
            };
          if (
            !delivery ||
            !(
              delivery.state === "uncertain" ||
              delivery.state === "failed" ||
              (delivery.state === "sending" &&
                delivery.claimExpiresMs !== null &&
                input.now >= delivery.claimExpiresMs)
            ) ||
            delivery.attemptCount !== input.expectedAttempt ||
            (delivery.firstAttemptMs !== null &&
              input.now < delivery.firstAttemptMs)
          )
            return {
              status: "blocked" as const,
              reason: "stale_reconciliation",
            };
          // Not-sent clears the claim and enables a later attempt; it never calls the transport.
          // Preserve the frozen UUID and first attempt time rather than restarting their window.
          tx.update(deliveries)
            .set({
              state: input.decision === "sent" ? "sent" : "retryable",
              messageId: input.messageId ?? null,
              acknowledgedMs: input.decision === "sent" ? input.now : null,
              claimToken: null,
              claimExpiresMs: null,
              nextAttemptMs: input.decision === "not-sent" ? input.now : null,
              lastError: null,
              reconciliations: [
                ...delivery.reconciliations,
                {
                  atMs: input.now,
                  decision: input.decision,
                  expectedAttempt: input.expectedAttempt,
                  operator: input.operator.trim(),
                  reason: input.reason.trim(),
                  messageId: input.messageId ?? null,
                },
              ],
            })
            .where(
              and(
                eq(deliveries.id, delivery.id),
                eq(deliveries.state, delivery.state),
                eq(deliveries.attemptCount, input.expectedAttempt),
              ),
            )
            .run();
          return { status: "reconciled" as const };
        },
        { behavior: "immediate" },
      );
    } catch {
      return { status: "blocked" as const, reason: "storage_error" };
    }
  }

  return {
    prepareDailyReport,
    getDelivery,
    getDailyDelivery,
    listDailyDeliveries,
    prepareReminder,
    prepareBriefAnnouncement,
    deliverDelivery,
    reconcileDelivery,
    close: () => sqlite.close(),
  };
}
