import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { openReportLedger } from "../../src/report-ledger.js";

/** Existing migrated ledger and synthetic calendar; no worker credentials or live group IDs. */
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "task-list-worker-command-"));
  const databasePath = join(directory, "ledger.sqlite");
  const calendarPath = join(directory, "calendar.json");
  const ledger = openReportLedger({
    databasePath,
    appId: "cli_test",
    sourceChatId: "oc_source",
    destinationChatId: "oc_management",
  });
  ledger.close();
  writeFileSync(
    calendarPath,
    JSON.stringify({
      version: "synthetic-cli-v1",
      fromDate: "2026-01-01",
      throughDate: "2026-12-31",
      reviewedOn: "2026-01-01",
      sourceUrls: ["https://example.invalid/synthetic"],
      publicHolidays: [],
    }),
  );
  return { directory, databasePath, calendarPath };
}

/** Run the actual approved command with a controlled, credential-free environment. */
function command(
  environment: ReturnType<typeof fixture>,
  args: string[],
  extra: NodeJS.ProcessEnv = {},
) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      "./tests/support/worker-clock.ts",
      "src/worker-command.ts",
      ...args,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 10_000,
      env: {
        PATH: process.env.PATH,
        APP_MODE: "preview",
        ENABLE_OUTBOUND: "false",
        SQLITE_FILE_PATH: environment.databasePath,
        HOLIDAY_CALENDAR_PATH: environment.calendarPath,
        ACTIVATION_DATE: "2026-01-01",
        LARK_APP_ID: "cli_test",
        SOURCE_CHAT_ID: "oc_source",
        MANAGEMENT_CHAT_ID: "oc_management",
        ...extra,
      },
    },
  );
}

test("worker status inspects existing state without SDK credentials or database writes", () => {
  const environment = fixture();
  try {
    const before = readFileSync(environment.databasePath);
    const result = command(environment, ["status"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "ok",
      outboundEnabled: false,
      backfill: { dates: expect.any(Array) },
    });
    expect(readFileSync(environment.databasePath)).toEqual(before);
  } finally {
    rmSync(environment.directory, { recursive: true, force: true });
  }
});

test("brief status opts into capture-only without model credentials or storage writes", () => {
  const environment = fixture();
  try {
    const before = readFileSync(environment.databasePath);
    const result = command(environment, ["status"], {
      ENABLE_DAILY_BRIEF: "true",
      BRIEF_MODE: "capture_only",
      BRIEF_ACTIVATION_DATE: "2026-10-01",
      BRIEF_PROVIDER: "gemini",
      GEMINI_MODEL: "synthetic-model",
      BRIEF_TEMPLATE_VERSION: "template-v1",
      BRIEF_PROMPT_VERSION: "prompt-v1",
      BRIEF_SCHEMA_VERSION: "schema-v1",
      WORKER_TEST_NOW: "2026-10-02T07:15:00Z",
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      brief: { state: "due", mode: "capture_only" },
      briefBackfill: { dates: ["2026-10-01"] },
    });
    expect(readFileSync(environment.databasePath)).toEqual(before);
  } finally {
    rmSync(environment.directory, { recursive: true, force: true });
  }
});

test("worker commands reject unsafe modes, outbound settings and arguments without leaking secrets", () => {
  const environment = fixture();
  try {
    for (const settings of [
      { ENABLE_OUTBOUND: "true" },
      { ENABLE_OUTBOUND: "yes" },
      { APP_MODE: "prodution" },
      { BUSINESS_TIMEZONE: "UTC" },
      { ENABLE_DAILY_BRIEF: "yes" },
      { ENABLE_DAILY_BRIEF: "true", BRIEF_MODE: "publish" },
      {
        ENABLE_DAILY_BRIEF: "true",
        BRIEF_MODE: "unknown",
        BRIEF_PROVIDER: "gemini",
      },
    ]) {
      const result = command(environment, ["status"], {
        ...settings,
        LARK_APP_SECRET: "synthetic-secret-never-print",
      });
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        status: "blocked",
        outboundEnabled: false,
      });
      expect(result.stdout + result.stderr).not.toContain(
        "synthetic-secret-never-print",
      );
    }
    expect(command(environment, ["status", "--force"]).status).toBe(1);
  } finally {
    rmSync(environment.directory, { recursive: true, force: true });
  }
});

