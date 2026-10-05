import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { evaluateSubmissions } from "../../src/evaluate-submissions.js";
import { openReportLedger } from "../../src/report-ledger.js";
import { createSubmissionHistoryReader } from "../../src/submission-history.js";
import { larkHttpServer } from "../support/lark-http-server.js";

const now = Date.parse("2026-10-02T07:01:00.000Z");
const config = {
  appId: "cli_test",
  appSecret: "synthetic-app-secret",
  sourceChatId: "oc_source",
};
const grant = {
  appId: "cli_test",
  accessToken: "synthetic-user-access-token",
  expiresAtMs: Date.parse("2026-10-02T08:00:00.000Z"),
};
const request = {
  businessDate: "2026-10-02",
  sourceChatId: "oc_source",
  replyPolicy: "exclude",
} as const;
const task = {
  message_id: "om_anthony",
  chat_id: "oc_source",
  msg_type: "text",
  create_time: "1790924100000",
  update_time: "1790924430000",
  deleted: false,
  updated: true,
  sender: {
    id: "ou_anthony",
    id_type: "open_id",
    sender_type: "user",
    tenant_key: "tenant_external",
    sender_name: "External user",
    sender_i18n_names: { en_us: "Anthony" },
  },
  body: {
    content: JSON.stringify({ text: "Task list\n1. Review infrastructure" }),
  },
};

test("history waits until 10:01 and covers the whole 10:00 minute", async () => {
  let clock = Date.parse("2026-10-02T07:00:59.999Z");
  const server = await larkHttpServer(() => ({
    body: { code: 0, data: { has_more: false, items: [] } },
  }));
  const reader = createSubmissionHistoryReader({
    ...config,
    getUserAccessToken: async () => grant,
    httpInstance: server.httpInstance,
    clock: () => clock,
  });
  try {
    expect(await reader.readSubmissionHistory(request)).toMatchObject({
      status: "unavailable",
      reason: "before_cutoff",
    });
    expect(server.requests).toEqual([]);
    clock = Date.parse("2026-10-02T07:01:00.000Z");
    expect(await reader.readSubmissionHistory(request)).toMatchObject({
      status: "complete",
      throughMs: Date.parse("2026-10-02T07:01:00.000Z"),
    });
    expect(server.requests[0]?.query.end_time).toBe("1790924461");
  } finally {
    await server.close();
  }
});

test("a credential source that never answers returns a bounded failure without reading history", async () => {
  const server = await larkHttpServer(() => ({ body: {} }));
  try {
    const result = await Promise.race([
      createSubmissionHistoryReader({
        ...config,
        credentialTimeoutMs: 10,
        getUserAccessToken: () => new Promise(() => {}),
        httpInstance: server.httpInstance,
        clock: () => now,
      }).readSubmissionHistory(request),
      new Promise((resolve) =>
        setTimeout(() => resolve({ status: "test_deadline_exceeded" }), 200),
      ),
    ]);
    expect(result).toMatchObject({
      status: "unavailable",
      reason: "credentials_timed_out",
    });
    expect(server.requests).toEqual([]);
  } finally {
    await server.close();
  }
});

test.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5, 101])(
  "invalid page bounds cannot disable the reader limit: %s",
  async (maxPages) => {
    const server = await larkHttpServer(() => ({
      body: { code: 0, data: { has_more: false, items: [] } },
    }));
    try {
      expect(
        await createSubmissionHistoryReader({
          ...config,
          maxPages,
          getUserAccessToken: async () => grant,
          httpInstance: server.httpInstance,
          clock: () => now,
        }).readSubmissionHistory(request),
      ).toMatchObject({
        status: "unavailable",
        reason: "invalid_reader_configuration",
      });
      expect(server.requests).toEqual([]);
    } finally {
      await server.close();
    }
  },
);

