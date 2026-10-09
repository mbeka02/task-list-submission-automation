import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createDueWorker } from "../../src/due-worker.js";
import { createLarkDeliveryTransport } from "../../src/lark-delivery.js";
import { createOperationalLogger } from "../../src/observability.js";
import { openReportLedger } from "../../src/report-ledger.js";
import type { CapturedLarkRequest } from "../support/lark-http-server.js";
import { larkHttpServer } from "../support/lark-http-server.js";
import { logCapture } from "../support/log-capture.js";

const reminderText =
  "Please post today's task list in this group by 10:00 AM Nairobi time.";

/** Real SDK and SQLite fixture; only provider HTTP and the business clock are controlled. */
async function fixture(initialNow = Date.parse("2026-10-02T06:30:00.000Z")) {
  let now = initialNow;
  let override:
    | ((
        request: CapturedLarkRequest,
      ) => { body: unknown; status?: number } | undefined)
    | undefined;
  const directory = mkdtempSync(join(tmpdir(), "task-list-worker-"));
  const server = await larkHttpServer(
    (request) =>
      override?.(request) ?? {
        body: request.path.includes("tenant_access_token")
          ? {
              code: 0,
              tenant_access_token: "synthetic-bot-token",
              expire: 7200,
            }
          : request.method === "GET"
            ? {
                code: 0,
                data: {
                  has_more: false,
                  items: [
                    {
                      message_id: "om_task",
                      chat_id: "oc_source",
                      msg_type: "text",
                      create_time: "1790924100000",
                      update_time: "1790924100000",
                      deleted: false,
                      updated: false,
                      sender: {
                        id: "ou_anthony",
                        id_type: "open_id",
                        sender_type: "user",
                        tenant_key: "tenant_external",
                        sender_name: "Anthony",
                      },
                      body: {
                        content: JSON.stringify({
                          text: "Task list\n1. Review infrastructure",
                        }),
                      },
                    },
                  ],
                },
              }
            : {
                code: 0,
                data: {
                  message_id:
                    typeof request.body === "object" &&
                    request.body !== null &&
                    "receive_id" in request.body &&
                    request.body.receive_id === "oc_management"
                      ? "om_report_ack"
                      : "om_reminder_ack",
                  chat_id:
                    typeof request.body === "object" &&
                    request.body !== null &&
                    "receive_id" in request.body
                      ? request.body.receive_id
                      : "oc_source",
                },
              },
      },
  );
  const options = {
    databasePath: join(directory, "ledger.sqlite"),
    appId: "cli_test",
    sourceChatId: "oc_source",
    destinationChatId: "oc_management",
    activationDate: "2026-10-02",
    reminderText,
    calendar: {
      version: "synthetic-calendar-v1",
      fromDate: "2026-01-01",
      throughDate: "2026-12-31",
      reviewedOn: "2026-10-01",
      sourceUrls: ["https://example.invalid/synthetic-calendar"],
      publicHolidays: [] as readonly string[],
    },
    policy: { policyVersion: "worker-v1", replyPolicy: "exclude" as const },
    reader: {
      appId: "cli_test",
      appSecret: "synthetic-secret",
      sourceChatId: "oc_source",
      httpInstance: server.httpInstance,
      getUserAccessToken: async () => ({
        appId: "cli_test",
        accessToken: "synthetic-user-token",
        expiresAtMs: now + 3600_000,
      }),
    },
    transport: createLarkDeliveryTransport({
      appId: "cli_test",
      appSecret: "synthetic-secret",
      allowedDestinationChatIds: ["oc_source", "oc_management"],
      httpInstance: server.httpInstance,
      clock: () => now,
    }),
    clock: () => now,
  };
  return {
    options,
    server,
    respondWith: (respond: NonNullable<typeof override>) => {
      override = respond;
    },
    setNow: (value: number) => {
      now = value;
    },
    close: async () => {
      await server.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("a delivered report with heading review stays visible in status and warning telemetry", async () => {
  const now = Date.parse("2026-10-02T07:01:00.000Z");
  const environment = await fixture(now);
  environment.respondWith((request) =>
    request.method === "GET"
      ? {
          body: {
            code: 0,
            data: {
              has_more: false,
              items: [
                {
                  message_id: "om_candidate",
                  chat_id: "oc_source",
                  msg_type: "text",
                  create_time: String(now - 60_000),
                  update_time: String(now - 60_000),
                  deleted: false,
                  updated: false,
                  sender: {
                    id: "ou_avery",
                    id_type: "open_id",
                    sender_type: "user",
                    tenant_key: "external",
                    sender_name: "Avery",
                  },
                  body: {
                    content: JSON.stringify({
                      text: "Today's priorities — task list\n1. Prepare drawings",
                    }),
                  },
                },
              ],
            },
          },
        }
      : undefined,
  );
  const logs = logCapture();
  const worker = createDueWorker({
    ...environment.options,
    logger: logs.logger,
  });
  try {
    expect(await worker.runDueWork({ now })).toMatchObject({
      report: { state: "sent", headingReviewCount: 1 },
    });
    expect(worker.getStatus({ now: now + 60_000 })).toMatchObject({
      report: { state: "sent", headingReviewCount: 1 },
    });
    expect(logs.events()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "report_frozen",
          level: "warn",
          entryCount: 0,
          headingReviewCount: 1,
        }),
        expect.objectContaining({
          event: "worker_check_completed",
          level: "warn",
          reviewRequired: true,
          headingReviewCount: 1,
        }),
      ]),
    );
    expect(logs.text()).not.toContain("Avery");
    expect(logs.text()).not.toContain("Prepare drawings");
  } finally {
    worker.close();
    await environment.close();
  }
});

