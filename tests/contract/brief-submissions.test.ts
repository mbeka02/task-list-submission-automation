import { expect, test } from "vitest";
import { createBriefSubmissionReader } from "../../src/brief-submissions.js";
import { evaluateSubmissions } from "../../src/evaluate-submissions.js";
import { larkHttpServer } from "../support/lark-http-server.js";

const businessDate = "2026-10-05";
const now = Date.parse("2026-10-05T07:15:00.000Z");
const policy = {
  appId: "cli_test",
  sourceChatId: "oc_source",
  timeZone: "Africa/Nairobi",
  publicHolidays: [],
  preferredLocale: "en_us",
  replyPolicy: "exclude",
} as const;
const config = {
  appId: policy.appId,
  sourceChatId: policy.sourceChatId,
  appSecret: "synthetic-app-secret",
  policy,
  clock: () => now,
  getUserAccessToken: async () => ({
    appId: policy.appId,
    accessToken: "synthetic-user-token",
    expiresAtMs: Date.parse("2026-10-05T08:00:00.000Z"),
  }),
};
const task = {
  message_id: "om_alice",
  chat_id: policy.sourceChatId,
  msg_type: "text",
  create_time: String(Date.parse("2026-10-05T07:07:00.000Z")),
  update_time: String(Date.parse("2026-10-05T07:07:00.000Z")),
  deleted: false,
  updated: false,
  sender: {
    id: "ou_alice",
    id_type: "open_id",
    sender_type: "user",
    tenant_key: "tenant_external",
    sender_name: "Alice",
  },
  body: {
    content: JSON.stringify({ text: "Task list\n1. Review the budget" }),
  },
};

test("English sender names do not require a single-language post to use an English envelope", async () => {
  const server = await larkHttpServer(() => ({
    body: {
      code: 0,
      data: {
        has_more: false,
        items: [
          {
            ...task,
            create_time: String(Date.parse("2026-10-05T06:45:00Z")),
            msg_type: "post",
            sender: {
              ...task.sender,
              sender_name: "user123456",
              sender_i18n_names: { en_us: "Alice" },
            },
            body: {
              content: JSON.stringify({
                zh_cn: {
                  title: "Task list",
                  content: [[{ tag: "text", text: "1. Review the budget" }]],
                },
              }),
            },
          },
        ],
      },
    },
  }));
  try {
    const scan = await createBriefSubmissionReader({
      ...config,
      httpInstance: server.httpInstance,
    }).readBriefSubmissions({ businessDate });
    expect(scan).toMatchObject({
      status: "complete",
      entries: [
        expect.objectContaining({
          displayName: "Alice",
          normalizedText: "Task list\n1. Review the budget",
          timeliness: "on_time",
        }),
      ],
    });
    expect(
      evaluateSubmissions({ businessDate, policy, messages: scan.messages }),
    ).toMatchObject({
      status: "ready",
      entries: [expect.objectContaining({ displayName: "Alice" })],
    });
  } finally {
    await server.close();
  }
});

test("a 10:07 task list is late in the brief and excluded from the names report", async () => {
  const server = await larkHttpServer(() => ({
    body: { code: 0, data: { has_more: false, items: [task] } },
  }));
  try {
    const result = await createBriefSubmissionReader({
      ...config,
      httpInstance: server.httpInstance,
    }).readBriefSubmissions({ businessDate });
    expect(result).toMatchObject({
      status: "complete",
      throughMs: Date.parse("2026-10-05T07:15:00.000Z"),
      entries: [
        {
          displayName: "Alice",
          senderIdentity: {
            appId: "cli_test",
            tenantKey: "tenant_external",
            openId: "ou_alice",
          },
          evidence: { messageId: "om_alice" },
          createdMs: Date.parse("2026-10-05T07:07:00.000Z"),
          timeliness: "late",
          normalizedText: "Task list\n1. Review the budget",
        },
      ],
    });
    expect(result.entries).toHaveLength(1);
    expect(
      evaluateSubmissions({ businessDate, policy, messages: result.messages }),
    ).toMatchObject({
      status: "ready",
      entries: [],
      decisions: [{ messageId: "om_alice", reason: "after_cutoff" }],
    });
  } finally {
    await server.close();
  }
});

