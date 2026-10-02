import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { openReportLedger } from "../../src/report-ledger.js";

const scope = {
  appId: "cli_storage_test",
  sourceChatId: "oc_source",
  destinationChatId: "oc_management_placeholder",
};
const now = Date.parse("2026-10-02T07:01:00.000Z");
const uuid = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

/** Keep the WAL writer open so backup must include committed state outside the main file. */
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "task-list-storage-command-"));
  const databasePath = join(directory, "ledger.sqlite");
  const ledger = openReportLedger({
    ...scope,
    databasePath,
    clock: () => now,
    newSendUuid: () => uuid,
    transport: async () => ({ messageId: "om_synthetic_ack" }),
  });
  const prepared = ledger.prepareDailyReport({
    businessDate: "2026-10-02",
    policy: {
      ...scope,
      timeZone: "Africa/Nairobi",
      publicHolidays: [],
      replyPolicy: "exclude",
      policyVersion: "storage-fixture-v1",
    },
    scan: {
      status: "complete",
      appId: scope.appId,
      sourceChatId: scope.sourceChatId,
      businessDate: "2026-10-02",
      observedAtMs: now,
      fromMs: Date.parse("2026-10-01T21:00:00.000Z"),
      throughMs: Date.parse("2026-10-02T07:00:00.000Z"),
      replyPolicy: "exclude",
      messages: [
        {
          observationId: "obs_storage",
          messageId: "om_storage",
          appId: scope.appId,
          sourceChatId: scope.sourceChatId,
          sender: {
            type: "user",
            tenantKey: "external_tenant",
            openId: "ou_synthetic",
            displayName: "Synthetic Submitter",
          },
          createdMs: Date.parse("2026-10-02T06:55:00.000Z"),
          updatedMs: Date.parse("2026-10-02T06:55:00.000Z"),
          messageType: "text",
          content: JSON.stringify({ text: "Task list\n1. Test local release" }),
          deleted: false,
        },
      ],
    },
  });
  if (prepared.status !== "frozen") throw new Error("Expected frozen fixture");
  await ledger.deliverDelivery({ deliveryId: prepared.delivery.id, now });
  return {
    directory,
    databasePath,
    ledger,
    deliveryId: prepared.delivery.id,
    close: () => {
      ledger.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** Exercise the approved storage command in a process with no Lark credentials. */
function command(databasePath: string, args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "src/storage-command.ts", ...args],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: { PATH: process.env.PATH, SQLITE_FILE_PATH: databasePath },
    },
  );
}

test("online backup preserves committed WAL evidence, frozen identity and acknowledged delivery", async () => {
  const environment = await fixture();
  try {
    const output = join(environment.directory, "snapshot.sqlite");
    const result = command(environment.databasePath, [
      "backup",
      "--output",
      output,
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout, result.stderr).not.toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "backed_up" });
    const snapshot = openReportLedger({
      ...scope,
      databasePath: output,
      readOnly: true,
    });
    try {
      expect(snapshot.getDelivery(environment.deliveryId)).toEqual(
        environment.ledger.getDelivery(environment.deliveryId),
      );
      expect(snapshot.getDelivery(environment.deliveryId)).toMatchObject({
        state: "sent",
        sendUuid: uuid,
        messageId: "om_synthetic_ack",
        entries: [
          {
            displayName: "Synthetic Submitter",
            observation: expect.any(Object),
          },
        ],
      });
    } finally {
      snapshot.close();
    }
  } finally {
    environment.close();
  }
});

test("backup refuses to overwrite an existing file or the live source ledger", async () => {
  const environment = await fixture();
  try {
    const output = join(environment.directory, "existing.sqlite");
    writeFileSync(output, "operator's existing backup");
    const before = environment.ledger.getDelivery(environment.deliveryId);
    for (const destination of [output, environment.databasePath]) {
      const result = command(environment.databasePath, [
        "backup",
        "--output",
        destination,
      ]);
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        status: "blocked",
        reason: "output_exists",
      });
    }
    expect(readFileSync(output, "utf8")).toBe("operator's existing backup");
    expect(environment.ledger.getDelivery(environment.deliveryId)).toEqual(
      before,
    );
  } finally {
    environment.close();
  }
});