test("a completed report can be followed from history read through acknowledgement using one run ID", async () => {
  const now = Date.parse("2026-10-02T07:01:00.000Z");
  const environment = await fixture(now);
  const logs = logCapture();
  const worker = createDueWorker({
    ...environment.options,
    logger: logs.logger,
    entryPoint: "worker_once",
  });
  try {
    expect(await worker.runDueWork({ now })).toMatchObject({
      report: { state: "sent" },
    });
    expect(logs.events()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "history_read_completed",
          captureKind: "names",
          status: "complete",
          messageCount: 1,
          durationMs: expect.any(Number),
        }),
        expect.objectContaining({
          event: "report_frozen",
          entryCount: 1,
          deliveryId: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
        expect.objectContaining({
          event: "delivery_completed",
          status: "sent",
          attemptCount: 1,
          durationMs: expect.any(Number),
        }),
      ]),
    );
    expect(new Set(logs.events().map((event) => event.runId)).size).toBe(1);
    expect(
      logs.events().every((event) => event.entryPoint === "worker_once"),
    ).toBe(true);
    expect(logs.text()).not.toContain("Anthony");
    expect(logs.text()).not.toContain("Review infrastructure");
    expect(logs.text()).not.toContain("synthetic-secret");
    expect(logs.text()).not.toContain("synthetic-user-token");
    expect(logs.text()).not.toContain("oc_management");
  } finally {
    worker.close();
    await environment.close();
  }
});

test("09:30 sends one frozen source-group reminder without reading submissions", async () => {
  const environment = await fixture();
  const worker = createDueWorker(environment.options);
  const now = Date.parse("2026-10-02T06:30:00.000Z");
  try {
    expect(await worker.runDueWork({ now })).toMatchObject({
      status: "ok",
      businessDate: "2026-10-02",
      reminder: {
        state: "sent",
        messageId: "om_reminder_ack",
        attemptCount: 1,
      },
      report: { state: "not_due" },
    });
    expect(environment.server.requests).toMatchObject([
      { path: "/open-apis/auth/v3/tenant_access_token/internal" },
      {
        method: "POST",
        path: "/open-apis/im/v1/messages",
        query: { receive_id_type: "chat_id" },
        authorization: "Bearer synthetic-bot-token",
        body: {
          receive_id: "oc_source",
          msg_type: "text",
          content: JSON.stringify({ text: reminderText }),
          uuid: expect.any(String),
        },
      },
    ]);
    const before = environment.server.requests.length;
    expect(worker.getStatus({ now })).toMatchObject({
      reminder: { state: "sent" },
    });
    expect(environment.server.requests).toHaveLength(before);
  } finally {
    worker.close();
    await environment.close();
  }
});

