import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  type DeliveryTransport,
  openReportLedger,
} from "../../src/report-ledger.js";
import { ledgerProcess } from "../support/process-harness.js";

const now = Date.now();
const config = {
  appId: "cli_test",
  sourceChatId: "oc_source",
  destinationChatId: "oc_destination",
};
function seed(
  transport: DeliveryTransport = async () => {
    throw new Error("lost response");
  },
  recipient?: { type: "chat_id" | "open_id"; id: string },
) {
  const directory = mkdtempSync(join(tmpdir(), "task-list-command-"));
  const path = join(directory, "ledger.sqlite");
  const ledger = openReportLedger({
    appId: config.appId,
    sourceChatId: config.sourceChatId,
    ...(recipient
      ? { recipient }
      : { destinationChatId: config.destinationChatId }),
    databasePath: path,
    clock: () => now,
    transport,
  });
  const prepared = ledger.prepareDailyReport({
    businessDate: "2026-10-01",
    policy: {
      appId: "cli_test",
      sourceChatId: "oc_source",
      timeZone: "Africa/Nairobi",
      publicHolidays: [],
      replyPolicy: "exclude",
      policyVersion: "command-v1",
    },
    scan: {
      status: "complete",
      appId: "cli_test",
      sourceChatId: "oc_source",
      businessDate: "2026-10-01",
      observedAtMs: now,
      fromMs: 1790802000000,
      throughMs: 1790838060000,
      replyPolicy: "exclude",
      messages: [],
    },
  });
  if (prepared.status !== "frozen") throw new Error("Expected frozen report");
  return {
    ledger,
    id: prepared.delivery.id,
    path,
    close: () => {
      ledger.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
function command(
  path: string,
  args: string[],
  env: Record<string, string> = {},
) {
  return spawnSync("pnpm", ["--silent", "delivery", ...args], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      SQLITE_FILE_PATH: path,
      LARK_APP_ID: "cli_test",
      SOURCE_CHAT_ID: "oc_source",
      MANAGEMENT_CHAT_ID: "oc_destination",
      ENABLE_OUTBOUND: "false",
      LARK_APP_SECRET: "synthetic-secret-never-print",
      ...env,
    },
  });
}

test("the same recovery commands inspect and reconcile source-group reminder IDs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "task-list-reminder-command-"));
  const path = join(directory, "ledger.sqlite");
  const first = Date.parse("2026-10-02T06:30:00.000Z");
  const ledger = openReportLedger({
    ...config,
    destinationChatId: config.sourceChatId,
    databasePath: path,
    clock: () => first,
    transport: async () => {
      throw new Error("lost response");
    },
  });
  try {
    const prepared = ledger.prepareReminder({
      businessDate: "2026-10-02",
      text: "Synthetic approved reminder",
      policyVersion: "command-v1",
    });
    if (prepared.status !== "frozen") throw new Error("Expected reminder");
    await ledger.deliverDelivery({
      deliveryId: prepared.delivery.id,
      now: first,
    });
    const result = command(path, ["status", "--id", prepared.delivery.id]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      delivery: {
        kind: "reminder",
        state: "uncertain",
        reconciliationRequired: true,
      },
    });
    const reviewed = command(path, [
      "reconcile",
      "--id",
      prepared.delivery.id,
      "--decision",
      "sent",
      "--expected-attempt",
      "1",
      "--operator",
      "Anthony",
      "--reason",
      "Verified the exact reminder in the source group",
      "--message-id",
      "om_reminder_reviewed",
    ]);
    expect(reviewed.status).toBe(0);
    expect(ledger.getDelivery(prepared.delivery.id)).toMatchObject({
      state: "sent",
      messageId: "om_reminder_reviewed",
      reconciliations: [{ operator: "Anthony" }],
    });
  } finally {
    ledger.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the approved status command reports an uncertain delivery without sending or changing it", async () => {
  const fixture = seed();
  try {
    await fixture.ledger.deliverDelivery({ deliveryId: fixture.id, now });
    const before = fixture.ledger.getDelivery(fixture.id);
    const result = command(fixture.path, ["status", "--id", fixture.id]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "ok",
      delivery: {
        id: fixture.id,
        state: "uncertain",
        attemptCount: 1,
        lastError: "transport_or_acknowledgement_unknown",
        reconciliationRequired: true,
      },
    });
    expect(fixture.ledger.getDelivery(fixture.id)).toEqual(before);
    expect(result.stdout + result.stderr).not.toContain(
      "synthetic-secret-never-print",
    );
  } finally {
    fixture.close();
  }
});

