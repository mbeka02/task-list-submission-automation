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
      "--import",
      "./tests/support/worker-runtime-http.mjs",
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

test("worker emits correlated JSON telemetry on stderr without changing its stdout contract", () => {
  const environment = fixture();
  try {
    const result = command(environment, ["run", "--once"], {
      WORKER_TEST_NOW: "2026-10-02T06:30:00.000Z",
      LOG_LEVEL: "debug",
      LARK_APP_SECRET: "secret-canary-do-not-log",
      LARK_READER_OPEN_ID: "ou_operator",
      LARK_USER_CREDENTIAL_FILE: join(environment.directory, "oauth.json"),
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "ok",
      outboundEnabled: false,
    });
    const events = result.stderr
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "worker_check_started",
          entryPoint: "worker_once",
          runId: expect.any(String),
        }),
        expect.objectContaining({
          event: "worker_check_completed",
          businessDate: "2026-10-02",
          status: "ok",
          reminderState: "pending",
          durationMs: expect.any(Number),
        }),
      ]),
    );
    expect(new Set(events.map((event) => event.runId)).size).toBe(1);
    expect(result.stderr).not.toContain("secret-canary-do-not-log");
    expect(result.stderr).not.toContain("Please post today's task list");
  } finally {
    rmSync(environment.directory, { recursive: true, force: true });
  }
});

test("unsafe worker configuration is diagnosable as a structured error without exposing its value", () => {
  const environment = fixture();
  try {
    const result = command(environment, ["run", "--once"], {
      ENABLE_OUTBOUND: "true",
      LARK_APP_SECRET: "config-secret-canary",
    });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "blocked",
      reason: "outbound_requires_activation",
    });
    expect(JSON.parse(result.stderr)).toMatchObject({
      event: "worker_command_failed",
      level: "error",
      entryPoint: "worker_once",
      runId: expect.any(String),
      reason: "outbound_requires_activation",
    });
    expect(result.stderr).not.toContain("config-secret-canary");
  } finally {
    rmSync(environment.directory, { recursive: true, force: true });
  }
});

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
      { LOG_LEVEL: "secret-invalid-level-canary" },
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
  let telemetry = "";
  child.stderr.on("data", (data: Buffer) => {
    telemetry += data.toString();
  });
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
    const checks = telemetry
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((event) => event.event === "worker_check_completed");
    expect(checks.map((event) => event.entryPoint)).toEqual([
      "worker_startup",
      "worker_periodic",
    ]);
    expect(new Set(checks.map((event) => event.runId)).size).toBe(2);
  } finally {
    child.kill("SIGKILL");
    rmSync(environment.directory, { recursive: true, force: true });
  }
});

test("worker status accepts an explicit admin recipient without a group destination or credentials", () => {
  const environment = fixture();
  try {
    const result = command(environment, ["status"], {
      MANAGEMENT_CHAT_ID: undefined,
      REPORT_RECIPIENT_TYPE: "open_id",
      REPORT_RECIPIENT_ID: "ou_admin",
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "ok",
      outboundEnabled: false,
    });
  } finally {
    rmSync(environment.directory, { recursive: true, force: true });
  }
});

test("an explicitly configured production worker sends the due reminder and persists its acknowledgement", () => {
  const environment = fixture();
  try {
    const result = command(environment, ["run", "--once"], {
      APP_MODE: "production",
      ENABLE_OUTBOUND: "true",
      MANAGEMENT_CHAT_ID: undefined,
      REPORT_RECIPIENT_TYPE: "open_id",
      REPORT_RECIPIENT_ID: "ou_admin",
      WORKER_TEST_NOW: "2026-10-02T06:30:00.000Z",
      LARK_APP_SECRET: "production-secret-canary",
      LARK_READER_OPEN_ID: "ou_operator",
      LARK_USER_CREDENTIAL_FILE: join(environment.directory, "oauth.json"),
      WORKER_TEST_HTTP: "true",
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      outboundEnabled: true,
      reminder: { state: "sent", messageId: "om_reminder", attemptCount: 1 },
      report: { state: "not_due" },
    });
    const ledger = openReportLedger({
      databasePath: environment.databasePath,
      appId: "cli_test",
      sourceChatId: "oc_source",
      destinationChatId: "oc_source",
    });
    try {
      const id = JSON.parse(result.stdout).reminder.deliveryId;
      expect(ledger.getDelivery(id)).toMatchObject({
        state: "sent",
        messageId: "om_reminder",
      });
    } finally {
      ledger.close();
    }
    expect(result.stdout + result.stderr).not.toContain(
      "production-secret-canary",
    );
  } finally {
    rmSync(environment.directory, { recursive: true, force: true });
  }
});

