import { openBriefCoordinator } from "./brief-coordinator.js";
import type { BriefGenerator } from "./brief-generator.js";
import { openBriefLedger } from "./brief-ledger.js";
import { createBriefSubmissionReader } from "./brief-submissions.js";
import type { BriefDocOptions } from "./lark-brief-doc.js";
import {
  type DeliveryTransport,
  openReportLedger,
  type ReportPolicy,
} from "./report-ledger.js";
import { requiresRestoreReview } from "./storage-recovery.js";
import {
  createSubmissionHistoryReader,
  type HistoryReaderOptions,
} from "./submission-history.js";

/** Versioned holiday dates and the interval explicitly reviewed by the calendar owner. */
export interface HolidayCalendar {
  version: string;
  fromDate: string;
  throughDate: string;
  reviewedOn: string;
  sourceUrls: readonly string[];
  publicHolidays: readonly string[];
}

/** Fixed worker scope, reviewed policy and external adapters; clocks return epoch milliseconds. */
export interface DueWorkerOptions {
  databasePath: string;
  appId: string;
  sourceChatId: string;
  destinationChatId: string;
  activationDate: string;
  calendar: HolidayCalendar;
  policy: Omit<
    ReportPolicy,
    "appId" | "sourceChatId" | "timeZone" | "publicHolidays"
  >;
  reminderText: string;
  reader: HistoryReaderOptions;
  transport?: DeliveryTransport;
  clock?: () => number;
  restoreMode?: boolean;
  /** Inspect an existing migrated ledger only; runDueWork is disabled on this instance. */
  readOnly?: boolean;
  /** Optional supplementary brief; capture-only never invokes generation or publication. */
  brief?: {
    mode: "capture_only" | "publish";
    activationDate: string;
    provider: "gemini" | "deepseek";
    model: string;
    templateVersion: string;
    promptVersion: string;
    schemaVersion: string;
    generator?: BriefGenerator;
    template?: string;
    instructions?: string;
    docPublishing?: BriefDocOptions;
  };
}

/** Require a real ISO business date, rejecting normalized impossible dates such as 30 February. */
function validDate(value: string): boolean {
  const parsed = Date.parse(`${value}T12:00:00.000Z`);
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(parsed) &&
    new Date(parsed).toISOString().slice(0, 10) === value
  );
}

/** Check reviewed coverage and provenance shape; metadata alone cannot prove official completeness. */
function validCalendar(
  calendar: HolidayCalendar,
  activationDate: string,
  today: string,
): boolean {
  return (
    Boolean(calendar.version.trim()) &&
    validDate(calendar.fromDate) &&
    validDate(calendar.throughDate) &&
    calendar.fromDate <= calendar.throughDate &&
    calendar.fromDate <= activationDate &&
    activationDate <= calendar.throughDate &&
    calendar.fromDate <= today &&
    today <= calendar.throughDate &&
    validDate(calendar.reviewedOn) &&
    calendar.reviewedOn <= today &&
    calendar.sourceUrls.length > 0 &&
    calendar.sourceUrls.every((source) => {
      try {
        return new URL(source).protocol === "https:";
      } catch {
        return false;
      }
    }) &&
    calendar.publicHolidays.every(
      (date) =>
        validDate(date) &&
        date >= calendar.fromDate &&
        date <= calendar.throughDate,
    )
  );
}

/** Project operator state without exposing report text or source content. */
function deliveryStatus(
  delivery: NonNullable<
    ReturnType<ReturnType<typeof openReportLedger>["getDelivery"]>
  >,
  now: number,
  windowOpen: boolean,
) {
  const expiredReplay =
    delivery.adapterKind !== "lark_app_api" ||
    delivery.firstAttemptMs === null ||
    now >= delivery.firstAttemptMs + 55 * 60_000;
  return {
    state: delivery.state,
    deliveryId: delivery.id,
    messageId: delivery.messageId,
    attemptCount: delivery.attemptCount,
    firstAttemptMs: delivery.firstAttemptMs,
    nextAttemptMs: delivery.nextAttemptMs,
    claimExpiresMs: delivery.claimExpiresMs,
    lastError: delivery.lastError,
    policyVersion: delivery.policyVersion,
    eligible:
      windowOpen &&
      (delivery.state === "pending" ||
        ((delivery.state === "retryable" || delivery.state === "uncertain") &&
          delivery.nextAttemptMs !== null &&
          now >= delivery.nextAttemptMs &&
          (delivery.state !== "uncertain" || !expiredReplay))),
    reconciliationRequired:
      delivery.state === "failed" ||
      (delivery.state === "uncertain" &&
        (!windowOpen || expiredReplay || delivery.nextAttemptMs === null)) ||
      (delivery.state === "sending" &&
        delivery.claimExpiresMs !== null &&
        now >= delivery.claimExpiresMs),
  };
}