test("a failed history read records a safe reason and a warning without being mistaken for an empty report", async () => {
  const now = Date.parse("2026-10-02T07:01:00.000Z");
  const environment = await fixture(now);
  environment.respondWith(() => ({
    status: 400,
    body: { code: 230027, msg: "provider-secret-canary" },
  }));
  const logs = logCapture();
  const worker = createDueWorker({
    ...environment.options,
    logger: logs.logger,
  });
  try {
    expect(await worker.runDueWork({ now })).toMatchObject({
      report: { state: "blocked", reason: "source_access_denied" },
    });
    expect(logs.events()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "history_read_completed",
          status: "unavailable",
          reason: "source_access_denied",
          providerCode: 230027,
          level: "warn",
        }),
        expect.objectContaining({
          event: "worker_check_completed",
          reportState: "blocked",
          reportReason: "source_access_denied",
          level: "warn",
        }),
      ]),
    );
    expect(logs.text()).not.toContain("provider-secret-canary");
  } finally {
    worker.close();
    await environment.close();
  }
});

test("an uncertain Lark send exposes the durable attempt and safe reason for operator review", async () => {
  const now = Date.parse("2026-10-02T07:01:00.000Z");
  const environment = await fixture(now);
  environment.respondWith((request) =>
    request.method === "POST" && request.path === "/open-apis/im/v1/messages"
      ? { body: {}, disconnect: true }
      : undefined,
  );
  const logs = logCapture();
  const worker = createDueWorker({
    ...environment.options,
    logger: logs.logger,
  });
  try {
    expect(await worker.runDueWork({ now })).toMatchObject({
      report: { state: "uncertain", attemptCount: 1 },
    });
    expect(logs.events()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "delivery_completed",
          status: "uncertain",
          reason: "transport_or_acknowledgement_unknown",
          attemptCount: 1,
          level: "warn",
        }),
      ]),
    );
    expect(logs.text()).not.toContain("Review infrastructure");
    expect(logs.text()).not.toContain("synthetic-bot-token");
  } finally {
    worker.close();
    await environment.close();
  }
});

test("a reminder requiring reconciliation marks the worker summary as requiring review", async () => {
  const now = Date.parse("2026-10-02T06:30:00.000Z");
  const environment = await fixture(now);
  const ledger = openReportLedger({
    ...environment.options,
    destinationChatId: environment.options.sourceChatId,
    transport: async () => {
      throw new Error("synthetic-unknown-send");
    },
  });
  try {
    const prepared = ledger.prepareReminder({
      businessDate: "2026-10-02",
      text: reminderText,
      policyVersion: "worker-v1/synthetic-calendar-v1",
    });
    if (prepared.status !== "frozen")
      throw new Error("Invalid reminder fixture");
    await ledger.deliverDelivery({ deliveryId: prepared.delivery.id, now });
  } finally {
    ledger.close();
  }
  const logs = logCapture();
  const worker = createDueWorker({
    ...environment.options,
    logger: logs.logger,
  });
  try {
    expect(await worker.runDueWork({ now })).toMatchObject({
      reminder: { reconciliationRequired: true },
    });
    expect(logs.events()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "worker_check_completed",
          reminderState: "uncertain",
          reviewRequired: true,
          reviewCount: 1,
          level: "warn",
        }),
      ]),
    );
  } finally {
    worker.close();
    await environment.close();
  }
});

test("an unavailable logging sink cannot undo an acknowledged delivery or cause a duplicate send", async () => {
  const now = Date.parse("2026-10-02T07:01:00.000Z");
  const environment = await fixture(now);
  const logger = createOperationalLogger({
    destination: {
      write: () => {
        throw new Error("sink-failure-canary");
      },
    },
  });
  const worker = createDueWorker({ ...environment.options, logger });
  try {
    expect(await worker.runDueWork({ now })).toMatchObject({
      report: { state: "sent", attemptCount: 1 },
    });
    expect(await worker.runDueWork({ now })).toMatchObject({
      report: { state: "sent", attemptCount: 1 },
    });
    expect(
      environment.server.requests.filter(
        (request) =>
          request.method === "POST" &&
          request.path === "/open-apis/im/v1/messages",
      ),
    ).toHaveLength(1);
  } finally {
    worker.close();
    await environment.close();
  }
});

test("unchanged checks stay quiet at info level while retaining a ten-minute liveness heartbeat", async () => {
  const environment = await fixture(Date.parse("2026-10-02T06:00:00Z"));
  const logs = logCapture();
  const worker = createDueWorker({
    ...environment.options,
    logger: logs.logger,
  });
  try {
    for (const time of ["06:00:00", "06:05:00", "06:10:00"]) {
      const now = Date.parse(`2026-10-02T${time}Z`);
      environment.setNow(now);
      await worker.runDueWork({ now });
    }
    const completed = logs
      .events()
      .filter((event) => event.event === "worker_check_completed");
    expect(completed.map((event) => event.level)).toEqual([
      "info",
      "debug",
      "info",
    ]);
    expect(new Set(completed.map((event) => event.runId)).size).toBe(3);
    expect(environment.server.requests).toHaveLength(0);
  } finally {
    worker.close();
    await environment.close();
  }
});