test("production sends source reminders through a separately bound signed webhook", () => {
  const environment = fixture();
  try {
    const result = command(environment, ["run", "--once"], {
      APP_MODE: "production",
      ENABLE_OUTBOUND: "true",
      MANAGEMENT_CHAT_ID: undefined,
      REPORT_RECIPIENT_TYPE: "chat_id",
      REPORT_RECIPIENT_ID: "oc_private_reports",
      REPORT_TRANSPORT: "webhook",
      REMINDER_TRANSPORT: "webhook",
      REPORT_WEBHOOK_URL:
        "https://open.larksuite.com/open-apis/bot/v2/hook/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
      REPORT_WEBHOOK_SIGNING_SECRET: "report-secret-canary",
      REMINDER_WEBHOOK_URL:
        "https://open.larksuite.com/open-apis/bot/v2/hook/bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb",
      REMINDER_WEBHOOK_SIGNING_SECRET: "reminder-secret-canary",
      WORKER_TEST_NOW: "2026-10-02T06:30:00Z",
      WORKER_TEST_HTTP: "true",
      LARK_APP_SECRET: "synthetic-app-secret",
      LARK_READER_OPEN_ID: "ou_operator",
      LARK_USER_CREDENTIAL_FILE: join(environment.directory, "oauth.json"),
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      reminder: { state: "sent", messageId: null, attemptCount: 1 },
      report: { state: "not_due" },
    });
    const ledger = openReportLedger({
      databasePath: environment.databasePath,
      appId: "cli_test",
      sourceChatId: "oc_source",
      destinationChatId: "oc_source",
    });
    try {
      expect(ledger.getDailyDelivery("2026-10-02", "reminder")).toMatchObject({
        adapterKind: "lark_webhook",
        messageId: null,
      });
    } finally {
      ledger.close();
    }
    for (const secret of [
      "report-secret-canary",
      "reminder-secret-canary",
      "/hook/",
    ])
      expect(result.stdout + result.stderr).not.toContain(secret);
  } finally {
    rmSync(environment.directory, { recursive: true, force: true });
  }
});

test.each(["app_bot", "webhook"])(
  "production publishes a verified editable brief and names report using %s",
  (transport) => {
    const environment = fixture();
    const credentialFile = join(environment.directory, "oauth.json");
    writeFileSync(
      credentialFile,
      JSON.stringify({
        version: 1,
        state: "ready",
        appId: "cli_test",
        readerOpenId: "ou_operator",
        accessToken: "synthetic-reader",
        refreshToken: "synthetic-refresh",
        expiresAtMs: 1791100000000,
        refreshExpiresAtMs: 1792000000000,
      }),
      { mode: 0o600 },
    );
    try {
      const result = command(environment, ["run", "--once"], {
        APP_MODE: "production",
        ENABLE_OUTBOUND: "true",
        MANAGEMENT_CHAT_ID: undefined,
        REPORT_RECIPIENT_TYPE: transport === "webhook" ? "chat_id" : "open_id",
        REPORT_RECIPIENT_ID:
          transport === "webhook" ? "oc_private_reports" : "ou_admin",
        REPORT_TRANSPORT: transport,
        REPORT_WEBHOOK_URL:
          "https://open.larksuite.com/open-apis/bot/v2/hook/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
        REPORT_WEBHOOK_SIGNING_SECRET: "report-key-canary",
        WORKER_TEST_NOW: "2026-10-02T07:15:01Z",
        WORKER_TEST_HTTP: "true",
        LARK_APP_SECRET: "synthetic-secret",
        LARK_READER_OPEN_ID: "ou_operator",
        LARK_USER_CREDENTIAL_FILE: credentialFile,
        ENABLE_DAILY_BRIEF: "true",
        BRIEF_MODE: "publish",
        BRIEF_ACTIVATION_DATE: "2026-10-02",
        BRIEF_PROVIDER: "gemini",
        GEMINI_API_KEY: "model-key-canary",
        GEMINI_MODEL: "gemini-3.5-flash-lite",
        BRIEF_TEMPLATE_VERSION: "template-v1",
        BRIEF_PROMPT_VERSION: "prompt-v1",
        BRIEF_SCHEMA_VERSION: "schema-v1",
        LARK_DOC_STAGING_FOLDER_TOKEN: "folderSynthetic",
        LARK_DOCUMENT_BASE_URL: "https://example.larksuite.com/docx/",
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        outboundEnabled: true,
        report: {
          state: "sent",
          ...(transport === "webhook" ? { messageId: null } : {}),
        },
        brief: {
          state: "published",
          announcement: {
            state: "sent",
            ...(transport === "webhook" ? { messageId: null } : {}),
          },
          documentUrl: "https://example.larksuite.com/docx/docRelease",
        },
      });
      expect(result.stdout + result.stderr).not.toContain("model-key-canary");
    } finally {
      rmSync(environment.directory, { recursive: true, force: true });
    }
  },
);

