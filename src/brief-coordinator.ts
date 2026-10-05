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
import { dailyBriefs } from "./storage/schema.js";
import { requiresRestoreReview } from "./storage-recovery.js";

/** Frozen-input scope plus the selected generator; time is injectable for recovery tests. */
export interface BriefCoordinatorOptions extends BriefLedgerOptions {
  generator: BriefGenerator;
  template: string;
  instructions: string;
  clock?: () => number;
}

/** S10 owns generation attempts and memory-only document content; it never publishes or sends. */
export function openBriefCoordinator(options: BriefCoordinatorOptions) {
  const ledger = openBriefLedger(options);
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
  }: {
    briefId: string;
    now: number;
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
      return { status: "ready" as const, content: sourceContent(brief) };
    if (
      brief.generationState === "content_ready" &&
      brief.generationKind === "empty"
    )
      return { status: "ready" as const, content: emptyContent(brief) };
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
              ? (current.generationDeadlineMs ?? now + 45000)
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
    const deadline = brief.generationDeadlineMs ?? now + 45000;

    // Every later write is fenced, so an expired/replaced owner cannot emit or overwrite content.
    const owned = and(
      eq(dailyBriefs.id, briefId),
      eq(dailyBriefs.generationClaimToken, token),
    );
    /** Hash the memory-only handoff; generated text has no storage column. */
    function finish(content: BriefContent) {
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
      return { status: "ready" as const, content };
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
  return {
    completeDailyBrief,
    getBrief,
    close() {
      sqlite.close();
      ledger.close();
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
