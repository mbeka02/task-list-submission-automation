import { expect, test } from "vitest";
import {
  evaluateSubmissions,
  type SubmissionInput,
  type SubmissionObservation,
} from "../../src/evaluate-submissions.js";

const message: SubmissionObservation = {
  observationId: "obs_1",
  messageId: "om_1",
  appId: "cli_test",
  sourceChatId: "oc_source",
  sender: {
    type: "user",
    openId: "ou_anthony",
    tenantKey: "tenant_external",
    displayName: "Anthony Mbeka",
  },
  createdMs: Date.parse("2026-10-01T06:55:00.000Z"),
  updatedMs: Date.parse("2026-10-01T06:55:00.000Z"),
  messageType: "text",
  content: JSON.stringify({ text: "My task list:\n1. Review infrastructure." }),
  deleted: false,
};
const policy: SubmissionInput["policy"] = {
  appId: "cli_test",
  sourceChatId: "oc_source",
  timeZone: "Africa/Nairobi",
  publicHolidays: [],
};
function evaluate(
  messages: readonly SubmissionObservation[],
  businessDate = "2026-10-01",
  overrides: Partial<SubmissionInput["policy"]> = {},
) {
  return evaluateSubmissions({
    businessDate,
    policy: { ...policy, ...overrides },
    messages,
  });
}

test("a task-list heading cannot replace the platform sender identity", () => {
  const result = evaluateSubmissions({
    businessDate: "2026-10-01",
    policy: {
      appId: "cli_test",
      sourceChatId: "oc_source",
      timeZone: "Africa/Nairobi",
      publicHolidays: [],
    },
    messages: [
      {
        observationId: "obs_anthony_1",
        messageId: "om_anthony_1",
        appId: "cli_test",
        sourceChatId: "oc_source",
        sender: {
          type: "user",
          openId: "ou_anthony",
          tenantKey: "tenant_external",
          displayName: "Anthony Mbeka",
        },
        createdMs: Date.parse("2026-10-01T06:55:00.000Z"),
        updatedMs: Date.parse("2026-10-01T06:55:00.000Z"),
        messageType: "text",
        content: JSON.stringify({
          text: "Molly's to-do list:\n\n1. Review infrastructure.",
        }),
        deleted: false,
      },
    ],
  });

  expect(result.entries).toEqual([
    {
      senderIdentity: {
        appId: "cli_test",
        tenantKey: "tenant_external",
        openId: "ou_anthony",
      },
      displayName: "Anthony Mbeka",
      evidence: { observationId: "obs_anthony_1", messageId: "om_anthony_1" },
    },
  ]);
});

test("rich-text mentions and images do not discard an otherwise readable task list", () => {
  const result = evaluate([
    {
      ...message,
      messageType: "post",
      content: JSON.stringify({
        title: "Task list",
        content: [
          [
            { tag: "text", text: "1. Coordinate with " },
            { tag: "at", user_id: "ou_colleague", user_name: "Colleague" },
          ],
          [{ tag: "img", image_key: "img_reference" }],
        ],
      }),
    },
  ]);
  expect(result.entries).toHaveLength(1);
  expect(result.decisions[0]?.normalizedText).toBe(
    "Task list\n1. Coordinate with Colleague",
  );
});

test("known forwarded task lists and management recaps are not original submissions", () => {
  const result = evaluate([
    { ...message, provenance: "forwarded" },
    { ...message, provenance: "management_recap" },
  ]);
  expect(result.entries).toEqual([]);
  expect(result.decisions.map((decision) => decision.reason)).toEqual([
    "not_original_submission",
    "not_original_submission",
  ]);
});

test.each(["2026-02-30", "2026-13-01", "not-a-date"])(
  "invalid business dates cannot produce ready results: %s",
  (date) => {
    expect(() => evaluate([], date)).toThrow("Invalid business date");
  },
);

test.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
  "invalid source timestamps require review: %s",
  (createdMs) => {
    const result = evaluate([{ ...message, createdMs }]);
    expect(result.entries).toEqual([]);
    expect(result.status).toBe("needs_review");
    expect(result.decisions[0]?.reason).toBe("invalid_timestamp");
  },
);

test("empty numbered rows cannot use the next list marker as their task content", () => {
  const result = evaluate([
    {
      ...message,
      content: JSON.stringify({ text: "Task list:\n1.\n2.\n-\n•" }),
    },
  ]);
  expect(result.entries).toEqual([]);
  expect(result.decisions[0]?.reason).toBe("incomplete_task_list");
});