test("non-working dates are skipped without fetching source history", async () => {
  const server = await larkHttpServer(() => ({
    body: { code: 0, data: { has_more: false, items: [] } },
  }));
  try {
    const reader = createBriefSubmissionReader({
      ...config,
      policy: { ...policy, publicHolidays: [businessDate] },
      httpInstance: server.httpInstance,
    });
    expect(await reader.readBriefSubmissions({ businessDate })).toMatchObject({
      status: "not_working_day",
      entries: [],
    });
    expect(server.requests).toEqual([]);
  } finally {
    await server.close();
  }
});

test("a policy for another app is rejected before reading source history", async () => {
  const server = await larkHttpServer(() => ({
    body: { code: 0, data: { has_more: false, items: [task] } },
  }));
  try {
    const result = await createBriefSubmissionReader({
      ...config,
      policy: { ...policy, appId: "cli_other" },
      httpInstance: server.httpInstance,
    }).readBriefSubmissions({ businessDate });
    expect(result).toMatchObject({
      status: "unavailable",
      reason: "policy_scope_mismatch",
      entries: [],
    });
    expect(server.requests).toEqual([]);
  } finally {
    await server.close();
  }
});

test("a reply-including policy cannot silently claim unsupported thread coverage", async () => {
  const server = await larkHttpServer(() => ({
    body: { code: 0, data: { has_more: false, items: [task] } },
  }));
  try {
    expect(
      await createBriefSubmissionReader({
        ...config,
        policy: { ...policy, replyPolicy: "include" },
        httpInstance: server.httpInstance,
      }).readBriefSubmissions({ businessDate }),
    ).toMatchObject({
      status: "unavailable",
      reason: "unsupported_reply_policy",
      entries: [],
    });
    expect(server.requests).toEqual([]);
  } finally {
    await server.close();
  }
});

test("a non-Nairobi policy is rejected before fetching history", async () => {
  const invalidPolicy = { ...policy };
  Reflect.set(invalidPolicy, "timeZone", "UTC");
  const server = await larkHttpServer(() => ({
    body: { code: 0, data: { has_more: false, items: [task] } },
  }));
  try {
    expect(
      await createBriefSubmissionReader({
        ...config,
        policy: invalidPolicy,
        httpInstance: server.httpInstance,
      }).readBriefSubmissions({ businessDate }),
    ).toMatchObject({ status: "unavailable", reason: "invalid_policy" });
    expect(server.requests).toEqual([]);
  } finally {
    await server.close();
  }
});

test("brief membership uses exact midnight, 10:01 and 10:15 millisecond boundaries", async () => {
  const items = [
    ["previous_day", "2026-10-04T20:59:59.999Z"],
    ["midnight", "2026-10-04T21:00:00.000Z"],
    ["whole_minute", "2026-10-05T07:00:59.999Z"],
    ["late_boundary", "2026-10-05T07:01:00.000Z"],
    ["last_included", "2026-10-05T07:14:59.999Z"],
    ["capture_boundary", "2026-10-05T07:15:00.000Z"],
  ].map(([id, time]) => ({
    ...task,
    message_id: `om_${id}`,
    create_time: String(Date.parse(time ?? "")),
    update_time: String(Date.parse(time ?? "")),
    sender: { ...task.sender, id: `ou_${id}`, sender_name: id },
  }));
  const server = await larkHttpServer(() => ({
    body: { code: 0, data: { has_more: false, items } },
  }));
  try {
    const result = await createBriefSubmissionReader({
      ...config,
      httpInstance: server.httpInstance,
    }).readBriefSubmissions({ businessDate });
    expect(result.status).toBe("complete");
    expect(
      result.entries.map((entry) => [entry.displayName, entry.timeliness]),
    ).toEqual([
      ["midnight", "on_time"],
      ["whole_minute", "on_time"],
      ["late_boundary", "late"],
      ["last_included", "late"],
    ]);
    expect(server.requests[0]?.query).toMatchObject({
      start_time: "1791147599",
      end_time: "1791184501",
      only_thread_root_messages: "true",
    });
  } finally {
    await server.close();
  }
});

