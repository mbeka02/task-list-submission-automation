import { sql } from "drizzle-orm";
import {
  check,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { BriefGenerationAttempt } from "../brief-content.js";
import type { BriefEntry } from "../brief-submissions.js";
import type {
  SubmissionEntry,
  SubmissionObservation,
} from "../evaluate-submissions.js";

/** Observed source content and detector provenance; this is evidence, not a full Lark revision history. */
export type EvidenceObservation = SubmissionObservation & {
  observedAtMs: number;
  normalizedText: string | null;
  reason: string;
  detectorVersion: string;
};
/** Stable app-scoped source message identity and its latest known lifecycle state. */
export const messages = sqliteTable(
  "message",
  {
    id: text().primaryKey(),
    appId: text().notNull(),
    sourceChatId: text().notNull(),
    sourceMessageId: text().notNull(),
    senderIdentity: text({ mode: "json" })
      .$type<SubmissionObservation["sender"]>()
      .notNull(),
    createdMs: integer().notNull(),
    updatedMs: integer().notNull(),
    deleted: integer({ mode: "boolean" }).notNull(),
  },
  (table) => [
    uniqueIndex("message_app_source_id").on(table.appId, table.sourceMessageId),
  ],
);
/** Immutable observed versions linked to a message; fingerprints prevent duplicate evidence. */
export const observations = sqliteTable(
  "message_observation",
  {
    id: text().primaryKey(),
    messageKey: text()
      .notNull()
      .references(() => messages.id),
    fingerprint: text().notNull(),
    payload: text({ mode: "json" }).$type<EvidenceObservation>().notNull(),
  },
  (table) => [
    uniqueIndex("observation_message_version").on(
      table.messageKey,
      table.fingerprint,
    ),
  ],
);

/** Operator evidence appended atomically with a reviewed delivery decision. */
export interface DeliveryReconciliation {
  atMs: number;
  decision: "sent" | "not-sent";
  expectedAttempt: number;
  operator: string;
  reason: string;
  messageId: string | null;
}

/** One frozen report plus durable claims, retry eligibility, acknowledgement and recovery history. */
export const deliveries = sqliteTable(
  "daily_delivery",
  {
    id: text().primaryKey(),
    appId: text().notNull(),
    businessDate: text().notNull(),
    sourceChatId: text().notNull(),
    destinationChatId: text().notNull(),
    kind: text().notNull().default("report"),
    revision: integer().notNull().default(1),
    policyVersion: text().notNull(),
    text: text().notNull(),
    sendUuid: text().notNull(),
    state: text({
      enum: ["pending", "sending", "sent", "uncertain", "retryable", "failed"],
    }).notNull(),
    messageId: text(),
    timeZone: text().notNull().default("Africa/Nairobi"),
    cutoffMs: integer(),
    textHash: text(),
    attemptCount: integer().notNull().default(0),
    // Earliest attempt anchors the UUID replay window; retries and reviews never reset it.
    firstAttemptMs: integer(),
    nextAttemptMs: integer(),
    // Remember the sending adapter so a new adapter cannot grant old attempts UUID protection.
    adapterKind: text({ enum: ["lark_app_api", "unverified"] }),
    // The token fences stale workers; expiry means the outcome needs recovery, not that sending failed.
    claimToken: text(),
    claimExpiresMs: integer(),
    acknowledgedMs: integer(),
    lastError: text(),
    reconciliations: text({ mode: "json" })
      .$type<DeliveryReconciliation[]>()
      .notNull()
      .default([]),
  },
  (table) => [
    uniqueIndex("delivery_business_key").on(
      table.appId,
      table.businessDate,
      table.sourceChatId,
      table.destinationChatId,
      table.kind,
      table.revision,
    ),
    uniqueIndex("delivery_send_uuid").on(table.sendUuid),
  ],
);

/** Ordered sender/name snapshots and exact evidence used by a delivery, preserved through later edits. */
export const reportEntries = sqliteTable(
  "report_entry",
  {
    deliveryId: text()
      .notNull()
      .references(() => deliveries.id),
    position: integer().notNull(),
    payload: text({ mode: "json" }).$type<SubmissionEntry>().notNull(),
    observationKey: text().references(() => observations.id),
    senderIdentityKey: text(),
  },
  (table) => [
    primaryKey({ columns: [table.deliveryId, table.position] }),
    uniqueIndex("report_distinct_sender").on(
      table.deliveryId,
      table.senderIdentityKey,
    ),
  ],
);

/** One immutable brief input per scoped date/revision; generated Doc content is never stored here. */
export const dailyBriefs = sqliteTable(
  "daily_brief",
  {
    id: text().primaryKey(),
    appId: text().notNull(),
    businessDate: text().notNull(),
    sourceChatId: text().notNull(),
    destinationChatId: text().notNull(),
    revision: integer().notNull().default(1),
    captureThroughMs: integer().notNull(),
    observedAtMs: integer().notNull(),
    inputFingerprint: text().notNull(),
    policyVersion: text().notNull(),
    templateVersion: text().notNull(),
    promptVersion: text().notNull(),
    schemaVersion: text().notNull(),
    provider: text({ enum: ["gemini", "deepseek"] }).notNull(),
    model: text().notNull(),
    outputMode: text({ enum: ["doc"] })
      .notNull()
      .default("doc"),
    state: text({ enum: ["input_frozen"] })
      .notNull()
      .default("input_frozen"),
    // Input state stays immutable; generation metadata evolves without storing a Doc body.
    generationState: text({
      enum: ["pending", "generating", "content_ready", "review_required"],
    })
      .notNull()
      .default("pending"),
    generationStartedMs: integer(),
    generationDeadlineMs: integer(),
    generationAttemptCount: integer().notNull().default(0),
    generationAttempts: text({ mode: "json" })
      .$type<BriefGenerationAttempt[]>()
      .notNull()
      .default([]),
    generationKind: text({ enum: ["ai", "fallback", "empty"] }),
    contentHash: text(),
    generationClaimToken: text(),
    generationClaimExpiresMs: integer(),
    generationNextAttemptMs: integer(),
    generationLastError: text(),
  },
  (table) => [
    check("brief_valid_revision", sql`${table.revision} >= 1`),
    check(
      "brief_valid_capture",
      sql`${table.captureThroughMs} >= 0 AND ${table.observedAtMs} >= ${table.captureThroughMs}`,
    ),
    check(
      "brief_valid_provider",
      sql`${table.provider} IN ('gemini', 'deepseek')`,
    ),
    check("brief_doc_mode", sql`${table.outputMode} = 'doc'`),
    check("brief_input_state", sql`${table.state} = 'input_frozen'`),
    check(
      "brief_generation_state",
      sql`${table.generationState} IN ('pending', 'generating', 'content_ready', 'review_required')`,
    ),
    check(
      "brief_generation_attempt_cap",
      sql`${table.generationAttemptCount} BETWEEN 0 AND 2`,
    ),
    check(
      "brief_generation_kind",
      sql`${table.generationKind} IS NULL OR ${table.generationKind} IN ('ai', 'fallback', 'empty')`,
    ),
    check(
      "brief_generation_attempt_json",
      sql`json_valid(${table.generationAttempts}) AND json_type(${table.generationAttempts}) = 'array' AND json_array_length(${table.generationAttempts}) = ${table.generationAttemptCount}`,
    ),
    uniqueIndex("brief_business_key").on(
      table.appId,
      table.businessDate,
      table.sourceChatId,
      table.destinationChatId,
      table.revision,
    ),
  ],
);

/** Ordered source task text and name snapshots; exact evidence stays protected by a foreign key. */
export const briefEntries = sqliteTable(
  "brief_entry",
  {
    briefId: text()
      .notNull()
      .references(() => dailyBriefs.id),
    position: integer().notNull(),
    senderIdentityKey: text().notNull(),
    observationKey: text()
      .notNull()
      .references(() => observations.id),
    payload: text({ mode: "json" }).$type<BriefEntry>().notNull(),
  },
  (table) => [
    check("brief_valid_position", sql`${table.position} >= 0`),
    check(
      "brief_valid_entry",
      sql`json_valid(${table.payload}) AND coalesce(json_extract(${table.payload}, '$.timeliness') IN ('on_time', 'late'), 0)`,
    ),
    primaryKey({ columns: [table.briefId, table.position] }),
    uniqueIndex("brief_distinct_sender").on(
      table.briefId,
      table.senderIdentityKey,
    ),
  ],
);