test("a qualifying thread reply needs an explicit inclusion policy", () => {
  const reply = { ...message, rootMessageId: "om_root" };
  const unresolved = evaluate([reply]);
  expect(unresolved.entries).toEqual([]);
  expect(unresolved.status).toBe("needs_review");
  expect(unresolved.decisions[0]?.reason).toBe("thread_policy_unconfirmed");
  expect(
    evaluate([reply], "2026-10-01", { replyPolicy: "include" }).entries,
  ).toHaveLength(1);
  expect(
    evaluate([reply], "2026-10-01", { replyPolicy: "exclude" }).decisions[0]
      ?.reason,
  ).toBe("thread_reply_excluded");
});

test("messages from another app or chat cannot silently enter this report", () => {
  const result = evaluate([
    { ...message, appId: "cli_other" },
    { ...message, sourceChatId: "oc_other" },
  ]);
  expect(result.entries).toEqual([]);
  expect(result.status).toBe("needs_review");
  expect(result.decisions.map((decision) => decision.reason)).toEqual([
    "unapproved_source",
    "unapproved_source",
  ]);
});

test("server localized names take priority and aliases are verified against the full identity tuple", () => {
  const result = evaluate(
    [
      {
        ...message,
        sender: {
          ...message.sender,
          localizedNames: { en_us: "Anthony Localized" },
        },
      },
      {
        ...message,
        observationId: "obs_foreign",
        messageId: "om_foreign",
        sender: {
          type: "user",
          tenantKey: "tenant_second",
          openId: "ou_anthony",
        },
      },
      {
        ...message,
        observationId: "obs_same_name",
        messageId: "om_same_name",
        sender: {
          ...message.sender,
          openId: "ou_other",
          displayName: "Anthony Localized",
        },
      },
    ],
    "2026-10-01",
    {
      preferredLocale: "en_us",
      verifiedAliases: [
        {
          appId: "cli_test",
          tenantKey: "tenant_second",
          openId: "ou_anthony",
          displayName: "Verified Colleague",
        },
      ],
    },
  );
  expect(result.entries.map((entry) => entry.displayName)).toEqual([
    "Anthony Localized",
    "Verified Colleague",
    "Anthony Localized",
  ]);
  expect(result.entries.map((entry) => entry.senderIdentity.tenantKey)).toEqual(
    ["tenant_external", "tenant_second", "tenant_external"],
  );
});

test("missing platform identity or name is a visible review issue", () => {
  const result = evaluate([
    {
      ...message,
      sender: {
        type: "user",
        openId: "ou_anthony",
        tenantKey: "tenant_external",
      },
    },
    {
      ...message,
      sender: {
        type: "user",
        displayName: "Anthony Mbeka",
        openId: "ou_anthony",
      },
    },
    {
      ...message,
      sender: {
        type: "user",
        displayName: "Anthony Mbeka",
        tenantKey: "tenant_external",
      },
    },
  ]);
  expect(result.entries).toEqual([]);
  expect(result.status).toBe("needs_review");
  expect(result.decisions.map((decision) => decision.reason)).toEqual([
    "unresolved_name",
    "unresolved_identity",
    "unresolved_identity",
  ]);
});

test("one scoped sender uses the earliest surviving valid submission, regardless of input order", () => {
  const result = evaluate([
    { ...message, observationId: "obs_later", messageId: "om_later" },
    {
      ...message,
      observationId: "obs_deleted",
      messageId: "om_deleted",
      createdMs: Date.parse("2026-10-01T05:00:00.000Z"),
      deleted: true,
    },
    {
      ...message,
      observationId: "obs_earliest",
      messageId: "om_earliest",
      createdMs: Date.parse("2026-10-01T06:00:00.000Z"),
    },
  ]);
  expect(result.entries.map((entry) => entry.evidence.messageId)).toEqual([
    "om_earliest",
  ]);
  expect(
    result.decisions.find((decision) => decision.messageId === "om_later")
      ?.reason,
  ).toBe("duplicate_sender");
});

test("localized rich-text posts use the approved locale instead of concatenating translations", () => {
  const result = evaluate(
    [
      {
        ...message,
        messageType: "post",
        content: JSON.stringify({
          en_us: {
            title: "Task list",
            content: [[{ tag: "text", text: "1. Review infrastructure" }]],
          },
          zh_cn: {
            title: "Other translated content",
            content: [[{ tag: "text", text: "Discussion" }]],
          },
        }),
      },
    ],
    "2026-10-01",
    { preferredLocale: "en_us" },
  );
  expect(result.entries).toHaveLength(1);
  expect(result.decisions[0]?.normalizedText).toBe(
    "Task list\n1. Review infrastructure",
  );
});