test("production publishing status is read-only and does not require model or app secrets", () => {
  const environment = fixture();
  try {
    const before = readFileSync(environment.databasePath);
    const result = command(environment, ["status"], {
      APP_MODE: "production",
      ENABLE_OUTBOUND: "true",
      MANAGEMENT_CHAT_ID: undefined,
      REPORT_RECIPIENT_TYPE: "open_id",
      REPORT_RECIPIENT_ID: "ou_admin",
      ENABLE_DAILY_BRIEF: "true",
      BRIEF_MODE: "publish",
      BRIEF_ACTIVATION_DATE: "2026-10-02",
      BRIEF_PROVIDER: "gemini",
      GEMINI_MODEL: "gemini-3.5-flash-lite",
      BRIEF_TEMPLATE_VERSION: "template-v1",
      BRIEF_PROMPT_VERSION: "prompt-v1",
      BRIEF_SCHEMA_VERSION: "schema-v1",
      LARK_DOC_STAGING_FOLDER_TOKEN: "folderSynthetic",
      LARK_DOCUMENT_BASE_URL: "https://example.larksuite.com/docx/",
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "ok",
      outboundEnabled: true,
    });
    expect(readFileSync(environment.databasePath)).toEqual(before);
  } finally {
    rmSync(environment.directory, { recursive: true, force: true });
  }
});

test("a production publishing run rejects unsupported models before any source or outbound work", () => {
  const environment = fixture();
  try {
    const result = command(environment, ["run", "--once"], {
      APP_MODE: "production",
      ENABLE_OUTBOUND: "true",
      MANAGEMENT_CHAT_ID: undefined,
      REPORT_RECIPIENT_TYPE: "open_id",
      REPORT_RECIPIENT_ID: "ou_admin",
      WORKER_TEST_HTTP: "true",
      LARK_APP_SECRET: "secret-canary",
      LARK_READER_OPEN_ID: "ou_operator",
      LARK_USER_CREDENTIAL_FILE: join(environment.directory, "oauth.json"),
      ENABLE_DAILY_BRIEF: "true",
      BRIEF_MODE: "publish",
      BRIEF_ACTIVATION_DATE: "2026-10-02",
      BRIEF_PROVIDER: "gemini",
      GEMINI_MODEL: "invalid-model-secret-canary",
      GEMINI_API_KEY: "key-canary",
      BRIEF_TEMPLATE_VERSION: "template-v1",
      BRIEF_PROMPT_VERSION: "prompt-v1",
      BRIEF_SCHEMA_VERSION: "schema-v1",
      LARK_DOC_STAGING_FOLDER_TOKEN: "folderSynthetic",
      LARK_DOCUMENT_BASE_URL: "https://example.larksuite.com/docx/",
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "blocked",
      reason: "invalid_worker_configuration",
      outboundEnabled: false,
    });
    expect(result.stdout + result.stderr).not.toContain("canary");
  } finally {
    rmSync(environment.directory, { recursive: true, force: true });
  }
});

test("one webhook cannot be configured for two distinct group destinations", () => {
  const environment = fixture();
  try {
    const url =
      "https://open.larksuite.com/open-apis/bot/v2/hook/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
    const result = command(environment, ["run", "--once"], {
      APP_MODE: "production",
      ENABLE_OUTBOUND: "true",
      MANAGEMENT_CHAT_ID: undefined,
      REPORT_RECIPIENT_TYPE: "chat_id",
      REPORT_RECIPIENT_ID: "oc_private_reports",
      REPORT_TRANSPORT: "webhook",
      REMINDER_TRANSPORT: "webhook",
      REPORT_WEBHOOK_URL: url,
      REMINDER_WEBHOOK_URL: url,
      REPORT_WEBHOOK_SIGNING_SECRET: "signing-canary",
      REMINDER_WEBHOOK_SIGNING_SECRET: "signing-canary",
      WORKER_TEST_NOW: "2026-10-02T06:30:00Z",
      WORKER_TEST_HTTP: "true",
      LARK_APP_SECRET: "synthetic-app-secret",
      LARK_READER_OPEN_ID: "ou_operator",
      LARK_USER_CREDENTIAL_FILE: join(environment.directory, "oauth.json"),
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "blocked",
      reason: "invalid_webhook_configuration",
      outboundEnabled: false,
    });
    expect(result.stdout + result.stderr).not.toContain("signing-canary");
    expect(result.stdout + result.stderr).not.toContain(url);
  } finally {
    rmSync(environment.directory, { recursive: true, force: true });
  }
});
