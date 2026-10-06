import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BriefContent, BriefGenerationAttempt } from "./brief-content.js";
import {
  type BriefDraft,
  type BriefGenerationResult,
  type BriefGenerator,
  validateBriefRequest,
} from "./brief-generator.js";
import { type BriefLedgerOptions, openBriefLedger } from "./brief-ledger.js";
import {
  type BriefDocOptions,
  openLarkBriefDoc,
  renderBriefDoc,
} from "./lark-brief-doc.js";
import { type DeliveryTransport, openReportLedger } from "./report-ledger.js";
import { dailyBriefs } from "./storage/schema.js";
import { requiresRestoreReview } from "./storage-recovery.js";

/** Frozen-input scope plus the selected generator; time is injectable for recovery tests. */
export interface BriefCoordinatorOptions extends BriefLedgerOptions {
  generator: BriefGenerator;
  template: string;
  instructions: string;
  clock?: () => number;
  docPublishing?: BriefDocOptions;
  transport?: DeliveryTransport;
}

/** S10 coordinates generation and optional Doc publication without persisting the brief body. */
export function openBriefCoordinator(options: BriefCoordinatorOptions) {
  const docs = options.docPublishing
    ? openLarkBriefDoc(options.appId, options.docPublishing)
    : null;
  const ledger = openBriefLedger(options);
  const announcements = openReportLedger({ ...options });
  const sqlite = new Database(options.databasePath);
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  const db = drizzle(sqlite);
  const clock = options.clock ?? Date.now;
  const getBrief = ledger.getBrief;

  /** Reserve attempts before networking, then freeze operational metadata only. */
  async function completeDailyBrief({
    briefId,
    now,
    deadlineMs,
  }: {
    briefId: string;
    now: number;
    /** Optional exclusive end for a scheduled invocation; reviewed manual work may omit it. */
    deadlineMs?: number;
  }) {
    if (requiresRestoreReview(options.databasePath))
      return {
        status: "not_started" as const,
        reason: "restore_review_required",
      };
    let brief = getBrief(briefId);
    if (!brief)
      return { status: "blocked" as const, reason: "brief_not_found" };
    if (
      deadlineMs !== undefined &&
      (!Number.isSafeInteger(deadlineMs) ||
        deadlineMs <= brief.captureThroughMs)
    )
      return { status: "blocked" as const, reason: "invalid_work_deadline" };
    if (deadlineMs !== undefined && Math.max(now, clock()) >= deadlineMs)
      return { status: "not_started" as const, reason: "work_window_expired" };
    if (
      !Number.isSafeInteger(now) ||
      now < brief.captureThroughMs ||
      now > Number.MAX_SAFE_INTEGER - 45000 ||
      !Number.isSafeInteger(clock())
    )
      return { status: "blocked" as const, reason: "invalid_generation_time" };
    if (
      brief.provider !== options.provider ||
      brief.model !== options.model ||
      brief.templateVersion !== options.templateVersion ||
      brief.promptVersion !== options.promptVersion ||
      brief.schemaVersion !== options.schemaVersion ||
      brief.policyVersion !== options.policy.policyVersion
    )
      return {
        status: "blocked" as const,
        reason: "generation_configuration_mismatch",
      };
    if (
      docs &&
      brief.publicationState !== "pending" &&
      (brief.stagingFolderToken !== options.docPublishing?.stagingFolderToken ||
        brief.documentBaseUrl !== options.docPublishing?.documentBaseUrl)
    )
      return {
        status: "blocked" as const,
        reason: "publication_configuration_mismatch",
      };
    if (docs && ["verified", "published"].includes(brief.publicationState))
      return announce(briefId, deadlineMs);
    if (docs && brief.publicationState !== "pending")
      return recoverPublication(briefId, deadlineMs);
    if (brief.generationState === "review_required")
      return {
        status: "review_required" as const,
        reason: brief.generationLastError ?? "review_required",
      };
    if (
      brief.generationState === "content_ready" &&
      brief.generationKind === "ai"
    ) {
      db.update(dailyBriefs)
        .set({
          generationState: "review_required",
          generationLastError: "memory_only_content_lost",
        })
        .where(eq(dailyBriefs.id, briefId))
        .run();
      return {
        status: "review_required" as const,
        reason: "memory_only_content_lost",
      };
    }
    if (
      brief.generationState === "content_ready" &&
      brief.generationKind === "fallback"
    )
      return docs
        ? publish(briefId, sourceContent(brief), deadlineMs)
        : { status: "ready" as const, content: sourceContent(brief) };
    if (
      brief.generationState === "content_ready" &&
      brief.generationKind === "empty"
    )
      return docs
        ? publish(briefId, emptyContent(brief), deadlineMs)
        : { status: "ready" as const, content: emptyContent(brief) };
    const token = randomUUID();

    // Immediate claims serialize owners; recovery retains the original deadline and consumed reservations.
    const claimed = db.transaction(
      (tx) => {
        const current = getBrief(briefId);
        if (
          !current ||
          !["pending", "generating"].includes(current.generationState) ||
          (current.generationClaimToken &&
            (current.generationClaimExpiresMs ?? 0) > now) ||
          (current.generationNextAttemptMs !== null &&
            current.generationNextAttemptMs > now)
        )
          return null;
        tx.update(dailyBriefs)
          .set({
            generationState: "generating",
            generationStartedMs: current.entries.length
              ? (current.generationStartedMs ?? now)
              : null,
            generationDeadlineMs: current.entries.length
              ? Math.min(
                  current.generationDeadlineMs ?? now + 45000,
                  deadlineMs ?? Infinity,
                )
              : null,
            generationClaimToken: token,
            generationClaimExpiresMs: now + 20000,
          })
          .where(eq(dailyBriefs.id, briefId))
          .run();
        return current;
      },
      { behavior: "immediate" },
    );
    if (!claimed)
      return { status: "not_started" as const, reason: "claim_active" };

    brief = claimed;
    const deadline = Math.min(
      brief.generationDeadlineMs ?? now + 45000,
      deadlineMs ?? Infinity,
    );

    // Every later write is fenced, so an expired/replaced owner cannot emit or overwrite content.
    const owned = and(
      eq(dailyBriefs.id, briefId),
      eq(dailyBriefs.generationClaimToken, token),
    );
    /** Hash the memory-only handoff; generated text has no storage column. */
    async function finish(content: BriefContent) {
      if (deadlineMs !== undefined && clock() >= deadlineMs)
        return {
          status: "not_started" as const,
          reason: "work_window_expired",
        };
      if (requiresRestoreReview(options.databasePath))
        return {
          status: "not_started" as const,
          reason: "restore_review_required",
        };
      const contentHash = createHash("sha256")
        .update(JSON.stringify(content))
        .digest("hex");
      const saved = db
        .update(dailyBriefs)
        .set({
          generationState: "content_ready",
          generationKind: content.kind,
          contentHash,
          generationClaimToken: null,
          generationClaimExpiresMs: null,
          generationNextAttemptMs: null,
        })
        .where(owned)
        .run();
      if (!saved.changes)
        return { status: "not_started" as const, reason: "claim_lost" };
      return docs
        ? publish(briefId, content, deadlineMs)
        : { status: "ready" as const, content };
    }
    if (brief.entries.length === 0) return finish(emptyContent(brief));
    const request = {
      template: options.template,
      instructions: options.instructions,
      entries: brief.entries.map((entry, index) => ({
        entryRef: `entry-${index + 1}`,
        taskText: entry.normalizedText,
      })),
    };
    const invalid = validateBriefRequest(request);
    if (invalid) {
      db.update(dailyBriefs)
        .set({
          generationLastError: invalid,
          ...(brief.generationAttemptCount === 0
            ? { generationStartedMs: null, generationDeadlineMs: null }
            : {}),
        })
        .where(owned)
        .run();
      return finish(sourceContent(brief));
    }
    // A recorded successful response means a lost draft; a recorded permanent failure cannot retry.
    const prior = brief.generationAttempts.at(-1);
    if (prior?.outcome === "generated") {
      db.update(dailyBriefs)
        .set({
          generationState: "review_required",
          generationLastError: "memory_only_content_lost",
          generationClaimToken: null,
          generationClaimExpiresMs: null,
        })
        .where(owned)
        .run();
      return {
        status: "review_required" as const,
        reason: "memory_only_content_lost",
      };
    }
    if (
      (prior?.outcome === "failed" && prior.classification !== "transient") ||
      brief.generationLastError === "retry_budget_exhausted"
    )
      return finish(sourceContent(brief));
    for (let number = brief.generationAttemptCount + 1; number <= 2; number++) {
      if (clock() >= deadline) {
        db.update(dailyBriefs)
          .set({ generationLastError: "generation_budget_exhausted" })
          .where(owned)
          .run();
        break;
      }
      if (requiresRestoreReview(options.databasePath))
        return {
          status: "not_started" as const,
          reason: "restore_review_required",
        };
      const current = getBrief(briefId);
      if (!current) throw new Error("brief_not_found");
      const attempts: BriefGenerationAttempt[] = [
        ...current.generationAttempts,
        { number, reservedAtMs: clock(), outcome: "reserved" as const },
      ];
      const reserved = db
        .update(dailyBriefs)
        .set({ generationAttemptCount: number, generationAttempts: attempts })
        .where(owned)
        .run();
      if (!reserved.changes)
        return { status: "not_started" as const, reason: "claim_lost" };
      const allowance = Math.min(15000, deadline - clock());
      if (allowance <= 0) {
        db.update(dailyBriefs)
          .set({ generationLastError: "generation_budget_exhausted" })
          .where(owned)
          .run();
        break;
      }
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, allowance);
      timer.unref();
      let result: BriefGenerationResult;
      try {
        result = await options.generator.generate(request, {
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (timedOut)
        result = {
          provider: result.provider,
          model: result.model,
          usage: result.usage,
          status: "failed",
          classification: "transient",
          reason: "timeout",
        };

      const completedAtMs = clock();
      const retryDelay =
        result.status === "failed" &&
        result.classification === "transient" &&
        number < 2
          ? (result.retryAfterMs ?? 1000)
          : null;
      const nextAttemptMs =
        retryDelay !== null ? completedAtMs + retryDelay : null;
      attempts[number - 1] = {
        number,
        reservedAtMs: attempts[number - 1]?.reservedAtMs ?? now,
        completedAtMs,
        outcome: result.status === "generated" ? "generated" : "failed",
        ...(result.status === "failed"
          ? { reason: result.reason, classification: result.classification }
          : {}),
        usage: result.usage,
      };
      // Record outcome and backoff together: a crash must not forget a received Retry-After.
      const recorded = db
        .update(dailyBriefs)
        .set({
          generationAttempts: attempts,
          generationLastError:
            nextAttemptMs !== null && nextAttemptMs >= deadline
              ? "retry_budget_exhausted"
              : result.status === "failed"
                ? result.reason
                : null,
          generationNextAttemptMs:
            nextAttemptMs !== null && nextAttemptMs < deadline
              ? nextAttemptMs
              : null,
          ...(nextAttemptMs !== null && nextAttemptMs < deadline
            ? {
                generationClaimExpiresMs: Math.min(
                  deadline,
                  nextAttemptMs + 20000,
                ),
              }
            : {}),
        })
        .where(owned)
        .run();
      if (!recorded.changes)
        return { status: "not_started" as const, reason: "claim_lost" };
      if (clock() >= deadline || (timedOut && allowance < 15000)) {
        db.update(dailyBriefs)
          .set({ generationLastError: "generation_budget_exhausted" })
          .where(owned)
          .run();
        break;
      }
      if (result.status === "generated")
        return finish(aiContent(brief, result.draft));
      if (result.classification !== "transient") break;
      if (number < 2 && (result.retryAfterMs ?? 1000) >= deadline - clock()) {
        db.update(dailyBriefs)
          .set({ generationLastError: "retry_budget_exhausted" })
          .where(owned)
          .run();
        break;
      }
      if (number < 2) {
        const delay = result.retryAfterMs ?? 1000;
        const next = nextAttemptMs ?? clock() + delay;
        db.update(dailyBriefs)
          .set({
            generationNextAttemptMs: next,
            generationClaimExpiresMs: Math.min(deadline, next + 20000),
          })
          .where(owned)
          .run();
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(0, next - clock())),
        );
      }
    }
    return finish(sourceContent(brief));
  }
  /** Fence publication mutations against restore pause, lease expiry and a replacement owner. */
  function publicationFence(
    briefId: string,
    token: string,
    deadlineMs?: number,
  ) {
    const owned = and(
      eq(dailyBriefs.id, briefId),
      eq(dailyBriefs.publicationClaimToken, token),
    );
    return {
      guard() {
        const brief = getBrief(briefId);
        const current = clock();
        if (
          (deadlineMs !== undefined && current + 15000 >= deadlineMs) ||
          requiresRestoreReview(options.databasePath) ||
          !Number.isSafeInteger(current) ||
          brief?.publicationClaimToken !== token ||
          brief.publicationClaimExpiresMs === null ||
          current + 15000 >= brief.publicationClaimExpiresMs
        )
          throw new Error("Publication paused or claim unavailable");
      },
      save(values: Partial<typeof dailyBriefs.$inferInsert>) {
        if (!db.update(dailyBriefs).set(values).where(owned).run().changes)
          throw new Error("Publication claim lost");
      },
    };
  }
  /** Persist each mutation's intent and acknowledged reference before proceeding to the next operation. */
  async function publish(
    briefId: string,
    content: BriefContent,
    deadlineMs?: number,
  ) {
    if (!docs || !options.docPublishing)
      return {
        status: "blocked" as const,
        reason: "publishing_not_configured",
      };
    const token = randomUUID();
    const rendered = renderBriefDoc(content);
    const claimed = db
      .update(dailyBriefs)
      .set({
        publicationState: "creating",
        publicationClaimToken: token,
        publicationClaimExpiresMs: clock() + 10 * 60_000,
        documentHash: rendered.hash,
        stagingFolderToken: options.docPublishing.stagingFolderToken,
        documentBaseUrl: options.docPublishing.documentBaseUrl,
      })
      .where(
        and(
          eq(dailyBriefs.id, briefId),
          eq(dailyBriefs.publicationState, "pending"),
        ),
      )
      .run();
    if (!claimed.changes)
      return {
        status: "not_started" as const,
        reason: "publication_claim_active",
      };
    const owned = and(
      eq(dailyBriefs.id, briefId),
      eq(dailyBriefs.publicationClaimToken, token),
    );
    const fence = publicationFence(briefId, token, deadlineMs);
    try {
      await docs.authenticate();
      fence.guard();
      const created = await docs.create(content.title);
      const id = new URL(created.url).pathname.split("/").at(-1);
      if (!id) throw new Error("Doc reference unavailable");
      fence.save({
        documentUrl: created.url,
        documentRevision: created.revision,
        publicationState: "writing",
      });
      await docs.preparePrivate(id, fence.guard);
      let revision = created.revision;
      const tokens: string[] = [];
      for (let offset = 0; offset < rendered.blocks.length; offset += 50) {
        tokens.push(randomUUID());
        fence.save({ documentWriteTokens: [...tokens] });
        fence.guard();
        revision = await docs.write(
          id,
          rendered.blocks.slice(offset, offset + 50),
          tokens.at(-1) ?? "",
          revision,
        );
        fence.save({ documentRevision: revision });
      }
      fence.save({ publicationState: "verifying" });
      revision = await docs.verify(id, content.title, rendered.hash);
      fence.save({ publicationState: "sharing", documentRevision: revision });
      await docs.share(id, options.destinationChatId, fence.guard);
      fence.guard();
      fence.save({
        publicationState: "verified",
        publicationClaimToken: null,
        publicationClaimExpiresMs: null,
      });
      return announce(briefId, deadlineMs);
    } catch {
      const reason = getBrief(briefId)?.documentUrl
        ? "document_operation_unverified"
        : "document_creation_unknown";
      db.update(dailyBriefs)
        .set({
          publicationState: "review_required",
          publicationLastError: reason,
          publicationClaimToken: null,
          publicationClaimExpiresMs: null,
        })
        .where(owned)
        .run();
      return { status: "review_required" as const, reason };
    }
  }
  /** Announce an already verified document; the existing ledger owns send claims and UUID retries. */
  async function announce(briefId: string, deadlineMs?: number) {
    if (deadlineMs !== undefined && clock() >= deadlineMs)
      return { status: "not_started" as const, reason: "work_window_expired" };
    const frozen = announcements.prepareBriefAnnouncement({ briefId });
    if (frozen.status !== "frozen")
      return { status: "blocked" as const, reason: "announcement_unavailable" };
    db.update(dailyBriefs)
      .set({ publicationState: "published" })
      .where(eq(dailyBriefs.id, briefId))
      .run();
    const delivery = await announcements.deliverDelivery({
      deliveryId: frozen.delivery.id,
      now: clock(),
      ...(deadlineMs !== undefined ? { deliveryDeadlineMs: deadlineMs } : {}),
    });
    return {
      status: "published" as const,
      documentUrl: getBrief(briefId)?.documentUrl,
      deliveryId: frozen.delivery.id,
      delivery,
    };
  }
  /** A known Doc can be verified after response loss; recovery never writes its content again. */
  async function recoverPublication(briefId: string, deadlineMs?: number) {
    const brief = getBrief(briefId);
    if (
      brief?.publicationClaimExpiresMs !== null &&
      brief?.publicationClaimExpiresMs !== undefined &&
      brief.publicationClaimExpiresMs > clock()
    )
      return {
        status: "not_started" as const,
        reason: "publication_claim_active",
      };
    if (!docs || !brief?.documentUrl || !brief.documentHash)
      return {
        status: "review_required" as const,
        reason: "document_creation_unknown",
      };
    const token = randomUUID();
    const claimed = db.transaction(
      (tx) => {
        const current = getBrief(briefId);
        if (
          !current ||
          (current.publicationClaimExpiresMs !== null &&
            current.publicationClaimExpiresMs > clock()) ||
          ["published", "verified"].includes(current.publicationState)
        )
          return false;
        tx.update(dailyBriefs)
          .set({
            publicationClaimToken: token,
            publicationClaimExpiresMs: clock() + 10 * 60_000,
          })
          .where(eq(dailyBriefs.id, briefId))
          .run();
        return true;
      },
      { behavior: "immediate" },
    );
    if (!claimed)
      return {
        status: "not_started" as const,
        reason: "publication_claim_active",
      };
    const owned = and(
      eq(dailyBriefs.id, briefId),
      eq(dailyBriefs.publicationClaimToken, token),
    );
    const fence = publicationFence(briefId, token, deadlineMs);
    try {
      await docs.authenticate();
      const id = new URL(brief.documentUrl).pathname.split("/").at(-1);
      if (!id) throw new Error("Doc reference unavailable");
      const revision = await docs.verify(
        id,
        `Today's brief — ${brief.businessDate}`,
        brief.documentHash,
      );
      await docs.share(id, options.destinationChatId, fence.guard);
      fence.guard();
      fence.save({
        publicationState: "verified",
        documentRevision: revision,
        publicationLastError: null,
        publicationClaimToken: null,
        publicationClaimExpiresMs: null,
      });
      return announce(briefId, deadlineMs);
    } catch {
      db.update(dailyBriefs)
        .set({
          publicationState: "review_required",
          publicationLastError: "document_operation_unverified",
          publicationClaimToken: null,
          publicationClaimExpiresMs: null,
        })
        .where(owned)
        .run();
      return {
        status: "review_required" as const,
        reason: "document_operation_unverified",
      };
    }
  }
  return {
    completeDailyBrief,
    getBrief,
    getDelivery: announcements.getDelivery,
    close() {
      sqlite.close();
      ledger.close();
      announcements.close();
    },
  };
}

