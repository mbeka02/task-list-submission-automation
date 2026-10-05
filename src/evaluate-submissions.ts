/**
 * One observed version of a Lark message, with raw content and sender metadata.
 * Send, update and observation times are epoch milliseconds.
 */
export interface SubmissionObservation {
  observationId: string;
  messageId: string;
  appId: string;
  sourceChatId: string;
  sender: {
    type: string;
    openId?: string;
    tenantKey?: string;
    displayName?: string;
    localizedNames?: Readonly<Record<string, string>>;
  };
  createdMs: number;
  updatedMs: number;
  messageType: string;
  /** Original Lark JSON body; classification produces separate normalized text. */
  content: string;
  deleted: boolean;
  observedAtMs?: number;
  sourceRoute?: string;
  rootMessageId?: string;
  provenance?: "original" | "forwarded" | "management_recap";
}

/**
 * Current message observations and rules for one YYYY-MM-DD Nairobi business date.
 * The caller supplies the holiday calendar and any verified name aliases.
 */
export interface SubmissionInput {
  businessDate: string;
  policy: {
    appId: string;
    sourceChatId: string;
    timeZone: "Africa/Nairobi";
    publicHolidays: readonly string[];
    preferredLocale?: string;
    replyPolicy?: "include" | "exclude";
    verifiedAliases?: readonly {
      appId: string;
      tenantKey: string;
      openId: string;
      displayName: string;
    }[];
  };
  messages: readonly SubmissionObservation[];
}

/** One distinct submitter, with a display name and the message supporting selection. */
export interface SubmissionEntry {
  senderIdentity: { appId: string; tenantKey: string; openId: string };
  displayName: string;
  evidence: { observationId: string; messageId: string };
}

/** Classification of one input observation, including its exclusion or review reason. */
export interface SubmissionDecision {
  observationId: string;
  messageId: string;
  /** Classification text, or null when decoding was skipped or failed. */
  normalizedText: string | null;
  outcome: "eligible" | "excluded" | "review";
  reason:
    | "unapproved_source"
    | "not_working_day"
    | "invalid_timestamp"
    | "outside_business_date"
    | "after_cutoff"
    | "deleted"
    | "non_human_sender"
    | "not_original_submission"
    | "unsupported_message_type"
    | "malformed_content"
    | "thread_reply_excluded"
    | "thread_policy_unconfirmed"
    | "unresolved_identity"
    | "unresolved_name"
    | "task_list"
    | "incomplete_task_list"
    | "ambiguous_task_heading"
    | "not_task_list"
    | "duplicate_sender";
}

/**
 * Selected submitters and decisions for every input observation.
 * `ready` means classification is resolved; the ledger checks retrieval completeness.
 */
export interface SubmissionEvaluation {
  status: "ready" | "needs_review" | "not_working_day";
  entries: SubmissionEntry[];
  decisions: SubmissionDecision[];
}

/**
 * Prefer the localized platform name, then the general name, then a verified alias.
 * An empty or missing result requires name review for a qualifying task list.
 */
function resolveName(
  message: SubmissionObservation,
  policy: SubmissionInput["policy"],
) {
  const localized = policy.preferredLocale
    ? message.sender.localizedNames?.[policy.preferredLocale]?.trim()
    : undefined;
  return (
    localized ||
    message.sender.displayName?.trim() ||
    policy.verifiedAliases
      ?.find(
        (alias) =>
          alias.appId === message.appId &&
          alias.tenantKey === message.sender.tenantKey &&
          alias.openId === message.sender.openId,
      )
      ?.displayName.trim()
  );
}

/**
 * Extract text from Lark text/post JSON, preserving title and row line breaks.
 * Return null when content or its selected translation cannot be decoded safely.
 */
function plainText(
  content: string,
  type: string,
  locale?: string,
): string | null {
  try {
    let value: unknown = JSON.parse(content);
    if (typeof value !== "object" || value === null) return null;
    if (type === "text")
      return "text" in value && typeof value.text === "string"
        ? value.text
        : null;
    // Without a preferred locale, only a single translation is unambiguous.
    if (!("content" in value)) {
      const localized = Object.entries(value);
      value = locale
        ? localized.find(([key]) => key === locale)?.[1]
        : localized.length === 1
          ? localized[0]?.[1]
          : null;
      if (typeof value !== "object" || value === null) return null;
    }
    if (
      !("title" in value) ||
      typeof value.title !== "string" ||
      !("content" in value) ||
      !Array.isArray(value.content)
    )
      return null;
    const lines = [value.title];
    for (const row of value.content) {
      if (!Array.isArray(row)) return null;
      let line = "";
      const nodes: readonly unknown[] = row;
      for (const node of nodes) {
        if (typeof node !== "object" || node === null || !("tag" in node))
          return null;
        if (node.tag === "img") continue;
        if (node.tag === "at") {
          if (!("user_name" in node) || typeof node.user_name !== "string")
            return null;
          line += node.user_name;
          continue;
        }
        if (
          (node.tag !== "text" && node.tag !== "a") ||
          !("text" in node) ||
          typeof node.text !== "string"
        )
          return null;
        line += node.text;
      }
      lines.push(line);
    }
    return lines.join("\n");
  } catch {
    return null;
  }
}