/** Coordinate reminder/report due work through the approved S5 operations. */
export function createDueWorker(options: DueWorkerOptions) {
  const briefConfigurationValid =
    !options.brief ||
    (["capture_only", "publish"].includes(options.brief.mode) &&
      ["gemini", "deepseek"].includes(options.brief.provider) &&
      validDate(options.brief.activationDate) &&
      options.brief.activationDate >= options.activationDate &&
      options.brief.activationDate >= options.calendar.fromDate &&
      options.brief.activationDate <= options.calendar.throughDate &&
      [
        options.brief.model,
        options.brief.templateVersion,
        options.brief.promptVersion,
        options.brief.schemaVersion,
      ].every((value) => Boolean(value.trim())) &&
      (options.brief.mode === "capture_only" ||
        Boolean(
          options.brief.generator &&
            options.brief.template?.trim() &&
            options.brief.instructions?.trim() &&
            options.brief.docPublishing,
        )));
  const reminderLedger = openReportLedger({
    ...options,
    destinationChatId: options.sourceChatId,
  });
  const reportLedger = openReportLedger(options);
  const reader = createSubmissionHistoryReader({
    ...options.reader,
    clock: options.clock ?? Date.now,
  });
  const briefPolicy: ReportPolicy = {
    ...options.policy,
    appId: options.appId,
    sourceChatId: options.sourceChatId,
    timeZone: "Africa/Nairobi",
    publicHolidays: options.calendar.publicHolidays,
    policyVersion: `${options.policy.policyVersion}/${options.calendar.version}`,
  };
  const briefLedger =
    options.brief && briefConfigurationValid
      ? openBriefLedger({ ...options, ...options.brief, policy: briefPolicy })
      : null;
  const briefReader =
    options.brief && briefConfigurationValid
      ? createBriefSubmissionReader({
          ...options.reader,
          policy: briefPolicy,
          clock: options.clock ?? Date.now,
        })
      : null;
  // Recent read/preparation failures describe this process; durable delivery state survives restart.
  let reportIssue: {
    businessDate: string;
    reason: string;
    reasons: readonly string[];
  } | null = null;
  // Capture failures are process-local; an already frozen brief always wins over later reads.
  let briefIssue: {
    businessDate: string;
    reason: string;
    reasons: readonly string[];
  } | null = null;
  /** Surface prior unfinished reports for review; discovery itself never reads or sends Lark work. */
  function backfillStatus(today: string) {
    const prior = new Map(
      reportLedger
        .listDailyDeliveries(options.activationDate, today, "report")
        .map((delivery) => [delivery.businessDate, delivery]),
    );
    const dates: string[] = [];
    let total = 0;
    for (
      let day = Date.parse(`${options.activationDate}T12:00:00.000Z`);
      day < Date.parse(`${today}T12:00:00.000Z`);
      day += 86_400_000
    ) {
      const date = new Date(day).toISOString().slice(0, 10);
      const weekday = new Date(day).getUTCDay();
      const saved = prior.get(date);
      // Calendar revisions must not hide a delivery that still needs operator review.
      if (
        saved?.state === "sent" ||
        (!saved &&
          (weekday === 0 ||
            weekday === 6 ||
            options.calendar.publicHolidays.includes(date)))
      )
        continue;
      total += 1;
      if (dates.length < 31) dates.push(date);
    }
    const items = dates.map((businessDate) => {
      const saved = prior.get(businessDate);
      return saved
        ? { businessDate, deliveryId: saved.id, state: saved.state }
        : { businessDate, state: "missing" as const };
    });
    return { dates, items, total, truncated: total > dates.length };
  }
  /** Keep old uncertain/failed reminders visible even though their send windows cannot reopen. */
  function reminderReviews(today: string, now: number) {
    const items = reminderLedger
      .listDailyDeliveries(options.activationDate, today, "reminder")
      .filter((row) => ["uncertain", "failed", "sending"].includes(row.state))
      .flatMap((row) => {
        const delivery = reminderLedger.getDelivery(row.id);
        if (!delivery) return [];
        const summary = deliveryStatus(
          delivery,
          now,
          row.businessDate === today &&
            now < Date.parse(`${today}T10:00:00.000+03:00`),
        );
        return summary.reconciliationRequired
          ? [{ businessDate: row.businessDate, ...summary }]
          : [];
      });
    return {
      items: items.slice(0, 31),
      total: items.length,
      truncated: items.length > 31,
    };
  }
  /** Inspect current business-date work without creating deliveries or contacting Lark. */
  function getCoreStatus({ now }: { now: number }) {
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      !Number.isFinite(new Date(now + 3 * 3600_000).getTime())
    )
      return {
        status: "blocked" as const,
        reason: "invalid_clock",
        businessDate: null,
        reminder: { state: "blocked" as const, reason: "invalid_clock" },
        report: { state: "blocked" as const, reason: "invalid_clock" },
      };
    const businessDate = new Date(now + 3 * 3600_000)
      .toISOString()
      .slice(0, 10);
    if (
      !validDate(options.activationDate) ||
      !options.appId.trim() ||
      !options.sourceChatId.trim() ||
      !options.destinationChatId.trim() ||
      options.reader.appId !== options.appId ||
      options.reader.sourceChatId !== options.sourceChatId ||
      !options.policy.policyVersion.trim() ||
      options.policy.replyPolicy !== "exclude" ||
      !options.reminderText.trim()
    )
      return {
        status: "blocked" as const,
        reason: "invalid_worker_configuration",
        businessDate,
        reminder: {
          state: "blocked" as const,
          reason: "invalid_worker_configuration",
        },
        report: {
          state: "blocked" as const,
          reason: "invalid_worker_configuration",
        },
      };
    if (!validCalendar(options.calendar, options.activationDate, businessDate))
      return {
        status: "blocked" as const,
        reason: "invalid_calendar",
        businessDate,
        reminder: { state: "blocked" as const, reason: "invalid_calendar" },
        report: { state: "blocked" as const, reason: "invalid_calendar" },
      };
    if (options.restoreMode || requiresRestoreReview(options.databasePath))
      return {
        status: "paused" as const,
        reason: "restore_review_required",
        businessDate,
        backfill: backfillStatus(businessDate),
        reminderReviews: reminderReviews(businessDate, now),
        reminder: {
          state: "blocked" as const,
          reason: "restore_review_required",
        },
        report: {
          state: "blocked" as const,
          reason: "restore_review_required",
        },
      };
    if (businessDate < options.activationDate)
      return {
        status: "ok" as const,
        businessDate,
        reminder: { state: "skipped" as const, reason: "before_activation" },
        report: { state: "skipped" as const, reason: "before_activation" },
      };
    const weekday = new Date(`${businessDate}T12:00:00.000Z`).getUTCDay();
    if (
      weekday === 0 ||
      weekday === 6 ||
      options.calendar.publicHolidays.includes(businessDate)
    )
      return {
        status: "ok" as const,
        businessDate,
        reminder: { state: "skipped" as const, reason: "not_working_day" },
        report: { state: "skipped" as const, reason: "not_working_day" },
        backfill: backfillStatus(businessDate),
        reminderReviews: reminderReviews(businessDate, now),
      };
    const delivery = reminderLedger.getDailyDelivery(businessDate, "reminder");
    const report = reportLedger.getDailyDelivery(businessDate, "report");
    return {
      status: "ok" as const,
      businessDate,
      backfill: backfillStatus(businessDate),
      reminderReviews: reminderReviews(businessDate, now),
      reminder: delivery
        ? deliveryStatus(
            delivery,
            now,
            now >= Date.parse(`${businessDate}T09:30:00.000+03:00`) &&
              now < Date.parse(`${businessDate}T10:00:00.000+03:00`),
          )
        : {
            state:
              now >= Date.parse(`${businessDate}T10:00:00.000+03:00`)
                ? ("skipped" as const)
                : now >= Date.parse(`${businessDate}T09:30:00.000+03:00`)
                  ? ("due" as const)
                  : ("not_due" as const),
          },
      report: report
        ? deliveryStatus(
            report,
            now,
            now >= Date.parse(`${businessDate}T10:01:00.000+03:00`),
          )
        : reportIssue?.businessDate === businessDate
          ? {
              state: "blocked" as const,
              reason: reportIssue.reason,
              reasons: reportIssue.reasons,
            }
          : {
              state:
                now >= Date.parse(`${businessDate}T10:01:00.000+03:00`)
                  ? ("due" as const)
                  : ("not_due" as const),
            },
    };
  }
  /** Older brief work is discovered locally and bounded in output; discovery never initiates backfill. */
  function briefBackfillStatus(today: string) {
    if (!options.brief || !briefLedger)
      return { dates: [], items: [], total: 0, truncated: false };
    const saved = new Map(
      briefLedger
        .listDailyBriefs(options.brief.activationDate, today)
        .map((row) => [row.businessDate, row]),
    );
    const items: {
      businessDate: string;
      state: string;
      briefId?: string;
      documentUrl?: string | null;
      deliveryId?: string | null;
    }[] = [];
    let total = 0;
    for (
      let day = Date.parse(`${options.brief.activationDate}T12:00:00Z`);
      day < Date.parse(`${today}T12:00:00Z`);
      day += 86400000
    ) {
      const date = new Date(day).toISOString().slice(0, 10);
      const row = saved.get(date);
      const weekday = new Date(day).getUTCDay();
      const delivery = row?.announcementDeliveryId
        ? reportLedger.getDelivery(row.announcementDeliveryId)
        : null;
      if (row?.publicationState === "published" && delivery?.state === "sent")
        continue;
      if (
        row &&
        options.brief.mode === "capture_only" &&
        row.generationState === "pending" &&
        row.publicationState === "pending"
      )
        continue;
      if (
        !row &&
        (weekday === 0 ||
          weekday === 6 ||
          options.calendar.publicHolidays.includes(date))
      )
        continue;
      total++;
      if (items.length < 31)
        items.push(
          row
            ? {
                businessDate: date,
                state:
                  row.publicationState === "pending"
                    ? row.generationState
                    : row.publicationState,
                briefId: row.id,
                documentUrl: row.documentUrl,
                deliveryId: row.announcementDeliveryId,
              }
            : { businessDate: date, state: "missing" },
        );
    }
    return {
      dates: items.map((item) => item.businessDate),
      items,
      total,
      truncated: total > items.length,
    };
  }
  /** Extend operator output with supplementary work; no model/Lark calls happen during inspection. */
  function getStatus(input: { now: number }) {
    const core = getCoreStatus(input);
    const job = core.businessDate
      ? briefLedger?.getDailyBrief(core.businessDate)
      : null;
    const announcement = job?.announcementDeliveryId
      ? reportLedger.getDelivery(job.announcementDeliveryId)
      : null;
    const brief = !options.brief
      ? { state: "disabled" as const }
      : !briefConfigurationValid
        ? {
            state: "blocked" as const,
            reason: "invalid_brief_configuration",
            mode: options.brief.mode,
          }
        : core.status !== "ok"
          ? {
              state: "blocked" as const,
              reason: core.reason,
              mode: options.brief.mode,
            }
          : core.businessDate < options.brief.activationDate
            ? {
                state: "skipped" as const,
                reason: "before_activation",
                mode: options.brief.mode,
              }
            : core.report.state === "skipped" && "reason" in core.report
              ? {
                  state: "skipped" as const,
                  reason: core.report.reason,
                  mode: options.brief.mode,
                }
              : job
                ? {
                    state:
                      briefIssue?.businessDate === core.businessDate
                        ? ("blocked" as const)
                        : job.publicationState === "published"
                          ? ("published" as const)
                          : job.publicationState === "review_required" ||
                              job.generationState === "review_required"
                            ? ("review_required" as const)
                            : ("input_frozen" as const),
                    mode: options.brief.mode,
                    briefId: job.id,
                    ...(briefIssue?.businessDate === core.businessDate
                      ? {
                          reason: briefIssue.reason,
                          reasons: briefIssue.reasons,
                        }
                      : {}),
                    entryCount: job.entries.length,
                    generationState: job.generationState,
                    generationAttemptCount: job.generationAttemptCount,
                    generationNextAttemptMs: job.generationNextAttemptMs,
                    generationClaimExpiresMs: job.generationClaimExpiresMs,
                    generationLastError: job.generationLastError,
                    publicationState: job.publicationState,
                    publicationClaimExpiresMs: job.publicationClaimExpiresMs,
                    publicationLastError: job.publicationLastError,
                    documentUrl: job.documentUrl,
                    announcement: announcement
                      ? deliveryStatus(announcement, input.now, true)
                      : null,
                  }
                : briefIssue?.businessDate === core.businessDate
                  ? {
                      state: "blocked" as const,
                      reason: briefIssue.reason,
                      reasons: briefIssue.reasons,
                      mode: options.brief.mode,
                    }
                  : {
                      state:
                        input.now >=
                        Date.parse(`${core.businessDate}T10:15:00+03:00`)
                          ? ("due" as const)
                          : ("not_due" as const),
                      mode: options.brief.mode,
                    };
    return {
      ...core,
      brief,
      ...(options.brief &&
      briefConfigurationValid &&
      core.businessDate &&
      (core.status === "ok" || core.status === "paused")
        ? { briefBackfill: briefBackfillStatus(core.businessDate) }
        : {}),
    };
  }
  /** Execute one check; external calls run outside SQLite transactions. */
  async function executeDueWork(input: { now: number }) {
    let status = getStatus(input);
    if (status.status !== "ok") return status;
    if (options.readOnly)
      return {
        ...status,
        status: "blocked" as const,
        reason: "inspection_only",
      };
    // Each check may attempt eligible saved work once; S4 owns persisted backoff and claims.
    if (
      ["due", "pending", "retryable", "uncertain", "sending"].includes(
        status.reminder.state,
      ) &&
      input.now >= Date.parse(`${status.businessDate}T09:30:00.000+03:00`) &&
      input.now < Date.parse(`${status.businessDate}T10:00:00.000+03:00`)
    ) {
      const prepared = reminderLedger.prepareReminder({
        businessDate: status.businessDate,
        text: options.reminderText,
        policyVersion: `${options.policy.policyVersion}/${options.calendar.version}`,
      });
      if (prepared.status === "frozen")
        await reminderLedger.deliverDelivery({
          deliveryId: prepared.delivery.id,
          now: input.now,
        });
    }
    // Credential/network work may cross 10:01; evaluate report eligibility using the current clock.
    const reportNow = Math.max(input.now, (options.clock ?? Date.now)());
    status = getStatus({ now: reportNow });
    if (status.status !== "ok") return status;
    if (
      (status.report.state === "due" || status.report.state === "blocked") &&
      reportNow >= Date.parse(`${status.businessDate}T10:01:00.000+03:00`)
    ) {
      const scan = await reader.readSubmissionHistory({
        businessDate: status.businessDate,
        sourceChatId: options.sourceChatId,
        replyPolicy: "exclude",
      });
      if (scan.status !== "complete") {
        reportIssue = {
          businessDate: status.businessDate,
          reason: scan.reason,
          reasons: [scan.reason],
        };
      } else {
        const prepared = reportLedger.prepareDailyReport({
          businessDate: status.businessDate,
          scan,
          policy: {
            ...options.policy,
            appId: options.appId,
            sourceChatId: options.sourceChatId,
            timeZone: "Africa/Nairobi",
            publicHolidays: options.calendar.publicHolidays,
            policyVersion: `${options.policy.policyVersion}/${options.calendar.version}`,
          },
        });
        if (prepared.status === "frozen") {
          reportIssue = null;
          // Freeze useful observed evidence, but do not auto-send yesterday's report after midnight.
          const deliveryNow = Math.max(
            input.now,
            (options.clock ?? Date.now)(),
          );
          const latest = getStatus({ now: deliveryNow });
          if (
            latest.status !== "ok" ||
            latest.businessDate !== status.businessDate
          )
            return latest;
          await reportLedger.deliverDelivery({
            deliveryId: prepared.delivery.id,
            now: deliveryNow,
            deliveryDeadlineMs:
              Date.parse(`${status.businessDate}T00:00:00.000+03:00`) +
              86_400_000,
          });
        } else {
          reportIssue = {
            businessDate: status.businessDate,
            reason: prepared.reasons[0] ?? "preparation_blocked",
            reasons: prepared.reasons,
          };
        }
      }
    } else if (
      ["pending", "retryable", "uncertain", "sending"].includes(
        status.report.state,
      ) &&
      "deliveryId" in status.report
    ) {
      await reportLedger.deliverDelivery({
        deliveryId: status.report.deliveryId,
        now: reportNow,
        deliveryDeadlineMs:
          Date.parse(`${status.businessDate}T00:00:00.000+03:00`) + 86_400_000,
      });
    }
    const briefNow = Math.max(input.now, (options.clock ?? Date.now)());
    const latest = getStatus({ now: briefNow });
    if (
      briefLedger &&
      briefReader &&
      latest.status === "ok" &&
      ["due", "blocked"].includes(latest.brief.state) &&
      !briefLedger.getDailyBrief(latest.businessDate) &&
      briefNow >= Date.parse(`${latest.businessDate}T10:15:00+03:00`)
    ) {
      const scan = await briefReader.readBriefSubmissions({
        businessDate: latest.businessDate,
      });
      if (scan.status === "complete") {
        const prepared = briefLedger.prepareDailyBrief({
          businessDate: latest.businessDate,
          scan,
        });
        briefIssue =
          prepared.status === "blocked"
            ? {
                businessDate: latest.businessDate,
                reason: prepared.reasons[0] ?? "brief_preparation_blocked",
                reasons: prepared.reasons,
              }
            : null;
      } else {
        const reason = scan.reason ?? "brief_capture_incomplete";
        briefIssue = {
          businessDate: latest.businessDate,
          reason,
          reasons: [reason],
        };
      }
    }
    if (
      briefLedger &&
      options.brief?.mode === "publish" &&
      latest.status === "ok" &&
      latest.brief.state !== "skipped" &&
      briefNow >= Date.parse(`${latest.businessDate}T10:15:00+03:00`)
    ) {
      const job = briefLedger.getDailyBrief(latest.businessDate);
      const announcement = job?.announcementDeliveryId
        ? reportLedger.getDelivery(job.announcementDeliveryId)
        : null;
      if (
        job &&
        job.publicationState !== "review_required" &&
        job.generationState !== "review_required" &&
        announcement?.state !== "sent" &&
        options.brief.generator &&
        options.brief.template &&
        options.brief.instructions &&
        options.brief.docPublishing
      ) {
        let coordinator: ReturnType<typeof openBriefCoordinator> | null = null;
        try {
          coordinator = openBriefCoordinator({
            ...options,
            ...options.brief,
            policy: briefPolicy,
            generator: options.brief.generator,
            template: options.brief.template,
            instructions: options.brief.instructions,
            docPublishing: options.brief.docPublishing,
          });
          const result = await coordinator.completeDailyBrief({
            briefId: job.id,
            now: Math.max(input.now, (options.clock ?? Date.now)()),
            deadlineMs:
              Date.parse(`${latest.businessDate}T00:00:00+03:00`) + 86400000,
          });
          briefIssue =
            result.status === "blocked"
              ? {
                  businessDate: latest.businessDate,
                  reason: result.reason,
                  reasons: [result.reason],
                }
              : null;
        } catch {
          // Durable claims remain authoritative after an unknown failure; never log provider/source data.
          briefIssue = {
            businessDate: latest.businessDate,
            reason: "brief_execution_unavailable",
            reasons: ["brief_execution_unavailable"],
          };
        } finally {
          coordinator?.close();
        }
      }
    }
    return getStatus({
      now: Math.max(input.now, (options.clock ?? Date.now)()),
    });
  }
  let inFlight: ReturnType<typeof executeDueWork> | null = null;
  /** Coalesce overlapping ticks; retries belong to later checks, never a blocking sleep. */
  function runDueWork(input: { now: number }) {
    if (inFlight) return inFlight;
    inFlight = executeDueWork(input).finally(() => {
      inFlight = null;
    });
    return inFlight;
  }
  return {
    getStatus,
    runDueWork,
    close: () => {
      reminderLedger.close();
      reportLedger.close();
      briefLedger?.close();
    },
  };
}