test("a newer edit does not hide contradictory copies of an older source version", async () => {
  const server = await larkHttpServer((incoming) => ({
    body: {
      code: 0,
      data: {
        has_more: !incoming.query.page_token,
        page_token: "second",
        items: incoming.query.page_token
          ? [
              {
                ...task,
                update_time: "1790924450000",
                body: {
                  content: JSON.stringify({ text: "Task list\n1. New edit" }),
                },
              },
              {
                ...task,
                body: {
                  content: JSON.stringify({
                    text: "Task list\n1. Contradictory old edit",
                  }),
                },
              },
            ]
          : [task],
      },
    },
  }));
  try {
    expect(
      await createSubmissionHistoryReader({
        ...config,
        getUserAccessToken: async () => grant,
        httpInstance: server.httpInstance,
        clock: () => now,
      }).readSubmissionHistory(request),
    ).toMatchObject({ status: "incomplete", reason: "source_conflict" });
  } finally {
    await server.close();
  }
});

test("a nested forwarded task list preserves provenance and is excluded from submitters", async () => {
  const server = await larkHttpServer(() => ({
    body: {
      code: 0,
      data: {
        has_more: false,
        items: [{ ...task, upper_message_id: "om_forward_container" }],
      },
    },
  }));
  try {
    const scan = await createSubmissionHistoryReader({
      ...config,
      getUserAccessToken: async () => grant,
      httpInstance: server.httpInstance,
      clock: () => now,
    }).readSubmissionHistory(request);
    expect(scan.status).toBe("complete");
    expect(
      evaluateSubmissions({
        businessDate: request.businessDate,
        messages: scan.messages,
        policy: {
          ...config,
          timeZone: "Africa/Nairobi",
          publicHolidays: [],
          replyPolicy: "exclude",
          preferredLocale: "en_us",
        },
      }),
    ).toMatchObject({
      status: "ready",
      entries: [],
      decisions: [{ reason: "not_original_submission" }],
    });
  } finally {
    await server.close();
  }
});

test.each([
  { ...task, sender: { ...task.sender, id: 42 } },
  { ...task, sender: { ...task.sender, tenant_key: 42 } },
  { ...task, sender: { ...task.sender, sender_name: ["Anthony"] } },
  { ...task, root_id: 42 },
  { ...task, parent_id: [] },
])(
  "malformed identity and thread metadata cannot enter a complete scan: %#",
  async (message) => {
    const server = await larkHttpServer(() => ({
      body: { code: 0, data: { has_more: false, items: [message] } },
    }));
    try {
      expect(
        await createSubmissionHistoryReader({
          ...config,
          getUserAccessToken: async () => grant,
          httpInstance: server.httpInstance,
          clock: () => now,
        }).readSubmissionHistory(request),
      ).toMatchObject({ status: "incomplete", reason: "invalid_message" });
    } finally {
      await server.close();
    }
  },
);

test.each([
  null,
  { code: "synthetic-user-access-token" },
  { code: {} },
  { code: Number.POSITIVE_INFINITY },
])(
  "malformed result codes cannot leak provider data into a scan: %j",
  async (body) => {
    const server = await larkHttpServer(() => ({ body }));
    try {
      const scan = await createSubmissionHistoryReader({
        ...config,
        getUserAccessToken: async () => grant,
        httpInstance: server.httpInstance,
        clock: () => now,
      }).readSubmissionHistory(request);
      expect(scan).toMatchObject({
        status: "unavailable",
        reason: "invalid_response",
      });
      expect(scan).not.toHaveProperty("providerCode");
      expect(JSON.stringify(scan)).not.toContain("synthetic-user-access-token");
    } finally {
      await server.close();
    }
  },
);

test("a later live version cannot resurrect a recall already observed in the same scan", async () => {
  const server = await larkHttpServer((incoming) => ({
    body: {
      code: 0,
      data: {
        has_more: !incoming.query.page_token,
        page_token: "page-two",
        items: [
          incoming.query.page_token
            ? { ...task, update_time: "1790924450000" }
            : { ...task, deleted: true, body: undefined },
        ],
      },
    },
  }));
  const reader = createSubmissionHistoryReader({
    ...config,
    getUserAccessToken: async () => grant,
    httpInstance: server.httpInstance,
    clock: () => now,
  });
  try {
    expect(await reader.readSubmissionHistory(request)).toMatchObject({
      status: "incomplete",
      reason: "source_conflict",
    });
  } finally {
    await server.close();
  }
});

