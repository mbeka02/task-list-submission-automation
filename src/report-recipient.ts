/** A report targets either an approved group or one app-scoped Lark user. */
export type ReportRecipient = { type: "chat_id" | "open_id"; id: string };
const userPrefix = "recipient:open_id:";

/** Persist type and ID together in the existing destination column; old group rows retain their scope. */
export function recipientKey(recipient: ReportRecipient): string {
  if (!recipient.id.trim() || recipient.id !== recipient.id.trim())
    throw new Error("invalid_report_recipient");
  if (recipient.type === "open_id" && /^ou_[A-Za-z0-9_]+$/.test(recipient.id))
    return `${userPrefix}${recipient.id}`;
  if (recipient.type === "chat_id" && !recipient.id.startsWith("recipient:"))
    return recipient.id;
  throw new Error("invalid_report_recipient");
}

/** Decode the durable scope before message addressing or Doc permission changes. */
export function recipientFromKey(key: string): ReportRecipient {
  if (key.startsWith(userPrefix)) {
    const recipient: ReportRecipient = {
      type: "open_id",
      id: key.slice(userPrefix.length),
    };
    recipientKey(recipient);
    return recipient;
  }
  if (key.startsWith("recipient:")) throw new Error("invalid_report_recipient");
  return { type: "chat_id", id: key };
}

/** Accept legacy group options, but refuse conflicting new and old destination configuration. */
export function scopedRecipientOptions<
  T extends { destinationChatId?: string; recipient?: ReportRecipient },
>(input: T) {
  if (input.recipient && input.destinationChatId !== undefined)
    throw new Error("ambiguous_report_recipient");
  const { recipient, destinationChatId, ...rest } = input;
  return {
    ...rest,
    destinationChatId: recipient
      ? recipientKey(recipient)
      : (destinationChatId ?? ""),
  };
}

/** Explicit recipient configuration takes precedence only when complete; old group-only releases stay readable. */
export function configuredReportRecipient(
  environment: NodeJS.ProcessEnv,
): ReportRecipient {
  const type = environment.REPORT_RECIPIENT_TYPE;
  const id = environment.REPORT_RECIPIENT_ID;
  if (type !== undefined || id !== undefined) {
    if ((type !== "chat_id" && type !== "open_id") || !id)
      throw new Error("invalid_report_recipient");
    const recipient: ReportRecipient = { type, id };
    recipientKey(recipient);
    if (environment.MANAGEMENT_CHAT_ID?.trim())
      throw new Error("ambiguous_report_recipient");
    return recipient;
  }
  const legacy = environment.MANAGEMENT_CHAT_ID?.trim();
  if (!legacy) throw new Error("missing_worker_configuration");
  return { type: "chat_id", id: legacy };
}
