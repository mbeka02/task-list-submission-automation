import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createLarkWebhookTransport } from "../../src/lark-webhook.js";
import { createOperationalLogger } from "../../src/observability.js";
import {
  type DeliveryTransport,
  openReportLedger,
} from "../../src/report-ledger.js";
import { webhookHttpServer } from "../support/webhook-http-server.js";

const now = 1790838060000;
const configuration = {
  appId: "cli_test",
  destinationChatId: "oc_private_reports",
  webhookUrl:
    "https://open.larksuite.com/open-apis/bot/v2/hook/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
  signingSecret: "synthetic-signing-secret",
  clock: () => now,
};

/** Exercise frozen reporting and recovery through S4, using a temporary real SQLite ledger. */
function frozenLedger(
  transport: DeliveryTransport,
  logger?: ReturnType<typeof createOperationalLogger>,
) {
  const directory = mkdtempSync(join(tmpdir(), "task-list-webhook-"));
  const options = {
    appId: "cli_test",
    sourceChatId: "oc_source",
    destinationChatId: configuration.destinationChatId,
    databasePath: join(directory, "ledger.sqlite"),
    clock: () => now,
    ...(logger ? { logger } : {}),
  };
  let ledger = openReportLedger({ ...options, transport });
  const result = ledger.prepareDailyReport({
    businessDate: "2026-10-01",
    policy: {
      appId: options.appId,
      sourceChatId: options.sourceChatId,
      timeZone: "Africa/Nairobi",
      publicHolidays: [],
      replyPolicy: "exclude",
      policyVersion: "webhook-test-v1",
    },
    scan: {
      status: "complete",
      appId: options.appId,
      sourceChatId: options.sourceChatId,
      businessDate: "2026-10-01",
      observedAtMs: now,
      fromMs: 1790802000000,
      throughMs: now,
      replyPolicy: "exclude",
      messages: [],
    },
  });
  if (result.status !== "frozen") throw new Error("Expected frozen report");
  return {
    get ledger() {
      return ledger;
    },
    options,
    id: result.delivery.id,
    reopen: (next: DeliveryTransport) => {
      ledger.close();
      ledger = openReportLedger({ ...options, transport: next });
    },
    close: () => {
      ledger.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("a successful signed webhook records acceptance without inventing a Lark message ID", async () => {
  const server = await webhookHttpServer(() => ({
    body: { code: 0, msg: "success", data: {} },
  }));
  const fixture = frozenLedger(createLarkWebhookTransport(configuration));
  try {
    expect(
      await fixture.ledger.deliverDelivery({ deliveryId: fixture.id, now }),
    ).toMatchObject({ status: "sent" });
    expect(fixture.ledger.getDelivery(fixture.id)).toMatchObject({
      state: "sent",
      messageId: null,
      adapterKind: "lark_webhook",
      acknowledgedMs: now,
      attemptCount: 1,
    });
    expect(server.requests).toHaveLength(1);
    // Fixed vector independently calculated from the official HMAC procedure.
    expect(server.requests[0]).toMatchObject({
      method: "POST",
      body: {
        timestamp: "1790838060",
        sign: "88lYy+pXOcPVCaTklli1NaFp3XB87doFNmul0Bi54nA=",
        msg_type: "text",
        content: {
          text: "1 October 2026\nNo valid submissions found by the approved cutoff",
        },
      },
    });
    expect(JSON.stringify(server.requests[0]?.body)).not.toContain(
      configuration.signingSecret,
    );
  } finally {
    fixture.close();
    await server.close();
  }
});

test("a reviewed retry cannot silently switch its webhook endpoint after restart", async () => {
  let code = 19021;
  const server = await webhookHttpServer(() => ({
    body: { code, msg: "synthetic response" },
  }));
  const fixture = frozenLedger(createLarkWebhookTransport(configuration));
  try {
    expect(
      await fixture.ledger.deliverDelivery({ deliveryId: fixture.id, now }),
    ).toMatchObject({ status: "failed" });
    expect(fixture.ledger.getDelivery(fixture.id)).toMatchObject({
      transportBinding: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(
      fixture.ledger.reconcileDelivery({
        deliveryId: fixture.id,
        expectedAttempt: 1,
        decision: "not-sent",
        operator: "test reviewer",
        reason: "Fixture confirms the signing rejection",
        now: now + 1000,
      }),
    ).toMatchObject({ status: "reconciled" });
    code = 0;
    fixture.reopen(
      createLarkWebhookTransport({
        ...configuration,
        webhookUrl: configuration.webhookUrl.replace("aaaaaaaa", "bbbbbbbb"),
      }),
    );
    expect(
      await fixture.ledger.deliverDelivery({
        deliveryId: fixture.id,
        now: now + 60000,
      }),
    ).toMatchObject({
      status: "not_sent",
      reason: "transport_binding_changed",
    });
    expect(server.requests).toHaveLength(1);
  } finally {
    fixture.close();
    await server.close();
  }
});

test.each([19021, 19022, 19024, 9499])(
  "documented webhook rejection %s is a definite failure",
  async (code) => {
    const server = await webhookHttpServer(() => ({
      body: { code, msg: "synthetic rejection" },
    }));
    const fixture = frozenLedger(createLarkWebhookTransport(configuration));
    try {
      expect(
        await fixture.ledger.deliverDelivery({ deliveryId: fixture.id, now }),
      ).toMatchObject({ status: "failed" });
      expect(fixture.ledger.getDelivery(fixture.id)).toMatchObject({
        state: "failed",
        lastError: "destination_denied",
        messageId: null,
      });
      expect(server.requests).toHaveLength(1);
    } finally {
      fixture.close();
      await server.close();
    }
  },
);

test("a documented webhook rate limit retries the frozen report only when due", async () => {
  let code = 11232;
  const server = await webhookHttpServer(() => ({
    body: { code, msg: "synthetic response" },
  }));
  const fixture = frozenLedger(createLarkWebhookTransport(configuration));
  try {
    expect(
      await fixture.ledger.deliverDelivery({ deliveryId: fixture.id, now }),
    ).toMatchObject({ status: "retryable" });
    expect(
      await fixture.ledger.deliverDelivery({
        deliveryId: fixture.id,
        now: now + 1000,
      }),
    ).toMatchObject({ status: "not_sent", reason: "retry_not_due" });
    expect(server.requests).toHaveLength(1);
    code = 0;
    fixture.reopen(createLarkWebhookTransport(configuration));
    expect(
      await fixture.ledger.deliverDelivery({
        deliveryId: fixture.id,
        now: now + 60000,
      }),
    ).toMatchObject({ status: "sent" });
    expect(server.requests).toHaveLength(2);
    expect(server.requests[1]?.body).toEqual(server.requests[0]?.body);
  } finally {
    fixture.close();
    await server.close();
  }
});

test("a lost webhook receipt survives restart and requires review without replay", async () => {
  const server = await webhookHttpServer(() => ({ disconnect: true }));
  const fixture = frozenLedger(createLarkWebhookTransport(configuration));
  try {
    expect(
      await fixture.ledger.deliverDelivery({ deliveryId: fixture.id, now }),
    ).toMatchObject({ status: "uncertain" });
    fixture.reopen(createLarkWebhookTransport(configuration));
    expect(
      await fixture.ledger.deliverDelivery({
        deliveryId: fixture.id,
        now: now + 60000,
      }),
    ).toMatchObject({ status: "not_sent", reason: "reconciliation_required" });
    expect(server.requests).toHaveLength(1);
    expect(
      fixture.ledger.reconcileDelivery({
        deliveryId: fixture.id,
        expectedAttempt: 1,
        decision: "sent",
        operator: "test reviewer",
        reason: "The recipient verified this exact frozen message in the group",
        now: now + 60000,
      }),
    ).toMatchObject({ status: "reconciled" });
    expect(fixture.ledger.getDelivery(fixture.id)).toMatchObject({
      state: "sent",
      messageId: null,
    });
  } finally {
    fixture.close();
    await server.close();
  }
});

test("a reminder whose delivery window expires before POST is not sent", async () => {
  const server = await webhookHttpServer(() => ({ body: { code: 0 } }));
  try {
    const transport = createLarkWebhookTransport(configuration);
    expect(
      await transport({
        appId: configuration.appId,
        destinationChatId: configuration.destinationChatId,
        uuid: "synthetic",
        text: "Synthetic reminder",
        deliveryDeadlineMs: now,
      }),
    ).toEqual({ status: "failed", reason: "delivery_window_expired" });
    expect(server.requests).toHaveLength(0);
  } finally {
    await server.close();
  }
});

test("oversized UTF-8 webhook payloads are rejected before networking", async () => {
  const server = await webhookHttpServer(() => ({ body: { code: 0 } }));
  try {
    const transport = createLarkWebhookTransport(configuration);
    expect(
      await transport({
        appId: configuration.appId,
        destinationChatId: configuration.destinationChatId,
        uuid: "synthetic",
        text: "界".repeat(7000),
      }),
    ).toEqual({ status: "failed", reason: "message_too_large" });
    expect(server.requests).toHaveLength(0);
  } finally {
    await server.close();
  }
});

test.each([
  { body: { code: "19021" } },
  { body: { StatusCode: 0, StatusMessage: "success" } },
  { body: { code: 0 }, status: 500 },
  { rawBody: '{"code":0' },
  { rawBody: JSON.stringify({ code: 0, unexpected: "x".repeat(70000) }) },
  { status: 302, headers: { location: "https://example.invalid/secret" } },
])(
  "unrecognized or unbounded receipts require review (case %#)",
  async (response) => {
    const server = await webhookHttpServer(() => response);
    const fixture = frozenLedger(createLarkWebhookTransport(configuration));
    try {
      expect(
        await fixture.ledger.deliverDelivery({ deliveryId: fixture.id, now }),
      ).toMatchObject({ status: "uncertain" });
      expect(server.requests).toHaveLength(1);
    } finally {
      fixture.close();
      await server.close();
    }
  },
);

test("invalid webhook settings cannot route frozen task content to another host", () => {
  for (const webhookUrl of [
    "http://open.larksuite.com/open-apis/bot/v2/hook/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
    "https://example.invalid/open-apis/bot/v2/hook/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
    `${configuration.webhookUrl}?redirect=elsewhere`,
    "https://open.larksuite.com/open-apis/im/v1/messages",
    "https://secret@example.invalid/hook",
  ])
    expect(() =>
      createLarkWebhookTransport({ ...configuration, webhookUrl }),
    ).toThrow("invalid_webhook_configuration");
  expect(() =>
    createLarkWebhookTransport({ ...configuration, signingSecret: "" }),
  ).toThrow("invalid_webhook_configuration");
});

test("webhook failures identify the adapter in correlated telemetry without exposing its endpoint", async () => {
  const lines: Record<string, unknown>[] = [];
  const logger = createOperationalLogger({
    level: "debug",
    destination: {
      write: (line) => {
        lines.push(JSON.parse(line));
      },
    },
  });
  const server = await webhookHttpServer(() => ({ body: { code: 11232 } }));
  const fixture = frozenLedger(
    createLarkWebhookTransport(configuration),
    logger,
  );
  try {
    await fixture.ledger.deliverDelivery({ deliveryId: fixture.id, now });
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "delivery_completed",
          entryPoint: "delivery_api",
          runId: expect.any(String),
          adapterKind: "lark_webhook",
          status: "retryable",
          reason: "rate_limited",
          attemptCount: 1,
          durationMs: expect.any(Number),
        }),
      ]),
    );
    expect(JSON.stringify(lines)).not.toContain(configuration.webhookUrl);
    expect(JSON.stringify(lines)).not.toContain(configuration.signingSecret);
  } finally {
    fixture.close();
    await server.close();
  }
});
