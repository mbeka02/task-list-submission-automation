import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createLarkDeliveryTransport } from "../../src/lark-delivery.js";
import { openReportLedger } from "../../src/report-ledger.js";
import { larkHttpServer } from "../support/lark-http-server.js";

const now = 1790838060000;
const config = {
  appId: "cli_test",
  sourceChatId: "oc_source",
  destinationChatId: "oc_destination",
};
const uuid = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

function frozenLedger(
  transport: ReturnType<typeof createLarkDeliveryTransport>,
  clock = () => now,
) {
  const directory = mkdtempSync(join(tmpdir(), "task-list-delivery-"));
  const ledger = openReportLedger({
    ...config,
    databasePath: join(directory, "ledger.sqlite"),
    clock,
    transport,
    newSendUuid: () => uuid,
  });
  const prepared = ledger.prepareDailyReport({
    businessDate: "2026-10-01",
    policy: {
      appId: "cli_test",
      sourceChatId: "oc_source",
      timeZone: "Africa/Nairobi",
      publicHolidays: [],
      replyPolicy: "exclude",
      policyVersion: "contract-v1",
    },
    scan: {
      status: "complete",
      appId: "cli_test",
      sourceChatId: "oc_source",
      businessDate: "2026-10-01",
      observedAtMs: now,
      fromMs: 1790802000000,
      throughMs: 1790838000000,
      replyPolicy: "exclude",
      messages: [],
    },
  });
  if (prepared.status !== "frozen") throw new Error("Expected frozen report");
  return {
    ledger,
    id: prepared.delivery.id,
    close: () => {
      ledger.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

const tokenBody = {
  code: 0,
  tenant_access_token: "t-synthetic-bot",
  expire: 7200,
};
const ackBody = {
  code: 0,
  data: {
    message_id: "om_sdk_ack",
    chat_id: "oc_destination",
    msg_type: "text",
  },
};
function transport(
  server: Awaited<ReturnType<typeof larkHttpServer>>,
  clock = () => now,
) {
  return createLarkDeliveryTransport({
    appId: "cli_test",
    appSecret: "synthetic-secret",
    allowedDestinationChatIds: ["oc_destination"],
    httpInstance: server.httpInstance,
    clock,
  });
}

test("S4 sends the frozen text and UUID as the approved app bot through the real SDK", async () => {
  const server = await larkHttpServer((request) => ({
    body: request.path.includes("tenant_access_token") ? tokenBody : ackBody,
  }));
  const fixture = frozenLedger(transport(server));
  try {
    expect(
      await fixture.ledger.deliverDelivery({ deliveryId: fixture.id, now }),
    ).toMatchObject({ status: "sent" });
    expect(server.origins).toEqual([
      "https://open.larksuite.com",
      "https://open.larksuite.com",
    ]);
    expect(server.requests).toMatchObject([
      {
        method: "POST",
        path: "/open-apis/auth/v3/tenant_access_token/internal",
        body: { app_id: "cli_test", app_secret: "synthetic-secret" },
      },
      {
        method: "POST",
        path: "/open-apis/im/v1/messages",
        query: { receive_id_type: "chat_id" },
        authorization: "Bearer t-synthetic-bot",
        body: {
          receive_id: "oc_destination",
          msg_type: "text",
          content:
            '{"text":"1 October 2026\\nNo valid submissions found by the approved cutoff"}',
          uuid,
        },
      },
    ]);
    expect(fixture.ledger.getDelivery(fixture.id)).toMatchObject({
      state: "sent",
      messageId: "om_sdk_ack",
      attemptCount: 1,
    });
  } finally {
    fixture.close();
    await server.close();
  }
});

test.each(["app", "destination"])(
  "S4 rejects an unapproved %s before obtaining credentials or sending",
  async (scope) => {
    const server = await larkHttpServer((request) => ({
      body: request.path.includes("tenant_access_token") ? tokenBody : ackBody,
    }));
    const adapter = createLarkDeliveryTransport({
      appId: scope === "app" ? "cli_other" : "cli_test",
      appSecret: "synthetic-secret",
      allowedDestinationChatIds:
        scope === "destination" ? ["oc_other"] : ["oc_destination"],
      httpInstance: server.httpInstance,
    });
    const fixture = frozenLedger(adapter);
    try {
      expect(
        await fixture.ledger.deliverDelivery({ deliveryId: fixture.id, now }),
      ).toMatchObject({ status: "failed" });
      expect(fixture.ledger.getDelivery(fixture.id)).toMatchObject({
        lastError: "outbound_scope_mismatch",
        state: "failed",
      });
      expect(server.requests).toEqual([]);
    } finally {
      fixture.close();
      await server.close();
    }
  },
);

test.each([
  { code: 230020, status: 400 },
  { code: 99991400, status: 429 },
])(
  "a documented rate-limit rejection ($code) is safely retryable with the same SDK payload",
  async ({ code, status }) => {
    let reject = true;
    const server = await larkHttpServer((request) =>
      request.path.includes("tenant_access_token")
        ? { body: tokenBody }
        : reject
          ? { status, body: { code, msg: "synthetic-secret-do-not-save" } }
          : { body: ackBody },
    );
    let clock = now;
    const fixture = frozenLedger(
      transport(server, () => clock),
      () => clock,
    );
    try {
      expect(
        await fixture.ledger.deliverDelivery({ deliveryId: fixture.id, now }),
      ).toMatchObject({ status: "retryable" });
      expect(fixture.ledger.getDelivery(fixture.id)).toMatchObject({
        state: "retryable",
        lastError: "rate_limited",
        nextAttemptMs: now + 30_000,
      });
      reject = false;
      clock += 30_000;
      expect(
        await fixture.ledger.deliverDelivery({
          deliveryId: fixture.id,
          now: clock,
        }),
      ).toMatchObject({ status: "sent" });
      const sent = server.requests.filter(
        (request) => request.path === "/open-apis/im/v1/messages",
      );
      expect(sent.map((request) => request.body)).toEqual([
        {
          receive_id: "oc_destination",
          msg_type: "text",
          content:
            '{"text":"1 October 2026\\nNo valid submissions found by the approved cutoff"}',
          uuid,
        },
        {
          receive_id: "oc_destination",
          msg_type: "text",
          content:
            '{"text":"1 October 2026\\nNo valid submissions found by the approved cutoff"}',
          uuid,
        },
      ]);
      expect(
        JSON.stringify(fixture.ledger.getDelivery(fixture.id)),
      ).not.toContain("synthetic-secret-do-not-save");
    } finally {
      fixture.close();
      await server.close();
    }
  },
);

test.each([230002, 230006, 230018, 230027, 230034, 230035, 232009])(
  "a documented destination/bot rejection %s is terminal and visible",
  async (code) => {
    const server = await larkHttpServer((request) =>
      request.path.includes("tenant_access_token")
        ? { body: tokenBody }
        : { status: 400, body: { code, msg: "private-provider-message" } },
    );
    const fixture = frozenLedger(transport(server));
    try {
      expect(
        await fixture.ledger.deliverDelivery({ deliveryId: fixture.id, now }),
      ).toMatchObject({ status: "failed" });
      expect(fixture.ledger.getDelivery(fixture.id)).toMatchObject({
        state: "failed",
        lastError: "destination_denied",
        claimToken: null,
      });
      expect(
        await fixture.ledger.deliverDelivery({
          deliveryId: fixture.id,
          now: now + 60_000,
        }),
      ).toMatchObject({ status: "not_sent" });
      expect(
        server.requests.filter(
          (request) => request.path === "/open-apis/im/v1/messages",
        ),
      ).toHaveLength(1);
      expect(
        JSON.stringify(fixture.ledger.getDelivery(fixture.id)),
      ).not.toContain("private-provider-message");
    } finally {
      fixture.close();
      await server.close();
    }
  },
);

test.each([200, 400])(
  "invalid bot credentials (HTTP %s) fail visibly before any message request",
  async (status) => {
    const server = await larkHttpServer(() => ({
      body: { code: 10014, msg: "synthetic-secret" },
      status,
    }));
    const fixture = frozenLedger(transport(server));
    try {
      expect(
        await fixture.ledger.deliverDelivery({ deliveryId: fixture.id, now }),
      ).toMatchObject({ status: "failed" });
      expect(fixture.ledger.getDelivery(fixture.id)).toMatchObject({
        lastError: "credentials_invalid",
        state: "failed",
      });
      expect(server.requests.map((request) => request.path)).toEqual([
        "/open-apis/auth/v3/tenant_access_token/internal",
      ]);
      expect(
        JSON.stringify(fixture.ledger.getDelivery(fixture.id)),
      ).not.toContain("synthetic-secret");
    } finally {
      fixture.close();
      await server.close();
    }
  },
);

test("an uncertain replay rechecks its deadline after credentials and cannot issue a late message", async () => {
  let clock = now;
  let lateCredentials = false;
  const server = await larkHttpServer((request) => {
    if (request.path.includes("tenant_access_token")) {
      if (lateCredentials) clock = now + 3_300_000;
      return { body: tokenBody };
    }
    return {
      status: 400,
      body: { code: 230049, msg: "Message is being sent" },
    };
  });
  const fixture = frozenLedger(
    transport(server, () => clock),
    () => clock,
  );
  try {
    expect(
      await fixture.ledger.deliverDelivery({ deliveryId: fixture.id, now }),
    ).toMatchObject({ status: "uncertain" });
    clock = now + 3_299_999;
    lateCredentials = true;
    expect(
      await fixture.ledger.deliverDelivery({
        deliveryId: fixture.id,
        now: clock,
      }),
    ).toMatchObject({ status: "uncertain" });
    expect(
      server.requests.filter(
        (request) => request.path === "/open-apis/im/v1/messages",
      ),
    ).toHaveLength(1);
    expect(fixture.ledger.getDelivery(fixture.id)).toMatchObject({
      lastError: "deduplication_window_expired",
      state: "uncertain",
      firstAttemptMs: now,
    });
  } finally {
    fixture.close();
    await server.close();
  }
});

test.each([
  { label: "string rejection code", status: 400, body: { code: "230002" } },
  { label: "ambiguous server failure", status: 503, body: { code: 99991400 } },
  {
    label: "missing acknowledgement",
    status: 200,
    body: { code: 0, data: {} },
  },
  {
    label: "wrong destination",
    status: 200,
    body: { code: 0, data: { message_id: "om_wrong", chat_id: "oc_other" } },
  },
  { label: "unknown provider code", status: 400, body: { code: 99999999 } },
  { label: "in-progress response", status: 400, body: { code: 230049 } },
  {
    label: "non-string message ID",
    status: 200,
    body: { code: 0, data: { message_id: 123, chat_id: "oc_destination" } },
  },
])(
  "$label is uncertain rather than proof of success or non-delivery",
  async ({ status, body }) => {
    const server = await larkHttpServer((request) =>
      request.path.includes("tenant_access_token")
        ? { body: tokenBody }
        : { status, body },
    );
    const fixture = frozenLedger(transport(server));
    try {
      expect(
        await fixture.ledger.deliverDelivery({ deliveryId: fixture.id, now }),
      ).toMatchObject({ status: "uncertain" });
      expect(fixture.ledger.getDelivery(fixture.id)).toMatchObject({
        state: "uncertain",
        messageId: null,
        attemptCount: 1,
      });
    } finally {
      fixture.close();
      await server.close();
    }
  },
);

test("credentials arriving after the claim deadline cannot start a stale message request", async () => {
  let clock = now;
  const server = await larkHttpServer(() => {
    clock = now + 45_000;
    return { body: tokenBody };
  });
  const fixture = frozenLedger(
    transport(server, () => clock),
    () => clock,
  );
  try {
    expect(
      await fixture.ledger.deliverDelivery({ deliveryId: fixture.id, now }),
    ).toMatchObject({ status: "uncertain" });
    expect(server.requests.map((request) => request.path)).toEqual([
      "/open-apis/auth/v3/tenant_access_token/internal",
    ]);
    expect(fixture.ledger.getDelivery(fixture.id)).toMatchObject({
      state: "uncertain",
      lastError: "claim_expired",
    });
  } finally {
    fixture.close();
    await server.close();
  }
});

test("a credential endpoint outage is a known pre-message failure and can retry later", async () => {
  const server = await larkHttpServer(() => ({
    status: 503,
    body: { code: 1, msg: "private upstream diagnostics" },
  }));
  const fixture = frozenLedger(transport(server));
  try {
    expect(
      await fixture.ledger.deliverDelivery({ deliveryId: fixture.id, now }),
    ).toMatchObject({ status: "retryable" });
    expect(fixture.ledger.getDelivery(fixture.id)).toMatchObject({
      state: "retryable",
      lastError: "credentials_unavailable",
      nextAttemptMs: now + 30_000,
    });
    expect(server.requests.map((request) => request.path)).toEqual([
      "/open-apis/auth/v3/tenant_access_token/internal",
    ]);
    expect(
      JSON.stringify(fixture.ledger.getDelivery(fixture.id)),
    ).not.toContain("private upstream diagnostics");
  } finally {
    fixture.close();
    await server.close();
  }
});