test("the scheduler waits through the 10:00 minute and compiles at 10:01", async () => {
  const environment = await fixture(Date.parse("2026-10-02T07:00:00.000Z"));
  const worker = createDueWorker(environment.options);
  try {
    for (const time of ["07:00:00.000", "07:00:59.999"]) {
      const now = Date.parse(`2026-10-02T${time}Z`);
      environment.setNow(now);
      expect(await worker.runDueWork({ now })).toMatchObject({
        reminder: { state: "skipped" },
        report: { state: "not_due" },
      });
      expect(environment.server.requests).toEqual([]);
    }
    const now = Date.parse("2026-10-02T07:01:00.000Z");
    environment.setNow(now);
    expect(await worker.runDueWork({ now })).toMatchObject({
      report: { state: "sent", attemptCount: 1 },
    });
    expect(
      environment.server.requests.filter((request) => request.method === "GET"),
    ).toHaveLength(1);
  } finally {
    worker.close();
    await environment.close();
  }
});

test("10:01 compiles once and completed work remains completed after restart", async () => {
  const environment = await fixture();
  let worker = createDueWorker(environment.options);
  try {
    await worker.runDueWork({ now: Date.parse("2026-10-02T06:30:00.000Z") });
    worker.close();
    const now = Date.parse("2026-10-02T07:01:00.000Z");
    environment.setNow(now);
    worker = createDueWorker(environment.options);
    expect(await worker.runDueWork({ now })).toMatchObject({
      reminder: { state: "sent", attemptCount: 1 },
      report: { state: "sent", messageId: "om_report_ack", attemptCount: 1 },
    });
    const reportPosts = environment.server.requests.filter(
      (request) =>
        request.method === "POST" &&
        typeof request.body === "object" &&
        request.body !== null &&
        "receive_id" in request.body &&
        request.body.receive_id === "oc_management",
    );
    expect(reportPosts).toMatchObject([
      {
        body: {
          content: JSON.stringify({ text: "2 October 2026\n1. Anthony" }),
        },
      },
    ]);
    const before = [...environment.server.requests];
    worker.close();
    worker = createDueWorker(environment.options);
    await worker.runDueWork({ now });
    expect(environment.server.requests).toEqual(before);
  } finally {
    worker.close();
    await environment.close();
  }
});

test("the reminder window is 09:30 inclusive to 10:00 exclusive", async () => {
  const environment = await fixture(Date.parse("2026-10-02T06:29:59.999Z"));
  const worker = createDueWorker(environment.options);
  try {
    expect(
      await worker.runDueWork({ now: Date.parse("2026-10-02T06:29:59.999Z") }),
    ).toMatchObject({
      reminder: { state: "not_due" },
      report: { state: "not_due" },
    });
    expect(environment.server.requests).toEqual([]);
    const now = Date.parse("2026-10-02T07:00:00.000Z");
    environment.setNow(now);
    expect(await worker.runDueWork({ now })).toMatchObject({
      reminder: { state: "skipped" },
      report: { state: "not_due" },
    });
    expect(
      environment.server.requests.filter(
        (request) =>
          request.method === "POST" &&
          typeof request.body === "object" &&
          request.body !== null &&
          "receive_id" in request.body &&
          request.body.receive_id === "oc_source",
      ),
    ).toEqual([]);
  } finally {
    worker.close();
    await environment.close();
  }
});

test("weekends and supplied Kenyan holidays suppress both routes without a history read", async () => {
  const environment = await fixture(Date.parse("2026-10-03T07:01:00.000Z"));
  environment.options.calendar.publicHolidays = ["2026-10-05"];
  const worker = createDueWorker(environment.options);
  try {
    for (const instant of [
      "2026-10-03T07:01:00.000Z",
      "2026-10-04T07:01:00.000Z",
      "2026-10-05T07:01:00.000Z",
    ]) {
      const now = Date.parse(instant);
      environment.setNow(now);
      expect(await worker.runDueWork({ now })).toMatchObject({
        reminder: { state: "skipped", reason: "not_working_day" },
        report: { state: "skipped", reason: "not_working_day" },
      });
    }
    expect(environment.server.requests).toEqual([]);
  } finally {
    worker.close();
    await environment.close();
  }
});

