import type { BriefScan } from "../../src/brief-submissions.js";
import {
  evaluateBriefObservations,
  type SubmissionObservation,
} from "../../src/evaluate-submissions.js";

/** Synthetic frozen brief data; no captured employee messages or live credentials. */
export const businessDate = "2026-10-01";
export const policy = {
  appId: "cli_test",
  sourceChatId: "oc_source",
  timeZone: "Africa/Nairobi" as const,
  publicHolidays: [],
  policyVersion: "policy-v1",
};
export const config = {
  appId: policy.appId,
  sourceChatId: policy.sourceChatId,
  destinationChatId: "oc_management",
  policy,
  templateVersion: "template-v1",
  promptVersion: "prompt-v1",
  schemaVersion: "schema-v1",
  provider: "gemini" as const,
  model: "gemini-3.5-flash-lite",
};
export function message(
  name: string,
  time: string,
  task: string,
): SubmissionObservation {
  const createdMs = Date.parse(`${businessDate}T${time}+03:00`);
  return {
    observationId: `obs_${name}`,
    messageId: `msg_${name}`,
    appId: policy.appId,
    sourceChatId: policy.sourceChatId,
    sender: {
      type: "user",
      openId: `ou_${name}`,
      tenantKey: "external_tenant",
      displayName: name,
    },
    createdMs,
    updatedMs: createdMs,
    messageType: "text",
    content: JSON.stringify({ text: `Task list\n1. ${task}` }),
    deleted: false,
  };
}
export function scan(
  messages = [
    message("Alice", "09:45:00", "Prepare drawings"),
    message("Bob", "10:07:00", "Review estimates"),
  ],
): BriefScan {
  const evaluated = evaluateBriefObservations({
    businessDate,
    policy: { ...policy, replyPolicy: "exclude" },
    messages,
  });
  return {
    status: evaluated.status === "ready" ? "complete" : "review_required",
    appId: policy.appId,
    sourceChatId: policy.sourceChatId,
    businessDate,
    fromMs: Date.parse(`${businessDate}T00:00:00+03:00`),
    throughMs: Date.parse(`${businessDate}T10:15:00+03:00`),
    observedAtMs: Date.parse(`${businessDate}T10:15:01+03:00`),
    replyPolicy: "exclude",
    messages,
    decisions: evaluated.decisions,
    entries: evaluated.entries.map((entry) => {
      const source = messages.find(
        (m) => m.observationId === entry.evidence.observationId,
      );
      const decision = evaluated.decisions.find(
        (d) => d.observationId === entry.evidence.observationId,
      );
      if (!source || !decision?.normalizedText)
        throw new Error("Invalid fixture");
      return {
        ...entry,
        createdMs: source.createdMs,
        normalizedText: decision.normalizedText,
        timeliness:
          source.createdMs < Date.parse(`${businessDate}T10:01:00+03:00`)
            ? "on_time"
            : "late",
      };
    }),
  };
}