test("rich-text rows keep line boundaries and use visible link labels", () => {
  const content = JSON.stringify({
    title: "My To-Do List",
    content: [
      [
        { tag: "text", text: "1." },
        {
          tag: "a",
          text: "Review infrastructure",
          href: "https://example.test/task",
        },
      ],
      [{ tag: "text", text: "2: Check backups", style: ["bold"] }],
    ],
  });
  const result = evaluate([{ ...message, messageType: "post", content }]);
  expect(result.entries).toHaveLength(1);
  expect(result.decisions[0]?.normalizedText).toBe(
    "My To-Do List\n1.Review infrastructure\n2: Check backups",
  );
});

test.each(["not json", "null", '{"text":42}', "{}"])(
  "malformed supported content is visible for review: %s",
  (content) => {
    const result = evaluate([{ ...message, content }]);
    expect(result.entries).toEqual([]);
    expect(result.status).toBe("needs_review");
    expect(result.decisions[0]?.reason).toBe("malformed_content");
  },
);

test("recalled, non-human and unsupported messages never count", () => {
  const result = evaluate([
    { ...message, deleted: true, content: "" },
    { ...message, sender: { ...message.sender, type: "app" } },
    {
      ...message,
      messageType: "image",
      content: JSON.stringify({ image_key: "img_test" }),
    },
  ]);
  expect(result.entries).toEqual([]);
  expect(result.decisions.map((decision) => decision.reason)).toEqual([
    "deleted",
    "non_human_sender",
    "unsupported_message_type",
  ]);
});

test("weekends and explicitly supplied Kenyan holidays are non-working days", () => {
  for (const [date, holidays] of [
    ["2026-10-03", []],
    ["2026-10-04", []],
    ["2026-10-01", ["2026-10-01"]],
  ] as const) {
    const result = evaluate(
      [{ ...message, createdMs: Date.parse(`${date}T06:55:00.000Z`) }],
      date,
      { publicHolidays: holidays },
    );
    expect(result.status).toBe("not_working_day");
    expect(result.entries).toEqual([]);
    expect(result.decisions[0]?.reason).toBe("not_working_day");
  }
});

test("only original sends on the business date up to exactly 10:00 Nairobi count", () => {
  const result = evaluate([
    {
      ...message,
      observationId: "obs_boundary",
      messageId: "om_boundary",
      createdMs: Date.parse("2026-10-01T07:00:00.000Z"),
      updatedMs: Date.parse("2026-10-01T07:01:00.000Z"),
    },
    {
      ...message,
      observationId: "obs_late",
      messageId: "om_late",
      createdMs: Date.parse("2026-10-01T07:00:00.001Z"),
      updatedMs: Date.parse("2026-10-01T07:00:00.001Z"),
    },
    {
      ...message,
      observationId: "obs_yesterday",
      messageId: "om_yesterday",
      createdMs: Date.parse("2026-09-30T20:59:59.999Z"),
    },
  ]);
  expect(result.entries.map((entry) => entry.evidence.messageId)).toEqual([
    "om_boundary",
  ]);
  expect(result.decisions.map((decision) => decision.reason)).toEqual([
    "task_list",
    "after_cutoff",
    "outside_business_date",
  ]);
});

test("a quoted task list in conversation needs review rather than counting the speaker", () => {
  const result = evaluate([
    {
      ...message,
      content: JSON.stringify({
        text: "Can you check Molly's task list below?\n1. Review infrastructure",
      }),
    },
  ]);
  expect(result.entries).toEqual([]);
  expect(result.status).toBe("needs_review");
  expect(result.decisions[0]?.reason).toBe("ambiguous_task_heading");
});

test.each([
  "Anthony’s To–Do:\r\n• Check backups",
  "ToDo List\n1.Check backups",
  "To do list:\n(1) Check backups",
  "Task list\n- Check backups",
])("supported heading and item formatting counts: %s", (text) => {
  expect(
    evaluate([{ ...message, content: JSON.stringify({ text }) }]).entries,
  ).toHaveLength(1);
});

test("ordinary numbered conversation does not count as a task submission", () => {
  const result = evaluate([
    {
      ...message,
      content: JSON.stringify({
        text: "Meeting agenda:\n1. Discuss infrastructure.",
      }),
    },
  ]);
  expect(result.entries).toEqual([]);
});

test("an empty task heading needs review rather than counting a submission", () => {
  const result = evaluate([
    { ...message, content: JSON.stringify({ text: "My task list:\n1. " }) },
  ]);
  expect(result.entries).toEqual([]);
  expect(result.status).toBe("needs_review");
  expect(result.decisions).toEqual([
    {
      observationId: "obs_1",
      messageId: "om_1",
      outcome: "review",
      reason: "incomplete_task_list",
      normalizedText: "My task list:\n1.",
    },
  ]);
});