test("activation prevents work before the explicitly configured first business date", async () => {
  const environment = await fixture();
  environment.options.activationDate = "2026-10-05";
  const worker = createDueWorker(environment.options);
  try {
    expect(
      await worker.runDueWork({ now: Date.parse("2026-10-02T06:30:00.000Z") }),
    ).toMatchObject({
      reminder: { state: "skipped", reason: "before_activation" },
      report: { state: "skipped", reason: "before_activation" },
    });
    expect(environment.server.requests).toEqual([]);
  } finally {
    worker.close();
    await environment.close();
  }
});

test("restore mode exposes paused work without reading or sending", async () => {
  const environment = await fixture(Date.parse("2026-10-02T07:01:00.000Z"));
  const worker = createDueWorker({ ...environment.options, restoreMode: true });
  try {
    expect(
      await worker.runDueWork({ now: Date.parse("2026-10-02T07:01:00.000Z") }),
    ).toMatchObject({ status: "paused", reason: "restore_review_required" });
    expect(environment.server.requests).toEqual([]);
  } finally {
    worker.close();
    await environment.close();
  }
});

test("unreviewed or uncovered calendar data blocks due work visibly", async () => {
  const environment = await fixture();
  const calendars = [
    { ...environment.options.calendar, version: "" },
    { ...environment.options.calendar, sourceUrls: [] },
    { ...environment.options.calendar, reviewedOn: "2026-10-03" },
    { ...environment.options.calendar, publicHolidays: ["2026-02-30"] },
    { ...environment.options.calendar, throughDate: "2026-10-01" },
  ];
  try {
    for (const calendar of calendars) {
      const worker = createDueWorker({ ...environment.options, calendar });
      try {
        expect(
          await worker.runDueWork({
            now: Date.parse("2026-10-02T06:30:00.000Z"),
          }),
        ).toMatchObject({ status: "blocked", reason: "invalid_calendar" });
      } finally {
        worker.close();
      }
    }
    expect(environment.server.requests).toEqual([]);
  } finally {
    await environment.close();
  }
});

test("invalid worker clocks or scope cannot start either route", async () => {
  const environment = await fixture();
  try {
    for (const options of [
      { ...environment.options, activationDate: "2026-02-30" },
      {
        ...environment.options,
        reader: { ...environment.options.reader, appId: "cli_other" },
      },
      {
        ...environment.options,
        policy: { ...environment.options.policy, policyVersion: "" },
      },
      { ...environment.options, reminderText: " " },
    ]) {
      const worker = createDueWorker(options);
      try {
        expect(
          await worker.runDueWork({
            now: Date.parse("2026-10-02T06:30:00.000Z"),
          }),
        ).toMatchObject({
          status: "blocked",
          reason: "invalid_worker_configuration",
        });
      } finally {
        worker.close();
      }
    }
    const worker = createDueWorker(environment.options);
    try {
      expect(await worker.runDueWork({ now: Number.NaN })).toMatchObject({
        status: "blocked",
        reason: "invalid_clock",
      });
    } finally {
      worker.close();
    }
    expect(environment.server.requests).toEqual([]);
  } finally {
    await environment.close();
  }
});

test("older missed working dates are surfaced for review instead of bulk read or delivery", async () => {
  const now = Date.parse("2026-10-06T07:01:00.000Z");
  const environment = await fixture(now);
  environment.options.activationDate = "2026-10-01";
  environment.options.calendar.publicHolidays = ["2026-10-05"];
  const worker = createDueWorker(environment.options);
  try {
    expect(worker.getStatus({ now })).toMatchObject({
      backfill: {
        dates: ["2026-10-01", "2026-10-02"],
        total: 2,
        truncated: false,
      },
    });
    expect(environment.server.requests).toEqual([]);
    expect(await worker.runDueWork({ now })).toMatchObject({
      report: { state: "sent" },
      backfill: { dates: ["2026-10-01", "2026-10-02"] },
    });
    expect(
      environment.server.requests.filter((request) => request.method === "GET"),
    ).toHaveLength(1);
    expect(
      environment.server.requests.filter(
        (request) =>
          request.path === "/open-apis/im/v1/messages" &&
          request.method === "POST",
      ),
    ).toMatchObject([
      {
        body: {
          content: JSON.stringify({
            text: "6 October 2026\nNo valid submissions found by the approved cutoff",
          }),
        },
      },
    ]);
  } finally {
    worker.close();
    await environment.close();
  }
});

