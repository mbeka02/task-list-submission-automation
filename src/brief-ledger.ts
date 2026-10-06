import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { BriefEntry, BriefScan } from "./brief-submissions.js";
import { evaluateBriefObservations } from "./evaluate-submissions.js";
import type { ReportPolicy } from "./report-ledger.js";
import {
  briefEntries,
  dailyBriefs,
  messages,
  observations,
} from "./storage/schema.js";

/** Fixed ledger scope and generation versions; preparation performs no external calls. */
export interface BriefLedgerOptions {
  databasePath: string;
  appId: string;
  sourceChatId: string;
  destinationChatId: string;
  policy: ReportPolicy;
  templateVersion: string;
  promptVersion: string;
  schemaVersion: string;
  provider: "gemini" | "deepseek";
  model: string;
  /** Inspect existing migrated storage without creating files, applying migrations or changing WAL mode. */
  readOnly?: boolean;
}

/** A classified history capture from S7; only complete, resolved captures may be frozen. */
export interface PrepareBriefInput {
  businessDate: string;
  scan: BriefScan;
}

/** Shared date validation keeps invalid calendar entries from silently behaving as working days. */
function validDate(value: string) {
  const ms = Date.parse(`${value}T12:00:00Z`);
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(ms) &&
    new Date(ms).toISOString().slice(0, 10) === value
  );
}

/** Compare meaning rather than JSON object insertion order; use only the approved input fields. */
function entryKey(entry: BriefEntry) {
  return [
    entry.senderIdentity.appId,
    entry.senderIdentity.tenantKey,
    entry.senderIdentity.openId,
    entry.displayName,
    entry.evidence.messageId,
    entry.evidence.observationId,
    entry.createdMs,
    entry.timeliness,
    entry.normalizedText,
  ];
}

/** Deterministic digest for job identity and frozen-input verification. */
function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** A contradiction aborts every write in the freezing transaction. */
class EvidenceConflict extends Error {}