test("restoring an older snapshot preserves evidence and pauses the worker even with restore mode false", async () => {
  const environment = await fixture();
  const reminders = openReportLedger({
    ...scope,
    databasePath: environment.databasePath,
    destinationChatId: scope.sourceChatId,
  });
  try {
    const prepared = reminders.prepareReminder({
      businessDate: "2026-10-02",
      text: "Synthetic reminder",
      policyVersion: "storage-fixture-v1",
    });
    if (prepared.status !== "frozen") throw new Error("Expected reminder");
    const output = join(environment.directory, "snapshot.sqlite");
    expect(
      command(environment.databasePath, ["backup", "--output", output]).status,
    ).toBe(0);
    const restored = join(environment.directory, "restored.sqlite");
    const result = command(environment.databasePath, [
      "restore",
      "--backup",
      output,
      "--output",
      restored,
    ]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "restored",
      restoreReviewRequired: true,
    });
    const snapshot = openReportLedger({
      ...scope,
      databasePath: restored,
      readOnly: true,
    });
    try {
      expect(snapshot.getDelivery(environment.deliveryId)).toEqual(
        environment.ledger.getDelivery(environment.deliveryId),
      );
    } finally {
      snapshot.close();
    }
    const calendar = join(environment.directory, "calendar.json");
    writeFileSync(
      calendar,
      JSON.stringify({
        version: "synthetic-v1",
        fromDate: "2026-01-01",
        throughDate: "2026-12-31",
        reviewedOn: "2026-01-01",
        sourceUrls: ["https://example.invalid/synthetic"],
        publicHolidays: [],
      }),
    );
    const run = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        "./tests/support/worker-clock.ts",
        "src/worker-command.ts",
        "run",
        "--once",
      ],
      {
        encoding: "utf8",
        timeout: 10_000,
        env: {
          PATH: process.env.PATH,
          SQLITE_FILE_PATH: restored,
          LARK_APP_ID: scope.appId,
          SOURCE_CHAT_ID: scope.sourceChatId,
          MANAGEMENT_CHAT_ID: scope.destinationChatId,
          HOLIDAY_CALENDAR_PATH: calendar,
          ACTIVATION_DATE: "2026-10-02",
          LARK_APP_SECRET: "synthetic-secret",
          LARK_READER_OPEN_ID: "ou_reader",
          LARK_USER_CREDENTIAL_FILE: join(
            environment.directory,
            "no-credentials.json",
          ),
          WORKER_RESTORE_MODE: "false",
          WORKER_TEST_NOW: "2026-10-02T06:30:00.000Z",
        },
      },
    );
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({
      status: "paused",
      reason: "restore_review_required",
      outboundEnabled: false,
    });
  } finally {
    reminders.close();
    environment.close();
  }
});

test("restored pending deliveries cannot bypass review through the delivery library", async () => {
  const environment = await fixture();
  const reminders = openReportLedger({
    ...scope,
    databasePath: environment.databasePath,
    destinationChatId: scope.sourceChatId,
  });
  try {
    const prepared = reminders.prepareReminder({
      businessDate: "2026-10-02",
      text: "Synthetic reminder",
      policyVersion: "storage-fixture-v1",
    });
    if (prepared.status !== "frozen") throw new Error("Expected reminder");
    const snapshot = join(environment.directory, "snapshot.sqlite");
    expect(
      command(environment.databasePath, ["backup", "--output", snapshot])
        .status,
    ).toBe(0);
    const restored = join(environment.directory, "restored.sqlite");
    expect(
      command(environment.databasePath, [
        "restore",
        "--backup",
        snapshot,
        "--output",
        restored,
      ]).status,
    ).toBe(0);
    let sends = 0;
    const restoredLedger = openReportLedger({
      ...scope,
      databasePath: restored,
      destinationChatId: scope.sourceChatId,
      clock: () => Date.parse("2026-10-02T06:30:00.000Z"),
      transport: async () => {
        sends += 1;
        return { messageId: "om_must_not_send" };
      },
    });
    try {
      expect(
        await restoredLedger.deliverDelivery({
          deliveryId: prepared.delivery.id,
          now: Date.parse("2026-10-02T06:30:00.000Z"),
        }),
      ).toMatchObject({
        status: "not_sent",
        reason: "restore_review_required",
      });
      expect(sends).toBe(0);
      expect(restoredLedger.getDelivery(prepared.delivery.id)).toMatchObject({
        state: "pending",
        sendUuid: prepared.delivery.sendUuid,
        attemptCount: 0,
      });
    } finally {
      restoredLedger.close();
    }
  } finally {
    reminders.close();
    environment.close();
  }
});