test("a reviewed sent decision records the actual message ID and durable operator evidence without sending", async () => {
  const fixture = seed();
  try {
    await fixture.ledger.deliverDelivery({ deliveryId: fixture.id, now });
    const result = command(fixture.path, [
      "reconcile",
      "--id",
      fixture.id,
      "--decision",
      "sent",
      "--expected-attempt",
      "1",
      "--operator",
      "Anthony",
      "--reason",
      "Verified exact report in destination; message om_reviewed_ack",
      "--message-id",
      "om_reviewed_ack",
    ]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "reconciled" });
    expect(fixture.ledger.getDelivery(fixture.id)).toMatchObject({
      state: "sent",
      attemptCount: 1,
      messageId: "om_reviewed_ack",
      claimToken: null,
      reconciliations: [
        {
          decision: "sent",
          expectedAttempt: 1,
          operator: "Anthony",
          reason:
            "Verified exact report in destination; message om_reviewed_ack",
          messageId: "om_reviewed_ack",
        },
      ],
    });
    expect(
      await fixture.ledger.deliverDelivery({
        deliveryId: fixture.id,
        now: Date.now(),
      }),
    ).toMatchObject({ status: "not_sent" });
  } finally {
    fixture.close();
  }
});

test("a reviewed not-sent decision permits a later attempt with the original text and UUID", async () => {
  const fixture = seed();
  try {
    await fixture.ledger.deliverDelivery({ deliveryId: fixture.id, now });
    const saved = fixture.ledger.getDelivery(fixture.id);
    const result = command(fixture.path, [
      "reconcile",
      "--id",
      fixture.id,
      "--decision",
      "not-sent",
      "--expected-attempt",
      "1",
      "--operator",
      "Anthony",
      "--reason",
      "Verified message did not leave the worker; inspected request evidence",
    ]);
    expect(result.status).toBe(0);
    expect(fixture.ledger.getDelivery(fixture.id)).toMatchObject({
      state: "retryable",
      attemptCount: 1,
      text: saved?.text,
      sendUuid: saved?.sendUuid,
      reconciliations: [
        {
          decision: "not-sent",
          operator: "Anthony",
          expectedAttempt: 1,
          messageId: null,
        },
      ],
    });
    const requests: unknown[] = [];
    const sender = openReportLedger({
      ...config,
      databasePath: fixture.path,
      transport: async (request) => {
        requests.push(request);
        return { messageId: "om_reviewed_retry" };
      },
    });
    try {
      expect(
        await sender.deliverDelivery({
          deliveryId: fixture.id,
          now: Date.now(),
        }),
      ).toMatchObject({ status: "sent" });
      expect(requests).toEqual([
        {
          appId: "cli_test",
          destinationChatId: "oc_destination",
          text: "1 October 2026\nNo valid submissions found by the approved cutoff",
          uuid: saved?.sendUuid,
        },
      ]);
    } finally {
      sender.close();
    }
  } finally {
    fixture.close();
  }
});

test("review of an expired process claim fences its later acknowledgement", async () => {
  const fixture = seed();
  const child = ledgerProcess({
    ...config,
    databasePath: fixture.path,
    now: Date.now() - 61_000,
    action: "deliver",
    deliveryId: fixture.id,
  });
  try {
    await child.next("ready");
    child.go();
    await child.next("request");
    const result = command(fixture.path, [
      "reconcile",
      "--id",
      fixture.id,
      "--decision",
      "sent",
      "--expected-attempt",
      "1",
      "--operator",
      "Anthony",
      "--reason",
      "Verified exact message in the approved destination after the claim expired",
      "--message-id",
      "om_operator_wins",
    ]);
    expect(result.status).toBe(0);
    child.acknowledge();
    expect((await child.next("result")).result).toMatchObject({
      status: "uncertain",
    });
    expect(fixture.ledger.getDelivery(fixture.id)).toMatchObject({
      state: "sent",
      messageId: "om_operator_wins",
      attemptCount: 1,
      reconciliations: [{ decision: "sent" }],
    });
  } finally {
    await child.close();
    fixture.close();
  }
});