test("a rejected reminder retries its frozen text and UUID after restart only when backoff is due", async () => {
  const environment = await fixture();
  environment.respondWith((request) =>
    request.method === "POST" && request.path === "/open-apis/im/v1/messages"
      ? { body: { code: 230020 } }
      : undefined,
  );
  let worker = createDueWorker(environment.options);
  const first = Date.parse("2026-10-02T06:30:00.000Z");
  try {
    expect(await worker.runDueWork({ now: first })).toMatchObject({
      reminder: { state: "retryable", attemptCount: 1 },
    });
    const original = environment.server.requests.find(
      (request) =>
        request.path === "/open-apis/im/v1/messages" &&
        request.method === "POST",
    )?.body;
    worker.close();
    worker = createDueWorker({
      ...environment.options,
      reminderText: "Changed wording must not replace a frozen reminder.",
    });
    environment.respondWith(() => undefined);
    environment.setNow(first + 29_999);
    await worker.runDueWork({ now: first + 29_999 });
    expect(
      environment.server.requests.filter(
        (request) =>
          request.path === "/open-apis/im/v1/messages" &&
          request.method === "POST",
      ),
    ).toHaveLength(1);
    environment.setNow(first + 30_000);
    expect(await worker.runDueWork({ now: first + 30_000 })).toMatchObject({
      reminder: { state: "sent", attemptCount: 2 },
    });
    expect(
      environment.server.requests
        .filter(
          (request) =>
            request.path === "/open-apis/im/v1/messages" &&
            request.method === "POST",
        )
        .map((request) => request.body),
    ).toEqual([original, original]);
  } finally {
    worker.close();
    await environment.close();
  }
});

test("a frozen report retries after restart without another compilation read", async () => {
  const first = Date.parse("2026-10-02T07:01:00.000Z");
  const environment = await fixture(first);
  environment.respondWith((request) =>
    request.method === "POST" && request.path === "/open-apis/im/v1/messages"
      ? { body: { code: 230020 } }
      : undefined,
  );
  let worker = createDueWorker(environment.options);
  try {
    expect(await worker.runDueWork({ now: first })).toMatchObject({
      report: { state: "retryable", attemptCount: 1 },
    });
    const original = environment.server.requests.find(
      (request) =>
        request.path === "/open-apis/im/v1/messages" &&
        request.method === "POST",
    )?.body;
    worker.close();
    worker = createDueWorker(environment.options);
    environment.respondWith(() => undefined);
    environment.setNow(first + 30_000);
    expect(await worker.runDueWork({ now: first + 30_000 })).toMatchObject({
      report: { state: "sent", attemptCount: 2 },
    });
    expect(
      environment.server.requests.filter((request) => request.method === "GET"),
    ).toHaveLength(1);
    expect(
      environment.server.requests
        .filter(
          (request) =>
            request.path === "/open-apis/im/v1/messages" &&
            request.method === "POST",
        )
        .map((request) => request.body),
    ).toEqual([original, original]);
  } finally {
    worker.close();
    await environment.close();
  }
});

test("incomplete history is visible as blocked work and a later complete read can recover", async () => {
  const first = Date.parse("2026-10-02T07:01:00.000Z");
  const environment = await fixture(first);
  environment.respondWith((request) =>
    request.method === "GET" ? { body: { code: 230020 } } : undefined,
  );
  const worker = createDueWorker(environment.options);
  try {
    expect(await worker.runDueWork({ now: first })).toMatchObject({
      report: { state: "blocked", reason: "page_unavailable" },
    });
    expect(worker.getStatus({ now: first })).toMatchObject({
      report: { state: "blocked", reason: "page_unavailable" },
    });
    expect(
      environment.server.requests.filter(
        (request) => request.method === "POST",
      ),
    ).toEqual([]);
    environment.respondWith(() => undefined);
    environment.setNow(first + 60_000);
    expect(await worker.runDueWork({ now: first + 60_000 })).toMatchObject({
      report: { state: "sent" },
    });
  } finally {
    worker.close();
    await environment.close();
  }
});