test("all pages select current source evidence and one surviving list per sender", async () => {
  const earlier = {
    ...task,
    create_time: String(Date.parse("2026-10-05T06:55:00.000Z")),
    update_time: String(Date.parse("2026-10-05T06:55:00.000Z")),
  };
  const recalled = {
    ...earlier,
    message_id: "om_removed",
    sender: { ...task.sender, id: "ou_removed", sender_name: "Removed" },
  };
  const server = await larkHttpServer((request) => ({
    body: {
      code: 0,
      data: request.query.page_token
        ? {
            has_more: false,
            items: [
              {
                ...earlier,
                updated: true,
                update_time: String(Date.parse("2026-10-05T07:12:00.000Z")),
                body: {
                  content: JSON.stringify({ text: "TODO\n1. Updated task" }),
                },
              },
              {
                ...task,
                message_id: "om_alice_second",
                body: {
                  content: JSON.stringify({
                    text: "To-do list\n1. Extra task",
                  }),
                },
              },
              {
                ...task,
                message_id: "om_beth",
                msg_type: "post",
                sender: {
                  ...task.sender,
                  id: "ou_beth",
                  tenant_key: "another_sender_tenant",
                  sender_name: "Alice",
                  sender_i18n_names: { en_us: "Beth" },
                },
                body: {
                  content: JSON.stringify({
                    en_us: {
                      title: "Beth's To - Do List",
                      content: [
                        [{ tag: "text", text: "1. Call the supplier" }],
                      ],
                    },
                  }),
                },
              },
              { ...recalled, deleted: true },
            ],
          }
        : { has_more: true, page_token: "second", items: [earlier, recalled] },
    },
  }));
  try {
    const result = await createBriefSubmissionReader({
      ...config,
      httpInstance: server.httpInstance,
    }).readBriefSubmissions({ businessDate });
    expect(result.status).toBe("complete");
    expect(result.entries).toMatchObject([
      {
        displayName: "Alice",
        evidence: { messageId: "om_alice" },
        timeliness: "on_time",
        normalizedText: "TODO\n1. Updated task",
      },
      {
        displayName: "Beth",
        evidence: { messageId: "om_beth" },
        timeliness: "late",
        normalizedText: "Beth's To - Do List\n1. Call the supplier",
      },
    ]);
    expect(result.entries).toHaveLength(2);
    expect(result.decisions).toContainEqual(
      expect.objectContaining({ messageId: "om_removed", reason: "deleted" }),
    );
    expect(result.decisions).toContainEqual(
      expect.objectContaining({
        messageId: "om_alice_second",
        reason: "duplicate_sender",
      }),
    );
  } finally {
    await server.close();
  }
});

test("a malformed holiday calendar is rejected rather than treated as an ordinary working day", async () => {
  const server = await larkHttpServer(() => ({
    body: { code: 0, data: { has_more: false, items: [] } },
  }));
  try {
    expect(
      await createBriefSubmissionReader({
        ...config,
        policy: { ...policy, publicHolidays: ["2026-02-30"] },
        httpInstance: server.httpInstance,
      }).readBriefSubmissions({ businessDate }),
    ).toMatchObject({ status: "unavailable", reason: "invalid_policy" });
    expect(server.requests).toEqual([]);
  } finally {
    await server.close();
  }
});

test("capture waits for 10:15 and a later run keeps the scheduled boundary", async () => {
  let clock = Date.parse("2026-10-05T07:14:59.999Z");
  const server = await larkHttpServer(() => ({
    body: {
      code: 0,
      data: {
        has_more: false,
        items: [
          task,
          {
            ...task,
            message_id: "om_after_capture",
            create_time: String(Date.parse("2026-10-05T07:16:00.000Z")),
            update_time: String(Date.parse("2026-10-05T07:16:00.000Z")),
            sender: { ...task.sender, id: "ou_after", sender_name: "After" },
          },
        ],
      },
    },
  }));
  try {
    const reader = createBriefSubmissionReader({
      ...config,
      clock: () => clock,
      httpInstance: server.httpInstance,
    });
    expect(await reader.readBriefSubmissions({ businessDate })).toMatchObject({
      status: "unavailable",
      reason: "before_cutoff",
      entries: [],
    });
    expect(server.requests).toEqual([]);
    clock = Date.parse("2026-10-05T07:21:00.000Z");
    const result = await reader.readBriefSubmissions({ businessDate });
    expect(result).toMatchObject({
      status: "complete",
      throughMs: Date.parse("2026-10-05T07:15:00.000Z"),
      entries: [{ displayName: "Alice" }],
    });
    expect(result.entries).toHaveLength(1);
  } finally {
    await server.close();
  }
});