/** Open the SQLite brief ledger; short immediate transactions freeze input before generation begins. */
export function openBriefLedger(options: BriefLedgerOptions) {
  const sqlite = new Database(options.databasePath, {
    readonly: options.readOnly ?? false,
    fileMustExist: options.readOnly ?? false,
  });
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  if (!options.readOnly) {
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("synchronous = FULL");
  }
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

  /** Inspect a scoped job with its ordered input and immutable source evidence; foreign IDs return null. */
  function getBrief(briefId: string) {
    const row = db
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
    if (!row) return null;
    return {
      ...row,
      entries: db
        .select()
        .from(briefEntries)
        .where(eq(briefEntries.briefId, briefId))
        .orderBy(asc(briefEntries.position))
        .all()
        .map((entry) => ({
          ...entry.payload,
          observation:
            db
              .select()
              .from(observations)
              .where(eq(observations.id, entry.observationKey))
              .get()?.payload ?? null,
        })),
    };
  }

  /** Return the original input on repeat preparation, regardless of later edits or model changes. */
  function prepareDailyBrief(input: PrepareBriefInput) {
    if (options.readOnly)
      return { status: "blocked" as const, reasons: ["inspection_only"] };
    const id = hash([
      options.appId,
      input.businessDate,
      options.sourceChatId,
      options.destinationChatId,
      1,
    ]);
    try {
      return db.transaction(
        (tx) => {
          const existing = getBrief(id);
          if (existing) return { status: "existing" as const, brief: existing };
          if (!validDate(input.businessDate))
            return {
              status: "blocked" as const,
              reasons: ["invalid_business_date"],
            };
          if (
            options.policy.appId !== options.appId ||
            options.policy.sourceChatId !== options.sourceChatId ||
            options.policy.timeZone !== "Africa/Nairobi" ||
            options.policy.replyPolicy === "include" ||
            !Array.isArray(options.policy.publicHolidays) ||
            options.policy.publicHolidays.some((day) => !validDate(day)) ||
            ![
              options.appId,
              options.sourceChatId,
              options.destinationChatId,
              options.policy.policyVersion,
              options.templateVersion,
              options.promptVersion,
              options.schemaVersion,
              options.model,
            ].every(
              (value) => typeof value === "string" && value.trim().length > 0,
            ) ||
            !["gemini", "deepseek"].includes(options.provider)
          )
            return {
              status: "blocked" as const,
              reasons: ["invalid_configuration"],
            };
          const current = input.scan;
          const start = Date.parse(`${input.businessDate}T00:00:00+03:00`);
          const through = Date.parse(`${input.businessDate}T10:15:00+03:00`);
          if (current.status !== "complete")
            return { status: "blocked" as const, reasons: [current.status] };
          if (
            current.appId !== options.appId ||
            current.sourceChatId !== options.sourceChatId ||
            current.businessDate !== input.businessDate ||
            current.replyPolicy !== "exclude" ||
            !Number.isSafeInteger(current.fromMs) ||
            current.fromMs !== start ||
            !Number.isSafeInteger(current.throughMs) ||
            current.throughMs !== through ||
            !Number.isSafeInteger(current.observedAtMs) ||
            current.observedAtMs < through
          )
            return {
              status: "blocked" as const,
              reasons: ["scan_coverage_mismatch"],
            };
          // Reclassify the source rather than trusting caller-supplied membership or late labels.
          const evaluation = evaluateBriefObservations({
            businessDate: input.businessDate,
            policy: { ...options.policy, replyPolicy: "exclude" },
            messages: current.messages,
          });
          if (evaluation.status !== "ready")
            return { status: "blocked" as const, reasons: [evaluation.status] };
          if (
            new Set(current.messages.map((source) => source.messageId)).size !==
              current.messages.length ||
            new Set(current.messages.map((source) => source.observationId))
              .size !== current.messages.length
          )
            return {
              status: "blocked" as const,
              reasons: ["scan_observation_conflict"],
            };
          const validatedEntries = evaluation.entries.map((entry) => {
            const source = current.messages.find(
              (message) =>
                message.observationId === entry.evidence.observationId,
            );
            const decision = evaluation.decisions.find(
              (value) => value.observationId === entry.evidence.observationId,
            );
            if (!source || decision?.normalizedText == null)
              throw new Error("missing_evidence");
            return {
              ...entry,
              createdMs: source.createdMs,
              normalizedText: decision.normalizedText,
              timeliness:
                source.createdMs <
                Date.parse(`${input.businessDate}T10:01:00+03:00`)
                  ? ("on_time" as const)
                  : ("late" as const),
            };
          });
          if (
            hash(validatedEntries.map(entryKey)) !==
            hash(current.entries.map(entryKey))
          )
            return {
              status: "blocked" as const,
              reasons: ["scan_membership_mismatch"],
            };
          tx.insert(dailyBriefs)
            .values({
              id,
              appId: options.appId,
              businessDate: input.businessDate,
              sourceChatId: options.sourceChatId,
              destinationChatId: options.destinationChatId,
              captureThroughMs: input.scan.throughMs,
              observedAtMs: input.scan.observedAtMs,
              inputFingerprint: hash(validatedEntries.map(entryKey)),
              policyVersion: options.policy.policyVersion,
              templateVersion: options.templateVersion,
              promptVersion: options.promptVersion,
              schemaVersion: options.schemaVersion,
              provider: options.provider,
              model: options.model,
            })
            .run();
          validatedEntries.forEach((entry, position) => {
            const source = input.scan.messages.find(
              (message) =>
                message.observationId === entry.evidence.observationId,
            );
            if (!source) throw new Error("missing_evidence");
            const messageKey = JSON.stringify([
              options.appId,
              source.messageId,
            ]);
            const fingerprint = hash([
              source.updatedMs,
              source.messageType,
              source.content,
              source.deleted,
            ]);
            const observationKey = JSON.stringify([messageKey, fingerprint]);
            const prior = tx
              .select()
              .from(messages)
              .where(eq(messages.id, messageKey))
              .get();
            if (
              prior &&
              (prior.sourceChatId !== source.sourceChatId ||
                prior.createdMs !== source.createdMs ||
                (prior.senderIdentity.openId &&
                  prior.senderIdentity.openId !== source.sender.openId) ||
                (prior.senderIdentity.tenantKey &&
                  prior.senderIdentity.tenantKey !== source.sender.tenantKey))
            )
              throw new EvidenceConflict("source_identity_conflict");
            if (prior?.deleted) throw new EvidenceConflict("known_recall");
            if (prior && source.updatedMs < prior.updatedMs)
              throw new EvidenceConflict("stale_observation");
            if (
              prior &&
              source.updatedMs === prior.updatedMs &&
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
                sourceChatId: source.sourceChatId,
                sourceMessageId: source.messageId,
                senderIdentity: source.sender,
                createdMs: source.createdMs,
                updatedMs: source.updatedMs,
                deleted: source.deleted,
              })
              .onConflictDoUpdate({
                target: messages.id,
                set: {
                  updatedMs: source.updatedMs,
                  deleted: source.deleted,
                  senderIdentity: source.sender,
                },
              })
              .run();
            // Matching evidence keeps its first detector/identity metadata; the entry freezes the resolved identity.
            tx.insert(observations)
              .values({
                id: observationKey,
                messageKey,
                fingerprint,
                payload: {
                  ...source,
                  observedAtMs: source.observedAtMs ?? input.scan.observedAtMs,
                  normalizedText: entry.normalizedText,
                  reason: "task_list",
                  detectorVersion: "brief-task-list-v1",
                },
              })
              .onConflictDoNothing()
              .run();
            tx.insert(briefEntries)
              .values({
                briefId: id,
                position,
                senderIdentityKey: JSON.stringify([
                  entry.senderIdentity.appId,
                  entry.senderIdentity.tenantKey,
                  entry.senderIdentity.openId,
                ]),
                observationKey,
                payload: entry,
              })
              .run();
          });
          const brief = getBrief(id);
          if (!brief) throw new Error("missing_brief");
          return { status: "frozen" as const, brief };
        },
        { behavior: "immediate" },
      );
    } catch (error) {
      if (error instanceof EvidenceConflict)
        return { status: "blocked" as const, reasons: [error.message] };
      throw error;
    }
  }
  /** Read one initial scoped job; repeat preparation and recovery share this identity. */
  function getDailyBrief(businessDate: string) {
    return getBrief(
      hash([
        options.appId,
        businessDate,
        options.sourceChatId,
        options.destinationChatId,
        1,
      ]),
    );
  }
  /** Bounded date-range metadata for status/backfill, excluding task bodies and generated content. */
  function listDailyBriefs(fromDate: string, throughDate: string) {
    return db
      .select({
        id: dailyBriefs.id,
        businessDate: dailyBriefs.businessDate,
        generationState: dailyBriefs.generationState,
        publicationState: dailyBriefs.publicationState,
        documentUrl: dailyBriefs.documentUrl,
        announcementDeliveryId: dailyBriefs.announcementDeliveryId,
      })
      .from(dailyBriefs)
      .where(
        and(
          eq(dailyBriefs.appId, options.appId),
          eq(dailyBriefs.sourceChatId, options.sourceChatId),
          eq(dailyBriefs.destinationChatId, options.destinationChatId),
          eq(dailyBriefs.revision, 1),
          gte(dailyBriefs.businessDate, fromDate),
          lte(dailyBriefs.businessDate, throughDate),
        ),
      )
      .orderBy(asc(dailyBriefs.businessDate))
      .all();
  }
  return {
    prepareDailyBrief,
    getBrief,
    getDailyBrief,
    listDailyBriefs,
    close: () => sqlite.close(),
  };
}
