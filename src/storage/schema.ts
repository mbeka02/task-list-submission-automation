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

export type EvidenceObservation = SubmissionObservation & {
  observedAtMs: number;
  normalizedText: string | null;
  reason: string;
  detectorVersion: string;
};
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
      enum: ["pending", "sending", "sent", "uncertain"],
    }).notNull(),
    messageId: text(),
    timeZone: text().notNull().default("Africa/Nairobi"),
    cutoffMs: integer(),
    textHash: text(),
    attemptCount: integer().notNull().default(0),
    firstAttemptMs: integer(),
    claimToken: text(),
    claimExpiresMs: integer(),
    acknowledgedMs: integer(),
    lastError: text(),
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