test("one startup due check freezes a preview reminder with sending disabled", () => {
  const environment = fixture();
  try {
    const result = command(environment, ["run", "--once"], {
      WORKER_TEST_NOW: "2026-10-02T06:30:00.000Z",
      LARK_APP_SECRET: "synthetic-secret",
      LARK_READER_OPEN_ID: "ou_operator",
      LARK_USER_CREDENTIAL_FILE: join(
        environment.directory,
        "missing-user-oauth.json",
      ),
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "ok",
      outboundEnabled: false,
      reminder: { state: "pending", attemptCount: 0 },
      report: { state: "not_due" },
    });
    const ledger = openReportLedger({
      databasePath: environment.databasePath,
      appId: "cli_test",
      sourceChatId: "oc_source",
      destinationChatId: "oc_source",
      readOnly: true,
    });
    try {
      expect(ledger.getDailyDelivery("2026-10-02", "reminder")).toMatchObject({
        text: "Please post today's task list in this group by 10:00 AM Nairobi time.",
        attemptCount: 0,
        firstAttemptMs: null,
        state: "pending",
        entries: [],
      });
    } finally {
      ledger.close();
    }
  } finally {
    rmSync(environment.directory, { recursive: true, force: true });
  }
});

test("the continuous command checks at startup and each configured minute then stops cleanly", async () => {
  const environment = fixture();
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      "./tests/support/worker-clock.ts",
      "src/worker-command.ts",
      "run",
    ],
    {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        APP_MODE: "preview",
        ENABLE_OUTBOUND: "false",
        SQLITE_FILE_PATH: environment.databasePath,
        HOLIDAY_CALENDAR_PATH: environment.calendarPath,
        ACTIVATION_DATE: "2026-01-01",
        LARK_APP_ID: "cli_test",
        SOURCE_CHAT_ID: "oc_source",
        MANAGEMENT_CHAT_ID: "oc_management",
        LARK_APP_SECRET: "synthetic-secret",
        LARK_READER_OPEN_ID: "ou_operator",
        LARK_USER_CREDENTIAL_FILE: join(
          environment.directory,
          "missing-user-oauth.json",
        ),
        WORKER_TEST_ADVANCE_INTERVAL: "true",
        WORKER_TEST_NOW: "2026-10-02T06:29:00.000Z",
      },
    },
  );
  const lines: string[] = [];
  let partial = "";
  child.stdout.on("data", (data: Buffer) => {
    partial += data.toString();
    const complete = partial.split("\n");
    partial = complete.pop() ?? "";
    lines.push(...complete.filter(Boolean));
    if (lines.length >= 2) child.kill("SIGTERM");
  });
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      const deadline = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Worker process did not stop"));
      }, 6000);
      child.once("error", (error) => {
        clearTimeout(deadline);
        reject(error);
      });
      child.once("exit", (exitCode) => {
        clearTimeout(deadline);
        resolve(exitCode);
      });
    });
    expect(code).toBe(0);
    expect(lines.map((line) => JSON.parse(line))).toMatchObject([
      {
        reminder: { state: "not_due" },
        report: { state: "not_due" },
        outboundEnabled: false,
      },
      {
        reminder: { state: "pending", attemptCount: 0 },
        report: { state: "not_due" },
        outboundEnabled: false,
      },
    ]);
  } finally {
    child.kill("SIGKILL");
    rmSync(environment.directory, { recursive: true, force: true });
  }
});