test("a recall on an overlapping page supersedes the same-time live content", async () => {
  const server = await larkHttpServer((incoming) => ({
    body: {
      code: 0,
      data: {
        has_more: !incoming.query.page_token,
        page_token: "page-two",
        items: [
          incoming.query.page_token
            ? { ...task, deleted: true, body: undefined }
            : task,
        ],
      },
    },
  }));
  const reader = createSubmissionHistoryReader({
    ...config,
    getUserAccessToken: async () => grant,
    httpInstance: server.httpInstance,
    clock: () => now,
  });
  try {
    expect(await reader.readSubmissionHistory(request)).toMatchObject({
      status: "complete",
      messages: [{ messageId: "om_anthony", deleted: true, content: "" }],
    });
  } finally {
    await server.close();
  }
});

test("an explicit recall at the same update time excludes the previously observed submission", async () => {
  const directory = mkdtempSync(join(tmpdir(), "task-list-reader-"));
  let recalled = false;
  const server = await larkHttpServer(() => ({
    body: {
      code: 0,
      data: {
        has_more: false,
        items: [
          {
            ...task,
            ...(recalled
              ? { deleted: true, body: undefined }
              : {
                  sender: {
                    ...task.sender,
                    sender_name: undefined,
                    sender_i18n_names: undefined,
                  },
                }),
          },
        ],
      },
    },
  }));
  const reader = createSubmissionHistoryReader({
    ...config,
    getUserAccessToken: async () => grant,
    httpInstance: server.httpInstance,
    clock: () => now,
  });
  const ledger = openReportLedger({
    databasePath: join(directory, "report.sqlite"),
    appId: config.appId,
    sourceChatId: config.sourceChatId,
    destinationChatId: "oc_destination",
    clock: () => now,
  });
  const policy = {
    ...config,
    timeZone: "Africa/Nairobi",
    publicHolidays: [],
    replyPolicy: "exclude",
    preferredLocale: "en_us",
    policyVersion: "fixture-v1",
  } as const;
  try {
    expect(
      ledger.prepareDailyReport({
        businessDate: request.businessDate,
        scan: await reader.readSubmissionHistory(request),
        policy,
      }),
    ).toMatchObject({ status: "blocked", reasons: ["unresolved_name"] });
    recalled = true;
    expect(
      ledger.prepareDailyReport({
        businessDate: request.businessDate,
        scan: await reader.readSubmissionHistory(request),
        policy,
      }),
    ).toMatchObject({
      status: "frozen",
      delivery: {
        text: "2 October 2026\nNo valid submissions found by the approved cutoff",
      },
    });
  } finally {
    ledger.close();
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("only main posts before 10:01 enter the report, including the last millisecond of 10:00", async () => {
  const directory = mkdtempSync(join(tmpdir(), "task-list-reader-"));
  const items = [
    { ...task, root_id: task.message_id, thread_id: "omt_root" },
    {
      ...task,
      message_id: "om_at_cutoff",
      create_time: "1790924459999",
      update_time: "1790924459999",
      updated: false,
      sender: {
        ...task.sender,
        id: "ou_cutoff",
        sender_i18n_names: { en_us: "On Time" },
      },
    },
    {
      ...task,
      message_id: "om_late",
      create_time: "1790924460000",
      update_time: "1790924460000",
      updated: false,
      sender: {
        ...task.sender,
        id: "ou_late",
        sender_i18n_names: { en_us: "Late" },
      },
    },
    {
      ...task,
      message_id: "om_reply",
      root_id: task.message_id,
      parent_id: task.message_id,
      sender: {
        ...task.sender,
        id: "ou_reply",
        sender_i18n_names: { en_us: "Reply" },
      },
    },
  ];
  const server = await larkHttpServer(() => ({
    body: { code: 0, data: { has_more: false, items } },
  }));
  const reader = createSubmissionHistoryReader({
    ...config,
    getUserAccessToken: async () => grant,
    httpInstance: server.httpInstance,
    clock: () => now,
  });
  const ledger = openReportLedger({
    databasePath: join(directory, "report.sqlite"),
    appId: config.appId,
    sourceChatId: config.sourceChatId,
    destinationChatId: "oc_destination",
    clock: () => now,
  });
  try {
    const scan = await reader.readSubmissionHistory(request);
    expect(
      ledger.prepareDailyReport({
        businessDate: request.businessDate,
        scan,
        policy: {
          ...config,
          timeZone: "Africa/Nairobi",
          publicHolidays: [],
          replyPolicy: "exclude",
          preferredLocale: "en_us",
          policyVersion: "fixture-v1",
        },
      }),
    ).toMatchObject({
      status: "frozen",
      delivery: { text: "2 October 2026\n1. Anthony\n2. On Time" },
    });
  } finally {
    ledger.close();
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rich-text and page observation times survive reader-to-ledger preparation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "task-list-reader-"));
  const now = Date.parse("2026-10-02T07:02:00.000Z");
  let time = now;
  const postContent = JSON.stringify({
    en_us: {
      title: "Task list",
      content: [[{ tag: "text", text: "1. Review UI" }]],
    },
  });
  const post = {
    ...task,
    message_id: "om_zoe",
    msg_type: "post",
    create_time: "1790923800000",
    update_time: "1790923800000",
    updated: false,
    sender: {
      ...task.sender,
      id: "ou_zoe",
      tenant_key: "tenant_second",
      sender_i18n_names: { en_us: "Zoe" },
    },
    body: { content: postContent },
  };
  const server = await larkHttpServer((incoming) => {
    time = incoming.query.page_token ? now : now - 10_000;
    return {
      body: {
        code: 0,
        data: {
          has_more: !incoming.query.page_token,
          page_token: "page-two",
          items: [incoming.query.page_token ? post : task],
        },
      },
    };
  });
  const reader = createSubmissionHistoryReader({
    ...config,
    getUserAccessToken: async () => grant,
    httpInstance: server.httpInstance,
    clock: () => time,
  });
  const ledger = openReportLedger({
    databasePath: join(directory, "report.sqlite"),
    appId: config.appId,
    sourceChatId: config.sourceChatId,
    destinationChatId: "oc_destination",
    clock: () => now,
  });
  try {
    const scan = await reader.readSubmissionHistory(request);
    expect(scan).toMatchObject({
      status: "complete",
      observedAtMs: now,
      messages: [
        { messageId: "om_anthony", observedAtMs: now - 10_000 },
        { messageId: "om_zoe", observedAtMs: now },
      ],
    });
    expect(
      ledger.prepareDailyReport({
        businessDate: request.businessDate,
        scan,
        policy: {
          ...config,
          timeZone: "Africa/Nairobi",
          publicHolidays: [],
          replyPolicy: "exclude",
          preferredLocale: "en_us",
          policyVersion: "fixture-v1",
        },
      }),
    ).toMatchObject({
      status: "frozen",
      delivery: {
        text: "2 October 2026\n1. Zoe\n2. Anthony",
        entries: [
          {
            observation: {
              content: postContent,
              observedAtMs: now,
              sourceRoute: "lark.im.v1.message.list:user",
            },
          },
          { observation: { observedAtMs: now - 10_000 } },
        ],
      },
    });
  } finally {
    ledger.close();
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test.each([
  {
    ...task,
    body: {
      content: JSON.stringify({
        text: "Task list\n1. Conflicting equal-time body",
      }),
    },
  },
  {
    ...task,
    sender: { ...task.sender, id: "ou_other" },
    update_time: "1790924450000",
  },
  {
    ...task,
    sender: { ...task.sender, tenant_key: "tenant_other" },
    update_time: "1790924450000",
  },
  { ...task, create_time: "1790924099999", update_time: "1790924450000" },
])(
  "overlapping conflicting source evidence cannot assert complete coverage: %#",
  async (conflict) => {
    const server = await larkHttpServer((incoming) => ({
      body: {
        code: 0,
        data: {
          has_more: !incoming.query.page_token,
          page_token: "page-two",
          items: [incoming.query.page_token ? conflict : task],
        },
      },
    }));
    const reader = createSubmissionHistoryReader({
      ...config,
      getUserAccessToken: async () => grant,
      httpInstance: server.httpInstance,
      clock: () => now,
    });
    try {
      expect(await reader.readSubmissionHistory(request)).toMatchObject({
        status: "incomplete",
        reason: "source_conflict",
      });
    } finally {
      await server.close();
    }
  },
);

test("overlapping pages yield one current version and never regress to an older edit", async () => {
  const newer = {
    ...task,
    update_time: "1790924450000",
    body: {
      content: JSON.stringify({ text: "Task list\n1. Edited current task" }),
    },
  };
  const server = await larkHttpServer((incoming) => ({
    body: incoming.query.page_token
      ? { code: 0, data: { has_more: false, items: [task, newer, task] } }
      : {
          code: 0,
          data: { has_more: true, page_token: "page-two", items: [task] },
        },
  }));
  const reader = createSubmissionHistoryReader({
    ...config,
    getUserAccessToken: async () => grant,
    httpInstance: server.httpInstance,
    clock: () => now,
  });
  try {
    const scan = await reader.readSubmissionHistory(request);
    expect(scan).toMatchObject({
      status: "complete",
      messages: [
        {
          messageId: "om_anthony",
          updatedMs: 1790924450000,
          content: newer.body.content,
        },
      ],
    });
    expect(scan.messages).toHaveLength(1);
  } finally {
    await server.close();
  }
});

test.each([
  { date: "2026-02-30", time: now, reason: "invalid_business_date" },
  { date: "02/10/2026", time: now, reason: "invalid_business_date" },
  { date: "2026-10-02", time: now - 1, reason: "before_cutoff" },
  { date: "2026-10-02", time: Number.NaN, reason: "invalid_clock" },
])(
  "unsafe compilation intervals do not read history: $reason",
  async ({ date, time, reason }) => {
    const server = await larkHttpServer(() => ({
      body: { code: 0, data: { has_more: false, items: [] } },
    }));
    const reader = createSubmissionHistoryReader({
      ...config,
      getUserAccessToken: async () => grant,
      httpInstance: server.httpInstance,
      clock: () => time,
    });
    try {
      expect(
        await reader.readSubmissionHistory({ ...request, businessDate: date }),
      ).toMatchObject({ status: "unavailable", reason });
      expect(server.requests).toEqual([]);
    } finally {
      await server.close();
    }
  },
);

test.each([
  { ...task, message_id: "" },
  { ...task, chat_id: "oc_other" },
  { ...task, msg_type: undefined },
  { ...task, create_time: "not-a-timestamp" },
  { ...task, update_time: "not-a-timestamp" },
  { ...task, update_time: undefined },
  { ...task, update_time: "1790924099999" },
  { ...task, deleted: "false" },
  { ...task, body: undefined },
  { ...task, body: { content: "" } },
  { ...task, sender: null },
  { ...task, sender: { ...task.sender, sender_type: undefined } },
])(
  "malformed required message data blocks a complete scan: %#",
  async (item) => {
    const server = await larkHttpServer(() => ({
      body: { code: 0, data: { has_more: false, items: [item] } },
    }));
    const reader = createSubmissionHistoryReader({
      ...config,
      getUserAccessToken: async () => grant,
      httpInstance: server.httpInstance,
      clock: () => now,
    });
    try {
      expect(await reader.readSubmissionHistory(request)).toMatchObject({
        status: "incomplete",
        reason: "invalid_message",
      });
    } finally {
      await server.close();
    }
  },
);

test.each([
  { status: 401, reason: "authorization_failed" },
  { status: 429, reason: "rate_limited" },
])(
  "HTTP $status returns an actionable bounded failure",
  async ({ status, reason }) => {
    const server = await larkHttpServer(() => ({
      status,
      body: { code: 1, msg: "sensitive provider details" },
    }));
    const reader = createSubmissionHistoryReader({
      ...config,
      getUserAccessToken: async () => grant,
      httpInstance: server.httpInstance,
      clock: () => now,
    });
    try {
      expect(await reader.readSubmissionHistory(request)).toMatchObject({
        status: "unavailable",
        reason,
      });
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  },
);

test("reaching a configured page limit returns incomplete instead of truncating silently", async () => {
  let calls = 0;
  const server = await larkHttpServer(() => {
    calls += 1;
    return {
      body: {
        code: 0,
        data: { has_more: calls < 2, page_token: "next-page", items: [task] },
      },
    };
  });
  const reader = createSubmissionHistoryReader({
    ...config,
    getUserAccessToken: async () => grant,
    httpInstance: server.httpInstance,
    clock: () => now,
    maxPages: 1,
  });
  try {
    expect(await reader.readSubmissionHistory(request)).toMatchObject({
      status: "incomplete",
      reason: "page_limit_reached",
    });
    expect(server.requests).toHaveLength(1);
  } finally {
    await server.close();
  }
});

test("repeating cursors stop the scan before another repeated page is requested", async () => {
  let calls = 0;
  const server = await larkHttpServer(() => {
    calls += 1;
    return {
      body: {
        code: 0,
        data: { has_more: calls < 3, page_token: "repeated", items: [task] },
      },
    };
  });
  const reader = createSubmissionHistoryReader({
    ...config,
    getUserAccessToken: async () => grant,
    httpInstance: server.httpInstance,
    clock: () => now,
  });
  try {
    expect(await reader.readSubmissionHistory(request)).toMatchObject({
      status: "incomplete",
      reason: "pagination_incomplete",
    });
    expect(server.requests).toHaveLength(2);
  } finally {
    await server.close();
  }
});

test.each([
  {
    token: { ...grant, appId: "cli_other" },
    reason: "credential_scope_mismatch",
  },
  { token: { ...grant, accessToken: "" }, reason: "credentials_unavailable" },
  { token: { ...grant, expiresAtMs: now }, reason: "credentials_expired" },
  {
    token: { ...grant, expiresAtMs: Number.NaN },
    reason: "credentials_unavailable",
  },
])(
  "unsafe credentials block all history requests: $reason",
  async ({ token, reason }) => {
    const server = await larkHttpServer(() => ({
      body: { code: 0, data: { has_more: false, items: [] } },
    }));
    const reader = createSubmissionHistoryReader({
      ...config,
      getUserAccessToken: async () => token,
      httpInstance: server.httpInstance,
      clock: () => now,
    });
    try {
      expect(await reader.readSubmissionHistory(request)).toMatchObject({
        status: "unavailable",
        reason,
      });
      expect(server.requests).toEqual([]);
    } finally {
      await server.close();
    }
  },
);

test("thread inclusion cannot be labelled complete by the root-only reader", async () => {
  const server = await larkHttpServer(() => ({
    body: { code: 0, data: { has_more: false, items: [task] } },
  }));
  const reader = createSubmissionHistoryReader({
    ...config,
    getUserAccessToken: async () => grant,
    httpInstance: server.httpInstance,
    clock: () => now,
  });
  try {
    expect(
      await reader.readSubmissionHistory({
        ...request,
        replyPolicy: "include",
      }),
    ).toMatchObject({
      status: "unavailable",
      reason: "unsupported_reply_policy",
    });
    expect(server.requests).toEqual([]);
  } finally {
    await server.close();
  }
});

test("a request outside the configured source cannot read any group", async () => {
  const server = await larkHttpServer(() => ({
    body: { code: 0, data: { has_more: false, items: [] } },
  }));
  let credentialCalls = 0;
  const reader = createSubmissionHistoryReader({
    ...config,
    getUserAccessToken: async () => {
      credentialCalls += 1;
      return grant;
    },
    httpInstance: server.httpInstance,
    clock: () => now,
  });
  try {
    expect(
      await reader.readSubmissionHistory({
        ...request,
        sourceChatId: "oc_other",
      }),
    ).toMatchObject({ status: "unavailable", reason: "source_scope_mismatch" });
    expect(credentialCalls).toBe(0);
    expect(server.requests).toEqual([]);
  } finally {
    await server.close();
  }
});

test.each([
  { has_more: false },
  { items: [] },
  { has_more: false, items: null },
  { has_more: false, items: {} },
])(
  "a malformed page envelope cannot assert complete coverage: %j",
  async (data) => {
    const server = await larkHttpServer(() => ({ body: { code: 0, data } }));
    const reader = createSubmissionHistoryReader({
      ...config,
      getUserAccessToken: async () => grant,
      httpInstance: server.httpInstance,
      clock: () => now,
    });
    try {
      expect(await reader.readSubmissionHistory(request)).toMatchObject({
        status: "unavailable",
        reason: "invalid_response",
      });
    } finally {
      await server.close();
    }
  },
);

test.each([200, 400])(
  "an API access denial cannot become a successful empty scan (HTTP %s)",
  async (status) => {
    const server = await larkHttpServer(() => ({
      status,
      body: {
        code: 230027,
        msg: "sensitive provider details",
        data: { has_more: false, items: [] },
      },
    }));
    const reader = createSubmissionHistoryReader({
      ...config,
      getUserAccessToken: async () => grant,
      httpInstance: server.httpInstance,
      clock: () => now,
    });
    try {
      expect(await reader.readSubmissionHistory(request)).toMatchObject({
        status: "unavailable",
        reason: "source_access_denied",
        providerCode: 230027,
      });
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  },
);

test("a failed second page leaves explicit incomplete evidence", async () => {
  const server = await larkHttpServer((incoming) =>
    incoming.query.page_token
      ? {
          status: 503,
          body: {
            code: 999,
            msg: "synthetic-user-access-token must not escape",
          },
        }
      : {
          body: {
            code: 0,
            data: { has_more: true, page_token: "page-two", items: [task] },
          },
        },
  );
  const reader = createSubmissionHistoryReader({
    ...config,
    getUserAccessToken: async () => grant,
    httpInstance: server.httpInstance,
    clock: () => now,
  });
  try {
    const scan = await reader.readSubmissionHistory(request);
    expect(scan).toMatchObject({
      status: "incomplete",
      reason: "page_unavailable",
      messages: [{ messageId: "om_anthony" }],
    });
    expect(JSON.stringify(scan)).not.toContain("synthetic-user-access-token");
    expect(server.requests).toHaveLength(2);
  } finally {
    await server.close();
  }
});

test("a missing pagination cursor cannot become a successful empty report", async () => {
  const directory = mkdtempSync(join(tmpdir(), "task-list-reader-"));
  const server = await larkHttpServer(() => ({
    body: { code: 0, data: { has_more: true, items: [] } },
  }));
  const reader = createSubmissionHistoryReader({
    ...config,
    getUserAccessToken: async () => grant,
    httpInstance: server.httpInstance,
    clock: () => now,
  });
  const ledger = openReportLedger({
    databasePath: join(directory, "report.sqlite"),
    appId: config.appId,
    sourceChatId: config.sourceChatId,
    destinationChatId: "oc_destination",
    clock: () => now,
  });
  try {
    const scan = await reader.readSubmissionHistory(request);
    expect(scan).toMatchObject({
      status: "incomplete",
      reason: "pagination_incomplete",
    });
    expect(
      ledger.prepareDailyReport({
        businessDate: request.businessDate,
        scan,
        policy: {
          ...config,
          timeZone: "Africa/Nairobi",
          publicHolidays: [],
          replyPolicy: "exclude",
          policyVersion: "fixture-v1",
        },
      }),
    ).toMatchObject({ status: "blocked", reasons: ["scan_incomplete"] });
    expect(server.requests).toHaveLength(1);
  } finally {
    ledger.close();
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a task list on the second history page appears once in the frozen report", async () => {
  const directory = mkdtempSync(join(tmpdir(), "task-list-reader-"));
  const server = await larkHttpServer((incoming) => ({
    body: incoming.query.page_token
      ? { code: 0, data: { has_more: false, items: [task] } }
      : {
          code: 0,
          data: {
            has_more: true,
            page_token: "page-two",
            items: [
              {
                ...task,
                message_id: "om_discussion",
                updated: false,
                body: { content: JSON.stringify({ text: "Good morning" }) },
              },
            ],
          },
        },
  }));
  const reader = createSubmissionHistoryReader({
    ...config,
    getUserAccessToken: async () => grant,
    httpInstance: server.httpInstance,
    clock: () => now,
  });
  const ledger = openReportLedger({
    databasePath: join(directory, "report.sqlite"),
    appId: config.appId,
    sourceChatId: config.sourceChatId,
    destinationChatId: "oc_destination",
    clock: () => now,
  });
  try {
    const scan = await reader.readSubmissionHistory(request);
    expect(scan).toMatchObject({
      status: "complete",
      appId: "cli_test",
      businessDate: "2026-10-02",
      replyPolicy: "exclude",
      fromMs: 1790888400000,
      throughMs: 1790924460000,
      observedAtMs: now,
      messages: [
        { messageId: "om_discussion" },
        {
          messageId: "om_anthony",
          createdMs: 1790924100000,
          updatedMs: 1790924430000,
          sender: {
            openId: "ou_anthony",
            tenantKey: "tenant_external",
            localizedNames: { en_us: "Anthony" },
          },
          content: task.body.content,
        },
      ],
    });
    expect(server.origins).toEqual([
      "https://open.larksuite.com",
      "https://open.larksuite.com",
    ]);
    expect(server.requests).toEqual([
      {
        method: "GET",
        path: "/open-apis/im/v1/messages",
        body: {},
        authorization: "Bearer synthetic-user-access-token",
        query: {
          container_id_type: "chat",
          container_id: "oc_source",
          start_time: "1790888399",
          end_time: "1790924461",
          sort_type: "ByCreateTimeAsc",
          page_size: "50",
          only_thread_root_messages: "true",
          with_sender_name: "true",
        },
      },
      {
        method: "GET",
        path: "/open-apis/im/v1/messages",
        body: {},
        authorization: "Bearer synthetic-user-access-token",
        query: {
          container_id_type: "chat",
          container_id: "oc_source",
          start_time: "1790888399",
          end_time: "1790924461",
          sort_type: "ByCreateTimeAsc",
          page_size: "50",
          only_thread_root_messages: "true",
          with_sender_name: "true",
          page_token: "page-two",
        },
      },
    ]);
    const prepared = ledger.prepareDailyReport({
      businessDate: request.businessDate,
      scan,
      policy: {
        ...config,
        timeZone: "Africa/Nairobi",
        publicHolidays: [],
        replyPolicy: "exclude",
        preferredLocale: "en_us",
        policyVersion: "fixture-v1",
      },
    });
    expect(prepared).toMatchObject({
      status: "frozen",
      delivery: {
        text: "2 October 2026\n1. Anthony",
        entries: [
          {
            displayName: "Anthony",
            observation: {
              content: task.body.content,
              createdMs: 1790924100000,
              updatedMs: 1790924430000,
            },
          },
        ],
      },
    });
  } finally {
    ledger.close();
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
