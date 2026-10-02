import {
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
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