test("restore refuses existing storage without adding a pause marker or modifying its deliveries", async () => {
  const environment = await fixture();
  try {
    const backup = join(environment.directory, "snapshot.sqlite");
    expect(
      command(environment.databasePath, ["backup", "--output", backup]).status,
    ).toBe(0);
    const before = environment.ledger.getDelivery(environment.deliveryId);
    const result = command(environment.databasePath, [
      "restore",
      "--backup",
      backup,
      "--output",
      environment.databasePath,
    ]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      reason: "output_exists",
    });
    expect(existsSync(`${environment.databasePath}-restore-review.json`)).toBe(
      false,
    );
    expect(environment.ledger.getDelivery(environment.deliveryId)).toEqual(
      before,
    );
  } finally {
    environment.close();
  }
});

test("storage rejects invalid or redirected sources without publishing a snapshot or leaving restore artifacts", async () => {
  const environment = await fixture();
  try {
    const invalid = join(environment.directory, "invalid.sqlite");
    writeFileSync(invalid, "not a task-list database");
    const redirected = join(environment.directory, "redirected.sqlite");
    symlinkSync(environment.databasePath, redirected);
    for (const [index, source] of [
      invalid,
      redirected,
      join(environment.directory, "missing.sqlite"),
    ].entries()) {
      const output = join(environment.directory, `restore-${index}.sqlite`);
      const result = command(environment.databasePath, [
        "restore",
        "--backup",
        source,
        "--output",
        output,
      ]);
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ status: "blocked" });
      expect(existsSync(output)).toBe(false);
      expect(existsSync(`${output}-restore-review.json`)).toBe(false);
    }
  } finally {
    environment.close();
  }
});

test("storage rejects an unrelated SQLite database instead of calling it a valid task-list restore", async () => {
  const environment = await fixture();
  try {
    const unrelated = join(environment.directory, "unrelated.sqlite");
    const input = new Database(unrelated);
    input.exec("CREATE TABLE unrelated (value TEXT)");
    input.close();
    const output = join(environment.directory, "restored.sqlite");
    const result = command(environment.databasePath, [
      "restore",
      "--backup",
      unrelated,
      "--output",
      output,
    ]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "blocked",
      reason: "invalid_ledger",
    });
    expect(existsSync(output)).toBe(false);
  } finally {
    environment.close();
  }
});

test("snapshot publication refuses a destination with existing SQLite sidecars or restore metadata", async () => {
  const environment = await fixture();
  try {
    for (const [index, suffix] of [
      "-wal",
      "-shm",
      "-journal",
      "-restore-review.json",
    ].entries()) {
      const output = join(environment.directory, `reserved-${index}.sqlite`);
      writeFileSync(`${output}${suffix}`, "existing operator state");
      const result = command(environment.databasePath, [
        "backup",
        "--output",
        output,
      ]);
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        status: "blocked",
        reason: "output_exists",
      });
      expect(existsSync(output)).toBe(false);
      expect(readFileSync(`${output}${suffix}`, "utf8")).toBe(
        "existing operator state",
      );
    }
  } finally {
    environment.close();
  }
});