test("a failed later page cannot expose a ready prefix as the brief", async () => {
  const server = await larkHttpServer((request) => ({
    body: request.query.page_token
      ? { code: 999, msg: "Synthetic provider failure" }
      : {
          code: 0,
          data: { has_more: true, page_token: "second", items: [task] },
        },
  }));
  try {
    expect(
      await createBriefSubmissionReader({
        ...config,
        httpInstance: server.httpInstance,
      }).readBriefSubmissions({ businessDate }),
    ).toMatchObject({
      status: "incomplete",
      reason: "page_unavailable",
      providerCode: 999,
      messages: [{ messageId: "om_alice" }],
      entries: [],
      decisions: [],
    });
  } finally {
    await server.close();
  }
});

test("unresolved platform names require review rather than using self-written names", async () => {
  const server = await larkHttpServer(() => ({
    body: {
      code: 0,
      data: {
        has_more: false,
        items: [
          {
            ...task,
            sender: { ...task.sender, sender_name: "" },
            body: {
              content: JSON.stringify({
                text: "Alice's to-do list\n1. Review budget",
              }),
            },
          },
        ],
      },
    },
  }));
  try {
    expect(
      await createBriefSubmissionReader({
        ...config,
        httpInstance: server.httpInstance,
      }).readBriefSubmissions({ businessDate }),
    ).toMatchObject({
      status: "review_required",
      entries: [],
      decisions: [
        { messageId: "om_alice", outcome: "review", reason: "unresolved_name" },
      ],
    });
  } finally {
    await server.close();
  }
});

test.each([
  "TODO",
  "To Do",
  "To-Do",
  "to  do list",
  "TO - DO LIST",
  "Monday To-do list",
])("late submissions retain the shared heading rule: %s", async (heading) => {
  const server = await larkHttpServer(() => ({
    body: {
      code: 0,
      data: {
        has_more: false,
        items: [
          {
            ...task,
            body: {
              content: JSON.stringify({ text: `${heading}\n1. Review budget` }),
            },
          },
        ],
      },
    },
  }));
  try {
    expect(
      await createBriefSubmissionReader({
        ...config,
        httpInstance: server.httpInstance,
      }).readBriefSubmissions({ businessDate }),
    ).toMatchObject({
      status: "complete",
      entries: [{ displayName: "Alice", timeliness: "late" }],
    });
  } finally {
    await server.close();
  }
});

test("a complete empty capture differs from failed retrieval", async () => {
  const server = await larkHttpServer(() => ({
    body: { code: 0, data: { has_more: false, items: [] } },
  }));
  try {
    expect(
      await createBriefSubmissionReader({
        ...config,
        httpInstance: server.httpInstance,
      }).readBriefSubmissions({ businessDate }),
    ).toMatchObject({
      status: "complete",
      entries: [],
      decisions: [],
      messages: [],
    });
  } finally {
    await server.close();
  }
});

test("discussion, bot posts, forwards and thread replies are not brief submissions", async () => {
  const server = await larkHttpServer(() => ({
    body: {
      code: 0,
      data: {
        has_more: false,
        items: [
          task,
          {
            ...task,
            message_id: "om_chat",
            body: {
              content: JSON.stringify({ text: "Good morning everyone" }),
            },
          },
          {
            ...task,
            message_id: "om_bot",
            sender: { ...task.sender, sender_type: "app" },
          },
          {
            ...task,
            message_id: "om_forward",
            upper_message_id: "om_original",
          },
          { ...task, message_id: "om_reply", root_id: "om_root" },
        ],
      },
    },
  }));
  try {
    const result = await createBriefSubmissionReader({
      ...config,
      policy: {
        appId: policy.appId,
        sourceChatId: policy.sourceChatId,
        timeZone: "Africa/Nairobi",
        publicHolidays: [],
      },
      httpInstance: server.httpInstance,
    }).readBriefSubmissions({ businessDate });
    expect(result.status).toBe("complete");
    expect(result.entries.map((entry) => entry.evidence.messageId)).toEqual([
      "om_alice",
    ]);
    expect(
      result.decisions.map((decision) => [decision.messageId, decision.reason]),
    ).toEqual([
      ["om_alice", "task_list"],
      ["om_chat", "not_task_list"],
      ["om_bot", "non_human_sender"],
      ["om_forward", "not_original_submission"],
      ["om_reply", "thread_reply_excluded"],
    ]);
  } finally {
    await server.close();
  }
});