test("review after correcting a definitive failure makes the original report eligible again", async () => {
  const fixture = seed(async () => ({
    status: "failed",
    reason: "destination_denied",
  }));
  try {
    await fixture.ledger.deliverDelivery({ deliveryId: fixture.id, now });
    const result = command(fixture.path, [
      "reconcile",
      "--id",
      fixture.id,
      "--decision",
      "not-sent",
      "--expected-attempt",
      "1",
      "--operator",
      "Anthony",
      "--reason",
      "Bot membership corrected; original API response confirmed rejection",
    ]);
    expect(result.status).toBe(0);
    expect(fixture.ledger.getDelivery(fixture.id)).toMatchObject({
      state: "retryable",
      attemptCount: 1,
      lastError: null,
      reconciliations: [{ decision: "not-sent" }],
    });
  } finally {
    fixture.close();
  }
});

test.each([
  { label: "missing message ID", args: [] },
  { label: "invented message ID", args: ["--message-id", "invented"] },
  {
    label: "stale attempt",
    args: ["--message-id", "om_reviewed", "--expected-attempt", "2"],
    duplicateAttempt: true,
  },
  {
    label: "unknown flag",
    args: ["--message-id", "om_reviewed", "--force", "true"],
  },
])(
  "reconciliation rejects $label without altering the delivery or evidence",
  async ({ args, duplicateAttempt }) => {
    const fixture = seed();
    try {
      await fixture.ledger.deliverDelivery({ deliveryId: fixture.id, now });
      const before = fixture.ledger.getDelivery(fixture.id);
      const result = command(fixture.path, [
        "reconcile",
        "--id",
        fixture.id,
        "--decision",
        "sent",
        ...(duplicateAttempt ? [] : ["--expected-attempt", "1"]),
        "--operator",
        "Anthony",
        "--reason",
        "Checked the actual destination message",
        ...args,
      ]);
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ status: "blocked" });
      expect(fixture.ledger.getDelivery(fixture.id)).toEqual(before);
    } finally {
      fixture.close();
    }
  },
);

test("an operator cannot reconcile an active claim or a delivery outside the configured scope", async () => {
  const fixture = seed();
  const child = ledgerProcess({
    ...config,
    databasePath: fixture.path,
    now: Date.now(),
    action: "deliver",
    deliveryId: fixture.id,
  });
  try {
    await child.next("ready");
    child.go();
    await child.next("request");
    const before = fixture.ledger.getDelivery(fixture.id);
    const args = [
      "reconcile",
      "--id",
      fixture.id,
      "--decision",
      "sent",
      "--expected-attempt",
      "1",
      "--operator",
      "Anthony",
      "--reason",
      "Checked the actual destination",
      "--message-id",
      "om_reviewed",
    ];
    expect(command(fixture.path, args).status).toBe(1);
    expect(
      command(fixture.path, ["status", "--id", fixture.id], {
        LARK_APP_ID: "cli_other",
      }).status,
    ).toBe(1);
    expect(fixture.ledger.getDelivery(fixture.id)).toEqual(before);
    child.acknowledge();
    await child.next("result");
  } finally {
    await child.close();
    fixture.close();
  }
});

test("delivery recovery inspects only the configured admin's frozen report", () => {
  const fixture = seed(undefined, { type: "open_id", id: "ou_admin" });
  try {
    const result = command(fixture.path, ["status", "--id", fixture.id], {
      MANAGEMENT_CHAT_ID: "",
      REPORT_RECIPIENT_TYPE: "open_id",
      REPORT_RECIPIENT_ID: "ou_admin",
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      delivery: { id: fixture.id, state: "pending" },
    });
    const other = command(fixture.path, ["status", "--id", fixture.id], {
      MANAGEMENT_CHAT_ID: "",
      REPORT_RECIPIENT_TYPE: "open_id",
      REPORT_RECIPIENT_ID: "ou_other",
    });
    expect(other.status).toBe(1);
  } finally {
    fixture.close();
  }
});
