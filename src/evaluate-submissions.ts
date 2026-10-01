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
  content: string;
  deleted: boolean;
  rootMessageId?: string;
  provenance?: "original" | "forwarded" | "management_recap";
}

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

export interface SubmissionEntry {
  senderIdentity: { appId: string; tenantKey: string; openId: string };
  displayName: string;
  evidence: { observationId: string; messageId: string };
}

export interface SubmissionDecision {
  observationId: string;
  messageId: string;
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

export interface SubmissionEvaluation {
  status: "ready" | "needs_review" | "not_working_day";
  entries: SubmissionEntry[];
  decisions: SubmissionDecision[];
}

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

export function evaluateSubmissions(
  input: SubmissionInput,
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
  const cutoff = Date.parse(`${input.businessDate}T10:00:00.000+03:00`);
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
    const exclusion =
      message.createdMs < start || message.createdMs >= start + 86_400_000
        ? "outside_business_date"
        : message.createdMs > cutoff
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
    const normalizedText = text
      .normalize("NFKC")
      .replace(/\r\n?/g, "\n")
      .replace(/[‘’]/g, "'")
      .replace(/[‐‑‒–—]/g, "-")
      .trim();
    const candidate = /\b(?:to[- ]?do(?:\s+list)?|task\s+list)\b/i.test(
      normalizedText,
    );
    const heading =
      /^(?:(?:my|our|today's|[\p{L}\p{N} ._-]+'s)\s+)?(?:to[- ]?do(?:\s+list)?|task\s+list)\s*:?[ \t]*(?:\n|$)/iu.test(
        normalizedText,
      );
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
    .map((message, index) => ({ message, index }))
    .filter(({ index }) => decisions[index]?.outcome === "eligible")
    .sort(
      (a, b) =>
        a.message.createdMs - b.message.createdMs ||
        a.message.messageId.localeCompare(b.message.messageId),
    )
    .filter(({ message, index }) => {
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