/** Reattach identity and ordering locally; model row ordering cannot reorder submitters. */
function aiContent(
  brief: NonNullable<
    ReturnType<ReturnType<typeof openBriefLedger>["getBrief"]>
  >,
  draft: BriefDraft,
): BriefContent {
  const summaries = new Map(
    draft.rows.map((row) => [row.entryRef, row.summary]),
  );
  return {
    kind: "ai",
    businessDate: brief.businessDate,
    title: `Today's brief — ${brief.businessDate}`,
    captureLine: "Task lists received before 10:15 AM Nairobi",
    rows: brief.entries.map((entry, index) => ({
      entryRef: `entry-${index + 1}`,
      displayName: entry.displayName,
      timeliness: entry.timeliness,
      text: summaries.get(`entry-${index + 1}`) ?? "",
      abbreviated: false,
    })),
    notes: draft.notes,
    footer: "AI-generated brief.",
  };
}

/** Fallback is reconstructed only from immutable source evidence, without another model call. */
function sourceContent(
  brief: NonNullable<
    ReturnType<ReturnType<typeof openBriefLedger>["getBrief"]>
  >,
): BriefContent {
  return {
    kind: "fallback",
    businessDate: brief.businessDate,
    title: `Today's brief — ${brief.businessDate}`,
    captureLine: "Task lists received before 10:15 AM Nairobi",
    rows: brief.entries.map((entry, index) => ({
      entryRef: `entry-${index + 1}`,
      displayName: entry.displayName,
      timeliness: entry.timeliness,
      ...sourceExtract(entry.normalizedText),
    })),
    notes: [],
    footer: "AI unavailable — prepared from submitted task lists.",
  };
}

/** Mark an abbreviated quotation explicitly; count code points so Unicode characters remain intact. */
function sourceExtract(normalizedText: string) {
  const source = normalizedText.split("\n").slice(1).join("\n").trim();
  const points = Array.from(source);
  return {
    text: points.length > 400 ? `${points.slice(0, 399).join("")}…` : source,
    abbreviated: points.length > 400,
  };
}

/** Empty captures are deterministic and never claim AI generation. */
function emptyContent(
  brief: NonNullable<
    ReturnType<ReturnType<typeof openBriefLedger>["getBrief"]>
  >,
): BriefContent {
  return {
    kind: "empty",
    businessDate: brief.businessDate,
    title: `Today's brief — ${brief.businessDate}`,
    captureLine: "Task lists received before 10:15 AM Nairobi",
    rows: [],
    notes: [],
    notice: "No qualifying task lists received before 10:15 AM Nairobi.",
    footer: "No AI generation — no qualifying submissions.",
  };
}
