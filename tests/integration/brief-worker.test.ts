import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createBriefGenerator } from "../../src/brief-generator-factory.js";
import { openBriefLedger } from "../../src/brief-ledger.js";
import { createDueWorker } from "../../src/due-worker.js";
import { createLarkDeliveryTransport } from "../../src/lark-delivery.js";
import {
  businessDate,
  config,
  message,
} from "../support/brief-coordinator-fixtures.js";
import { briefProviderHttpServer } from "../support/brief-provider-http-server.js";
import {
  type CapturedLarkRequest,
  larkHttpServer,
} from "../support/lark-http-server.js";
import { scheduledDocFixture } from "../support/scheduled-doc-fixture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const at = (time: string) => Date.parse(`${businessDate}T${time}+03:00`);

/** Real history SDK and SQLite; controlled clock and entirely synthetic Lark submissions. */
async function setup() {
  let now = at("10:15:00");
  const directory = mkdtempSync(join(tmpdir(), "brief-worker-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "ledger.sqlite");
  let override:
    | ((
        request: CapturedLarkRequest,
      ) => { body: unknown; status?: number } | undefined)
    | undefined;
  const server = await larkHttpServer(
    (request) =>
      override?.(request) ?? {
        body: request.path.includes("tenant_access_token")
          ? { code: 0, tenant_access_token: "synthetic-token", expire: 7200 }
          : {
              code: 0,
              data: {
                has_more: false,
                items: [
                  message("Alice", "09:45:00", "Prepare drawings"),
                  message("Bob", "10:07:00", "Review estimates"),
                ].map((source) => ({
                  message_id: source.messageId,
                  chat_id: config.sourceChatId,
                  msg_type: "text",
                  create_time: String(source.createdMs),
                  update_time: String(source.updatedMs),
                  deleted: false,
                  updated: false,
                  sender: {
                    id: source.sender.openId,
                    id_type: "open_id",
                    sender_type: "user",
                    tenant_key: source.sender.tenantKey,
                    sender_name: source.sender.displayName,
                  },
                  body: { content: source.content },
                })),
              },
            },
      },
  );
  cleanups.push(server.close);
  const options = {
    ...config,
    databasePath,
    activationDate: businessDate,
    calendar: {
      version: "calendar-v1",
      fromDate: "2026-01-01",
      throughDate: "2026-12-31",
      reviewedOn: "2026-01-01",
      sourceUrls: ["https://example.invalid/synthetic"],
      publicHolidays: [],
    },
    policy: {
      policyVersion: config.policy.policyVersion,
      replyPolicy: "exclude" as const,
    },
    reminderText: "Please post today's task list by 10:00 AM Nairobi.",
    reader: {
      appId: config.appId,
      sourceChatId: config.sourceChatId,
      appSecret: "synthetic-secret",
      getUserAccessToken: async () => ({
        appId: config.appId,
        accessToken: "synthetic-user-token",
        expiresAtMs: now + 3600_000,
      }),
      httpInstance: server.httpInstance,
    },
    clock: () => now,
    brief: {
      mode: "capture_only" as const,
      activationDate: businessDate,
      provider: config.provider,
      model: config.model,
      templateVersion: config.templateVersion,
      promptVersion: config.promptVersion,
      schemaVersion: config.schemaVersion,
    },
  };
  const worker = createDueWorker(options);
  cleanups.push(worker.close);
  return {
    worker,
    options,
    server,
    respondWith: (respond: NonNullable<typeof override>) => {
      override = respond;
    },
    setNow: (value: number) => {
      now = value;
    },
    setTime: (value: string) => {
      now = at(value);
    },
  };
}

test("at 10:15 the worker freezes late-inclusive brief input once without changing the names report cutoff", async () => {
  const { worker, options, server } = await setup();
  const result = await worker.runDueWork({ now: at("10:15:00") });
  expect(result, JSON.stringify(result)).toMatchObject({
    status: "ok",
    report: { state: "pending" },
    brief: { state: "input_frozen", mode: "capture_only", entryCount: 2 },
  });
  const ledger = openBriefLedger({
    ...config,
    databasePath: options.databasePath,
  });
  cleanups.push(() => {
    ledger.close();
  });
  expect(
    ledger
      .getDailyBrief(businessDate)
      ?.entries.map((entry) => [entry.displayName, entry.timeliness]),
  ).toEqual([
    ["Alice", "on_time"],
    ["Bob", "late"],
  ]);
  expect(ledger.getDailyBrief(businessDate)?.captureThroughMs).toBe(
    at("10:15:00"),
  );
  const historyReads = server.requests.filter(
    (request) => request.path === "/open-apis/im/v1/messages",
  );
  expect(historyReads).toHaveLength(2);
  expect((await worker.runDueWork({ now: at("10:15:00") })).brief.state).toBe(
    "input_frozen",
  );
  expect(
    server.requests.filter(
      (request) => request.path === "/open-apis/im/v1/messages",
    ),
  ).toHaveLength(2);
});

test("the brief's own activation date skips earlier dates without suppressing the core report", async () => {
  const { options, server } = await setup();
  const worker = createDueWorker({
    ...options,
    brief: { ...options.brief, activationDate: "2026-10-02" },
  });
  cleanups.push(worker.close);
  expect(await worker.runDueWork({ now: at("10:15:00") })).toMatchObject({
    report: { state: "pending" },
    brief: { state: "skipped", reason: "before_activation" },
  });
  expect(
    server.requests.filter(
      (request) => request.path === "/open-apis/im/v1/messages",
    ),
  ).toHaveLength(1);
});

test("failed names-history coverage does not suppress the independent brief read", async () => {
  const { worker, server, respondWith } = await setup();
  respondWith((request) =>
    request.path === "/open-apis/im/v1/messages" &&
    request.query.end_time === String(at("10:01:00") / 1000 + 1)
      ? { body: { code: 99991672 }, status: 403 }
      : undefined,
  );
  expect(await worker.runDueWork({ now: at("10:15:00") })).toMatchObject({
    report: { state: "blocked" },
    brief: { state: "input_frozen", entryCount: 2 },
  });
  expect(
    server.requests.filter((r) => r.path === "/open-apis/im/v1/messages"),
  ).toHaveLength(2);
});

test("failed brief coverage is visible and leaves the frozen names report usable", async () => {
  const { worker, respondWith } = await setup();
  respondWith((request) =>
    request.path === "/open-apis/im/v1/messages" &&
    request.query.end_time === String(at("10:15:00") / 1000 + 1)
      ? { body: { code: 99991672 }, status: 403 }
      : undefined,
  );
  expect(await worker.runDueWork({ now: at("10:15:00") })).toMatchObject({
    report: { state: "pending" },
    brief: { state: "blocked", reason: expect.any(String) },
  });
});

test("publish mode composes the frozen capture, real model adapter, verified Doc and independent link delivery", async () => {
  const { options, server, respondWith } = await setup();
  const remote = scheduledDocFixture();
  respondWith(remote.respond);
  const provider = await briefProviderHttpServer(() => ({
    body: {
      candidates: [
        {
          finishReason: "STOP",
          content: {
            parts: [
              {
                text: JSON.stringify({
                  rows: [
                    { entryRef: "entry-1", summary: "Prepare drawings." },
                    { entryRef: "entry-2", summary: "Review estimates." },
                  ],
                  notes: [],
                }),
              },
            ],
          },
        },
      ],
    },
  }));
  cleanups.push(provider.close);
  const worker = createDueWorker({
    ...options,
    brief: {
      ...options.brief,
      mode: "publish",
      generator: createBriefGenerator({
        provider: config.provider,
        apiKey: "synthetic-key",
        model: config.model,
      }),
      template: "Today's brief",
      instructions: "Summarize only supplied tasks.",
      docPublishing: {
        appSecret: "synthetic-secret",
        stagingFolderToken: "folderPrivate",
        documentBaseUrl: "https://synthetic.larksuite.com/docx/",
        httpInstance: server.httpInstance,
      },
    },
    transport: createLarkDeliveryTransport({
      appId: config.appId,
      appSecret: "synthetic-secret",
      allowedDestinationChatIds: [
        config.sourceChatId,
        config.destinationChatId,
      ],
      httpInstance: server.httpInstance,
      clock: options.clock,
    }),
  });
  cleanups.push(worker.close);
  expect(await worker.runDueWork({ now: at("10:15:00") })).toMatchObject({
    report: { state: "sent" },
    brief: {
      state: "published",
      documentUrl: "https://synthetic.larksuite.com/docx/docSchedule",
      announcement: { state: "sent" },
    },
  });
  expect(provider.requests).toHaveLength(1);
  expect(JSON.stringify(remote.blocks)).toContain("Bob (late): ");
  const before = server.requests.length;
  const restarted = createDueWorker({
    ...options,
    brief: {
      ...options.brief,
      mode: "publish",
      generator: createBriefGenerator({
        provider: config.provider,
        apiKey: "synthetic-key",
        model: config.model,
      }),
      template: "Today's brief",
      instructions: "Summarize only supplied tasks.",
      docPublishing: {
        appSecret: "synthetic-secret",
        stagingFolderToken: "folderPrivate",
        documentBaseUrl: "https://synthetic.larksuite.com/docx/",
        httpInstance: server.httpInstance,
      },
    },
  });
  cleanups.push(restarted.close);
  expect(
    (await restarted.runDueWork({ now: at("10:15:00") })).brief.state,
  ).toBe("published");
  expect(server.requests).toHaveLength(before);
  expect(provider.requests).toHaveLength(1);
});

test("status surfaces older missing briefs for review without reading or compiling them", async () => {
  const { worker, server, setNow } = await setup();
  const now = Date.parse("2026-10-02T09:00:00+03:00");
  setNow(now);
  expect(worker.getStatus({ now })).toMatchObject({
    briefBackfill: {
      dates: [businessDate],
      items: [{ businessDate, state: "missing" }],
      total: 1,
    },
    brief: { state: "not_due" },
  });
  expect(server.requests).toHaveLength(0);
});

test("invalid optional brief configuration blocks only the brief and never reads its history", async () => {
  const { options, server } = await setup();
  const worker = createDueWorker({
    ...options,
    brief: { ...options.brief, activationDate: "2026-02-30" },
  });
  cleanups.push(worker.close);
  expect(await worker.runDueWork({ now: at("10:15:00") })).toMatchObject({
    report: { state: "pending" },
    brief: { state: "blocked", reason: "invalid_brief_configuration" },
  });
  expect(
    server.requests.filter((r) => r.path === "/open-apis/im/v1/messages"),
  ).toHaveLength(1);
});

test("restarting a capture-only worker reuses frozen evidence and exposes metadata without rereading", async () => {
  const { worker, options, server } = await setup();
  await worker.runDueWork({ now: at("10:15:00") });
  const before = server.requests.length;
  const restarted = createDueWorker(options);
  cleanups.push(restarted.close);
  expect(await restarted.runDueWork({ now: at("10:15:00") })).toMatchObject({
    brief: { state: "input_frozen", entryCount: 2 },
  });
  expect(server.requests).toHaveLength(before);
  const inspect = openBriefLedger({
    ...config,
    databasePath: options.databasePath,
    readOnly: true,
  });
  cleanups.push(() => {
    inspect.close();
  });
  const rows = inspect.listDailyBriefs(businessDate, businessDate);
  expect(rows).toEqual([
    {
      id: expect.any(String),
      businessDate,
      generationState: "pending",
      publicationState: "pending",
      documentUrl: null,
      announcementDeliveryId: null,
    },
  ]);
  expect(inspect.getDailyBrief(businessDate)?.entries).toHaveLength(2);
});

test("brief work is skipped before 10:15, on holidays and weekends, and paused after restore", async () => {
  const { options, server, setNow } = await setup();
  for (const [now, extra, state] of [
    [at("10:14:59"), {}, "not_due"],
    [
      at("10:15:00"),
      { calendar: { ...options.calendar, publicHolidays: [businessDate] } },
      "skipped",
    ],
    [Date.parse("2026-10-03T10:15:00+03:00"), {}, "skipped"],
    [at("10:15:00"), { restoreMode: true }, "blocked"],
  ] as const) {
    setNow(now);
    const worker = createDueWorker({ ...options, ...extra });
    cleanups.push(worker.close);
    expect((await worker.runDueWork({ now })).brief.state).toBe(state);
  }
  expect(
    server.requests.filter((r) => r.path === "/open-apis/im/v1/messages"),
  ).toHaveLength(1);
});

test("a brief read crossing midnight freezes evidence but cannot start generation or publish yesterday", async () => {
  const { options, server, respondWith, setNow } = await setup();
  const provider = await briefProviderHttpServer(() => ({
    status: 500,
    body: {},
  }));
  cleanups.push(provider.close);
  respondWith((request) => {
    if (request.query.end_time === String(at("10:15:00") / 1000 + 1))
      setNow(Date.parse("2026-10-02T00:00:00+03:00"));
    return undefined;
  });
  const worker = createDueWorker({
    ...options,
    brief: {
      ...options.brief,
      mode: "publish",
      generator: createBriefGenerator({
        provider: config.provider,
        model: config.model,
        apiKey: "synthetic-key",
      }),
      template: "Today's brief",
      instructions: "Summarize supplied tasks.",
      docPublishing: {
        appSecret: "synthetic-secret",
        stagingFolderToken: "folderPrivate",
        documentBaseUrl: "https://synthetic.larksuite.com/docx/",
        httpInstance: server.httpInstance,
      },
    },
  });
  cleanups.push(worker.close);
  const result = await worker.runDueWork({ now: at("10:15:00") });
  expect(result).toMatchObject({
    businessDate: "2026-10-02",
    brief: { state: "not_due" },
    briefBackfill: {
      items: [{ businessDate, state: "pending", briefId: expect.any(String) }],
    },
  });
  expect(provider.requests).toHaveLength(0);
  expect(
    server.requests.filter(
      (r) =>
        r.path.includes("/docx/") ||
        (r.path.endsWith("/messages") && r.method === "POST"),
    ),
  ).toHaveLength(0);
  const ledger = openBriefLedger({
    ...config,
    databasePath: options.databasePath,
    readOnly: true,
  });
  cleanups.push(() => {
    ledger.close();
  });
  expect(ledger.getDailyBrief(businessDate)).toMatchObject({
    generationState: "pending",
    generationAttemptCount: 0,
  });
});

test("changed generation versions require review without rereading or altering frozen input", async () => {
  const { worker, options, server } = await setup();
  await worker.runDueWork({ now: at("10:15:00") });
  const before = server.requests.length;
  const provider = await briefProviderHttpServer(() => ({
    status: 500,
    body: {},
  }));
  cleanups.push(provider.close);
  const restarted = createDueWorker({
    ...options,
    brief: {
      ...options.brief,
      mode: "publish",
      schemaVersion: "schema-v2",
      generator: createBriefGenerator({
        provider: config.provider,
        model: config.model,
        apiKey: "synthetic-key",
      }),
      template: "Today's brief",
      instructions: "Summarize supplied tasks.",
      docPublishing: {
        appSecret: "synthetic-secret",
        stagingFolderToken: "folderPrivate",
        documentBaseUrl: "https://synthetic.larksuite.com/docx/",
        httpInstance: server.httpInstance,
      },
    },
  });
  cleanups.push(restarted.close);
  for (let tick = 0; tick < 2; tick++)
    expect(await restarted.runDueWork({ now: at("10:15:00") })).toMatchObject({
      report: { state: "pending" },
      brief: {
        state: "blocked",
        reason: "generation_configuration_mismatch",
        briefId: expect.any(String),
      },
    });
  expect(server.requests).toHaveLength(before);
  expect(provider.requests).toHaveLength(0);
});

test("a publisher setup failure is visible without aborting core work or leaking configuration", async () => {
  const { options } = await setup();
  const worker = createDueWorker({
    ...options,
    brief: {
      ...options.brief,
      mode: "publish",
      generator: createBriefGenerator({
        provider: config.provider,
        model: config.model,
        apiKey: "synthetic-key",
      }),
      template: "Today's brief",
      instructions: "Summarize supplied tasks.",
      docPublishing: {
        appSecret: "synthetic-secret",
        stagingFolderToken: "",
        documentBaseUrl: "https://synthetic.larksuite.com/docx/",
      },
    },
  });
  cleanups.push(worker.close);
  expect(await worker.runDueWork({ now: at("10:15:00") })).toMatchObject({
    report: { state: "pending" },
    brief: { state: "blocked", reason: "brief_execution_unavailable" },
  });
});