test("credential delay past the reminder deadline cannot suppress the report due at 10:01", async () => {
  const first = Date.parse("2026-10-02T06:59:59.999Z");
  const environment = await fixture(first);
  environment.respondWith((request) => {
    if (request.path.includes("tenant_access_token"))
      environment.setNow(Date.parse("2026-10-02T07:01:00.000Z"));
    return undefined;
  });
  const worker = createDueWorker(environment.options);
  try {
    expect(await worker.runDueWork({ now: first })).toMatchObject({
      reminder: { state: "failed", lastError: "delivery_window_expired" },
      report: { state: "sent" },
    });
    expect(
      environment.server.requests.filter(
        (request) =>
          request.path === "/open-apis/im/v1/messages" &&
          request.method === "POST",
      ),
    ).toMatchObject([{ body: { receive_id: "oc_management" } }]);
  } finally {
    worker.close();
    await environment.close();
  }
});

test("overlapping due checks in one worker share a compilation and delivery", async () => {
  const now = Date.parse("2026-10-02T07:01:00.000Z");
  const environment = await fixture(now);
  const worker = createDueWorker(environment.options);
  try {
    const results = await Promise.all([
      worker.runDueWork({ now }),
      worker.runDueWork({ now }),
    ]);
    expect(results).toMatchObject([
      { report: { state: "sent" } },
      { report: { state: "sent" } },
    ]);
    expect(
      environment.server.requests.filter((request) => request.method === "GET"),
    ).toHaveLength(1);
    expect(
      environment.server.requests.filter(
        (request) =>
          request.method === "POST" &&
          request.path === "/open-apis/im/v1/messages",
      ),
    ).toHaveLength(1);
  } finally {
    worker.close();
    await environment.close();
  }
});

test("a history read crossing Nairobi midnight leaves yesterday's report for reviewed backfill", async () => {
  const first = Date.parse("2026-10-02T20:59:59.999Z");
  const environment = await fixture(first);
  environment.respondWith((request) => {
    if (request.method === "GET")
      environment.setNow(Date.parse("2026-10-02T21:00:00.000Z"));
    return undefined;
  });
  const worker = createDueWorker(environment.options);
  try {
    expect(await worker.runDueWork({ now: first })).toMatchObject({
      businessDate: "2026-10-03",
      report: { state: "skipped" },
      backfill: { dates: ["2026-10-02"] },
    });
    expect(
      environment.server.requests.filter(
        (request) => request.method === "POST",
      ),
    ).toEqual([]);
  } finally {
    worker.close();
    await environment.close();
  }
});

test("report credential retrieval crossing midnight cannot post an older report automatically", async () => {
  const first = Date.parse("2026-10-02T20:59:59.999Z");
  const environment = await fixture(first);
  environment.respondWith((request) => {
    if (request.path.includes("tenant_access_token"))
      environment.setNow(Date.parse("2026-10-02T21:00:00.000Z"));
    return undefined;
  });
  const worker = createDueWorker(environment.options);
  try {
    expect(await worker.runDueWork({ now: first })).toMatchObject({
      businessDate: "2026-10-03",
      backfill: { dates: ["2026-10-02"] },
    });
    expect(
      environment.server.requests.filter(
        (request) =>
          request.path === "/open-apis/im/v1/messages" &&
          request.method === "POST",
      ),
    ).toEqual([]);
  } finally {
    worker.close();
    await environment.close();
  }
});

test("uncertain reports reuse the UUID within its window then require review", async () => {
  const first = Date.parse("2026-10-02T07:01:00.000Z");
  const environment = await fixture(first);
  environment.respondWith((request) =>
    request.method === "POST" && request.path === "/open-apis/im/v1/messages"
      ? { body: { code: 230050 } }
      : undefined,
  );
  const worker = createDueWorker(environment.options);
  try {
    expect(await worker.runDueWork({ now: first })).toMatchObject({
      report: {
        state: "uncertain",
        attemptCount: 1,
        reconciliationRequired: false,
      },
    });
    environment.setNow(first + 30_000);
    expect(await worker.runDueWork({ now: first + 30_000 })).toMatchObject({
      report: { state: "uncertain", attemptCount: 2, firstAttemptMs: first },
    });
    const posts = environment.server.requests.filter(
      (request) =>
        request.method === "POST" &&
        request.path === "/open-apis/im/v1/messages",
    );
    expect(posts.map((request) => request.body)).toEqual([
      posts[0]?.body,
      posts[0]?.body,
    ]);
    const before = [...environment.server.requests];
    environment.setNow(first + 55 * 60_000);
    expect(await worker.runDueWork({ now: first + 55 * 60_000 })).toMatchObject(
      { report: { state: "uncertain", reconciliationRequired: true } },
    );
    expect(environment.server.requests).toEqual(before);
  } finally {
    worker.close();
    await environment.close();
  }
});

