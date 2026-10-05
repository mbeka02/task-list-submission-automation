import {
  evaluateBriefObservations,
  type SubmissionDecision,
  type SubmissionEntry,
  type SubmissionInput,
} from "./evaluate-submissions.js";
import {
  createHistoryReader,
  type HistoryReaderOptions,
  type HistoryScan,
} from "./submission-history.js";

/** Selected source content for the brief; original send time controls the late label. */
export interface BriefEntry extends SubmissionEntry {
  createdMs: number;
  timeliness: "on_time" | "late";
  normalizedText: string;
}

/** Coverage, observed evidence and decisions; only complete results are ready to freeze. */
export type BriefScan = Omit<HistoryScan, "status"> & {
  status:
    | "complete"
    | "review_required"
    | "incomplete"
    | "unavailable"
    | "not_working_day";
  reason?: string;
  providerCode?: number;
  entries: BriefEntry[];
  decisions: SubmissionDecision[];
};

/** Existing approved reader credentials plus the configured calendar/name policy. */
export type BriefReaderOptions = HistoryReaderOptions & {
  policy: SubmissionInput["policy"];
};

/** One YYYY-MM-DD Nairobi date; app/source and root-only coverage come from configuration. */
export interface BriefReadInput {
  businessDate: string;
}

/**
 * Read/classify one 10:15 Nairobi snapshot without models, storage or outbound sends.
 * Complete pagination is required before selecting distinct qualifying source lists.
 */
export function createBriefSubmissionReader(options: BriefReaderOptions) {
  const { readHistory } = createHistoryReader(options, "brief");

  /** Skip excluded dates, then classify only after all accessible history pages succeed. */
  async function readBriefSubmissions(
    input: BriefReadInput,
  ): Promise<BriefScan> {
    /** Return local validation/calendar outcomes without obtaining credentials or history. */
    function withoutRead(
      status: "unavailable" | "not_working_day",
      reason: string,
    ): BriefScan {
      return {
        ...input,
        appId: options.appId,
        sourceChatId: options.sourceChatId,
        replyPolicy: "exclude",
        fromMs: Date.parse(`${input.businessDate}T00:00:00.000+03:00`),
        throughMs: Date.parse(`${input.businessDate}T10:15:00.000+03:00`),
        observedAtMs: (options.clock ?? Date.now)(),
        status,
        reason,
        messages: [],
        entries: [],
        decisions: [],
      };
    }
    if (
      options.policy.appId !== options.appId ||
      options.policy.sourceChatId !== options.sourceChatId
    )
      return withoutRead("unavailable", "policy_scope_mismatch");
    if (options.policy.replyPolicy === "include")
      return withoutRead("unavailable", "unsupported_reply_policy");
    if (
      options.policy.timeZone !== "Africa/Nairobi" ||
      !Array.isArray(options.policy.publicHolidays) ||
      options.policy.publicHolidays.some((day) => {
        if (typeof day !== "string") return true;
        const epoch = Date.parse(`${day}T12:00:00.000Z`);
        return (
          !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
          !Number.isFinite(epoch) ||
          new Date(epoch).toISOString().slice(0, 10) !== day
        );
      })
    )
      return withoutRead("unavailable", "invalid_policy");
    // An empty evaluation reuses S1's date/calendar rules without classifying a partial scan.
    try {
      const calendar = evaluateBriefObservations({
        businessDate: input.businessDate,
        policy: options.policy,
        messages: [],
      });
      if (calendar.status === "not_working_day")
        return withoutRead("not_working_day", "not_working_day");
    } catch {
      return withoutRead("unavailable", "invalid_business_date");
    }
    const scan = await readHistory({
      ...input,
      sourceChatId: options.sourceChatId,
      replyPolicy: "exclude",
    });
    if (scan.status !== "complete")
      return { ...scan, entries: [], decisions: [] };

    const evaluation = evaluateBriefObservations({
      businessDate: input.businessDate,
      policy: { ...options.policy, replyPolicy: "exclude" },
      messages: scan.messages,
    });
    const cutoff = Date.parse(`${input.businessDate}T10:01:00.000+03:00`);
    const entries = evaluation.entries.flatMap<BriefEntry>((entry) => {
      const message = scan.messages.find(
        (observation) =>
          observation.observationId === entry.evidence.observationId,
      );
      const decision = evaluation.decisions.find(
        (observed) => observed.observationId === entry.evidence.observationId,
      );
      if (!message || decision?.normalizedText == null) return [];
      return [
        {
          ...entry,
          createdMs: message.createdMs,
          timeliness: message.createdMs < cutoff ? "on_time" : "late",
          normalizedText: decision.normalizedText,
        },
      ];
    });
    return {
      ...scan,
      status:
        evaluation.status === "ready"
          ? "complete"
          : evaluation.status === "not_working_day"
            ? "not_working_day"
            : "review_required",
      entries,
      decisions: evaluation.decisions,
    };
  }

  return { readBriefSubmissions };
}