/**
 * Classify current observations and select the earliest eligible post per sender.
 * Expect one current observation per source message; inputs are not mutated.
 * @throws When businessDate is not a real YYYY-MM-DD date.
 */
export function evaluateSubmissions(
  input: SubmissionInput,
): SubmissionEvaluation {
  return evaluateCurrentObservations(input, "names");
}

/** Internal S7 classification with the brief window; identity/format rules match S1. */
export function evaluateBriefObservations(
  input: SubmissionInput,
): SubmissionEvaluation {
  return evaluateCurrentObservations(input, "brief");
}

/** Apply the same validity and deduplication rules within either fixed output window. */
function evaluateCurrentObservations(
  input: SubmissionInput,
  purpose: "names" | "brief",
): SubmissionEvaluation {
  const date = new Date(`${input.businessDate}T12:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(input.businessDate) ||
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== input.businessDate
  )
    throw new Error("Invalid business date; expected a real YYYY-MM-DD date");
  const weekday = date.getUTCDay();
  const nonWorking =
    weekday === 0 ||
    weekday === 6 ||
    input.policy.publicHolidays.includes(input.businessDate);
  // This seam's approved zone is Nairobi (UTC+03:00, without daylight saving).
  const start = Date.parse(`${input.businessDate}T00:00:00.000+03:00`);
  // Windows affect eligibility only; brief timeliness is labelled separately at S7.
  const boundary = purpose === "names" ? "10:01" : "10:15";
  const cutoff = Date.parse(`${input.businessDate}T${boundary}:00.000+03:00`);
  // Keep a decision for every input, including exclusions and review issues.
  const decisions = input.messages.map<SubmissionDecision>((message) => {
    if (
      message.appId !== input.policy.appId ||
      message.sourceChatId !== input.policy.sourceChatId
    )
      return {
        observationId: message.observationId,
        messageId: message.messageId,
        normalizedText: null,
        outcome: "review",
        reason: "unapproved_source",
      };
    if (nonWorking)
      return {
        observationId: message.observationId,
        messageId: message.messageId,
        normalizedText: null,
        outcome: "excluded",
        reason: "not_working_day",
      };
    if (
      !Number.isSafeInteger(message.createdMs) ||
      message.createdMs < 0 ||
      !Number.isSafeInteger(message.updatedMs) ||
      message.updatedMs < message.createdMs
    )
      return {
        observationId: message.observationId,
        messageId: message.messageId,
        normalizedText: null,
        outcome: "review",
        reason: "invalid_timestamp",
      };
    // Eligibility follows original send time, even if the content was edited later.
    const exclusion =
      message.createdMs < start || message.createdMs >= start + 86_400_000
        ? "outside_business_date"
        : message.createdMs >= cutoff
          ? "after_cutoff"
          : null;
    if (exclusion)
      return {
        observationId: message.observationId,
        messageId: message.messageId,
        normalizedText: null,
        outcome: "excluded",
        reason: exclusion,
      };
    const sourceExclusion = message.deleted
      ? "deleted"
      : message.sender.type !== "user"
        ? "non_human_sender"
        : message.provenance && message.provenance !== "original"
          ? "not_original_submission"
          : !["text", "post"].includes(message.messageType)
            ? "unsupported_message_type"
            : null;
    if (sourceExclusion)
      return {
        observationId: message.observationId,
        messageId: message.messageId,
        normalizedText: null,
        outcome: "excluded",
        reason: sourceExclusion,
      };
    const text = plainText(
      message.content,
      message.messageType,
      input.policy.preferredLocale,
    );
    if (text === null)
      return {
        observationId: message.observationId,
        messageId: message.messageId,
        normalizedText: null,
        outcome: "review",
        reason: "malformed_content",
      };
    // Normalize classification text while preserving original content as evidence.
    const normalizedText = text
      .normalize("NFKC")
      .replace(/\r\n?/g, "\n")
      .replace(/[‘’`]/g, "'")
      .replace(/[‐‑‒–—]/g, "-")
      .trim();
    // Loose mentions need review; a task list requires a heading and a non-empty item.
    const candidate =
      /\b(?:to[ \t]*(?:-[ \t]*)?do(?:\s+list)?|task\s+list|do\s+list)\b/i.test(
        normalizedText,
      );
    // Only a heading-shaped opening qualifies; its optional date is display data.
    const heading = new RegExp(
      [
        String.raw`^(?:(?:my|our|today's|[\p{L}\p{N} ._-]+'s|[\p{L}\p{N}._-]+s)\s+)?`,
        String.raw`(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+)?`,
        String.raw`(?:to[ \t]*(?:-[ \t]*)?do(?:\s+list)?|task\s+list|do\s+list)\s*[.:]?`,
        String.raw`(?:[ \t]+\d{1,2}(?:st|nd|rd|th)?[ \t]+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)(?:[ \t]+\d{4})?)?`,
        String.raw`[ \t]*(?:\n|$)`,
      ].join(""),
      "iu",
    ).test(normalizedText);
    const item = /(?:^|\n)[ \t]*(?:\d+[.):]|\(\d+\)|[-*•])[ \t]*\S/.test(
      normalizedText,
    );
    if (
      candidate &&
      message.rootMessageId &&
      message.rootMessageId !== message.messageId &&
      input.policy.replyPolicy !== "include"
    )
      return {
        observationId: message.observationId,
        messageId: message.messageId,
        normalizedText,
        outcome: input.policy.replyPolicy === "exclude" ? "excluded" : "review",
        reason:
          input.policy.replyPolicy === "exclude"
            ? "thread_reply_excluded"
            : "thread_policy_unconfirmed",
      };
    if (
      heading &&
      item &&
      (!message.sender.openId?.trim() || !message.sender.tenantKey?.trim())
    )
      return {
        observationId: message.observationId,
        messageId: message.messageId,
        normalizedText,
        outcome: "review",
        reason: "unresolved_identity",
      };
    if (heading && item && !resolveName(message, input.policy))
      return {
        observationId: message.observationId,
        messageId: message.messageId,
        normalizedText,
        outcome: "review",
        reason: "unresolved_name",
      };
    return {
      observationId: message.observationId,
      messageId: message.messageId,
      normalizedText,
      outcome: heading
        ? item
          ? "eligible"
          : "review"
        : candidate
          ? "review"
          : "excluded",
      reason: heading
        ? item
          ? "task_list"
          : "incomplete_task_list"
        : candidate
          ? "ambiguous_task_heading"
          : "not_task_list",
    };
  });
  const seen = new Set<string>();
  const selected = input.messages
    // Preserve the link to the original decision after filtering and sorting.
    .map((message, index) => ({ message, index }))
    .filter(({ index }) => decisions[index]?.outcome === "eligible")
    // The earliest eligible post represents its sender; IDs break equal-time ties.
    .sort(
      (a, b) =>
        a.message.createdMs - b.message.createdMs ||
        a.message.messageId.localeCompare(b.message.messageId),
    )
    .filter(({ message, index }) => {
      // Serialize the scoped identity so equal names never merge different senders.
      const key = JSON.stringify([
        message.appId,
        message.sender.tenantKey,
        message.sender.openId,
      ]);
      if (seen.has(key)) {
        const decision = decisions[index];
        if (decision) {
          decision.outcome = "excluded";
          decision.reason = "duplicate_sender";
        }
        return false;
      }
      seen.add(key);
      return true;
    });
  // Review issues block readiness even when other messages produced valid entries.
  return {
    status: nonWorking
      ? "not_working_day"
      : decisions.some((decision) => decision.outcome === "review")
        ? "needs_review"
        : "ready",
    decisions,
    entries: selected.flatMap<SubmissionEntry>(({ message }) => {
      const { tenantKey, openId } = message.sender;
      const displayName = resolveName(message, input.policy);
      // Classification already requires these values; narrow the public output
      // so later report code cannot mistake an optional name/identity for ready.
      if (!tenantKey || !openId || !displayName) return [];
      return [
        {
          senderIdentity: {
            appId: message.appId,
            tenantKey,
            openId,
          },
          displayName,
          evidence: {
            observationId: message.observationId,
            messageId: message.messageId,
          },
        },
      ];
    }),
  };
}