test("an older uncertain reminder remains visible for review and is never replayed", async () => {
  const first = Date.parse("2026-10-02T06:59:40.000Z");
  const environment = await fixture(first);
  environment.respondWith((request) =>
    request.method === "POST" && request.path === "/open-apis/im/v1/messages"
      ? { body: { code: 230050 } }
      : undefined,
  );
  let worker = createDueWorker(environment.options);
  try {
    await worker.runDueWork({ now: first });
    const before = [...environment.server.requests];
    worker.close();
    worker = createDueWorker(environment.options);
    const now = Date.parse("2026-10-05T06:00:00.000Z");
    environment.setNow(now);
    expect(await worker.runDueWork({ now })).toMatchObject({
      reminderReviews: {
        items: [
          {
            businessDate: "2026-10-02",
            state: "uncertain",
            eligible: false,
            reconciliationRequired: true,
          },
        ],
        total: 1,
      },
    });
    expect(environment.server.requests).toEqual(before);
  } finally {
    worker.close();
    await environment.close();
  }
});

test("a saved pending report uses the current clock after reminder credentials cross 10:01", async () => {
  const environment = await fixture(Date.parse("2026-10-02T07:01:00.000Z"));
  const { transport: _unusedTransport, ...previewOptions } =
    environment.options;
  const preview = createDueWorker(previewOptions);
  await preview.runDueWork({ now: Date.parse("2026-10-02T07:01:00.000Z") });
  preview.close();
  const first = Date.parse("2026-10-02T06:59:59.999Z");
  environment.setNow(first);
  environment.respondWith((request) => {
    if (request.path.includes("tenant_access_token"))
      environment.setNow(Date.parse("2026-10-02T07:01:00.000Z"));
    return undefined;
  });
  const worker = createDueWorker(environment.options);
  try {
    expect(await worker.runDueWork({ now: first })).toMatchObject({
      report: { state: "sent", attemptCount: 1 },
    });
    expect(
      environment.server.requests.filter((request) => request.method === "GET"),
    ).toHaveLength(1);
  } finally {
    worker.close();
    await environment.close();
  }
});

test("a failed read crossing midnight returns current-date status and reviewed backfill", async () => {
  const first = Date.parse("2026-10-02T20:59:59.999Z");
  const environment = await fixture(first);
  environment.respondWith((request) => {
    if (request.method !== "GET") return undefined;
    environment.setNow(Date.parse("2026-10-02T21:00:00.000Z"));
    return { body: { code: 230020 } };
  });
  const worker = createDueWorker(environment.options);
  try {
    expect(await worker.runDueWork({ now: first })).toMatchObject({
      businessDate: "2026-10-03",
      backfill: { dates: ["2026-10-02"] },
    });
    expect(
      environment.server.requests.filter(
        (request) => request.method === "POST",
      ),
    ).toEqual([]);
  } finally {
    worker.close();
    await environment.close();
  }
});

test("a calendar revision cannot hide an older unfinished delivery from reviewed backfill", async () => {
  const first = Date.parse("2026-10-02T07:01:00.000Z");
  const environment = await fixture(first);
  environment.respondWith((request) =>
    request.method === "POST" && request.path === "/open-apis/im/v1/messages"
      ? { body: { code: 230050 } }
      : undefined,
  );
  let worker = createDueWorker(environment.options);
  try {
    await worker.runDueWork({ now: first });
    const before = [...environment.server.requests];
    worker.close();
    const now = Date.parse("2026-10-05T06:00:00.000Z");
    environment.setNow(now);
    worker = createDueWorker({
      ...environment.options,
      calendar: {
        ...environment.options.calendar,
        version: "synthetic-calendar-v2",
        publicHolidays: ["2026-10-02"],
      },
    });
    expect(await worker.runDueWork({ now })).toMatchObject({
      backfill: {
        dates: ["2026-10-02"],
        items: [
          {
            businessDate: "2026-10-02",
            state: "uncertain",
            deliveryId: expect.any(String),
          },
        ],
      },
    });
    expect(environment.server.requests).toEqual(before);
  } finally {
    worker.close();
    await environment.close();
  }
});
