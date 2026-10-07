import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createSubmissionHistoryReader } from "../../src/submission-history.js";
import { larkHttpServer } from "../support/lark-http-server.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "task-list-login-"));
  const credentialFile = join(directory, "user-oauth.json");
  const requests = join(directory, "requests.txt");
  return {
    directory,
    credentialFile,
    requests,
    command(action: string, extra: NodeJS.ProcessEnv = {}) {
      return spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--import",
          "./tests/support/worker-auth-http.mjs",
          "src/worker-auth-command.ts",
          action,
        ],
        {
          encoding: "utf8",
          timeout: 10000,
          env: {
            PATH: process.env.PATH,
            LARK_APP_ID: "cli_test",
            LARK_APP_SECRET: "app-secret-canary",
            LARK_READER_OPEN_ID: "ou_reader",
            LARK_USER_CREDENTIAL_FILE: credentialFile,
            LARK_OAUTH_SCOPES: "im:message:readonly",
            OAUTH_TEST_REQUESTS: requests,
            ...extra,
          },
        },
      );
    },
    close: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test("operator starts a private login and receives consent details without token material", () => {
  const f = fixture();
  try {
    const result = f.command("start");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "authorization_pending",
      verificationUrl:
        "https://accounts.larksuite.com/device?user_code=DEMO-1234",
      userCode: "DEMO-1234",
      expiresAtMs: 1791363840000,
    });
    expect(result.stdout + result.stderr).not.toContain("secret-canary");
    expect(existsSync(f.credentialFile)).toBe(false);
  } finally {
    f.close();
  }
});

test("operator completes consent, verifies the reader and provisions credentials usable by the worker", async () => {
  const f = fixture();
  const server = await larkHttpServer(() => ({
    body: { code: 0, data: { items: [], has_more: false } },
  }));
  try {
    expect(f.command("start").status).toBe(0);
    const result = f.command("finish");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "ready",
      readerOpenId: "ou_reader",
    });
    expect(result.stdout + result.stderr).not.toContain("secret-canary");
    expect(statSync(f.credentialFile).mode & 0o777).toBe(0o600);
    expect(existsSync(`${f.credentialFile}.login.json`)).toBe(false);
    expect(readFileSync(f.requests, "utf8")).toContain(
      "GET /open-apis/authen/v1/user_info",
    );
    expect(
      await createSubmissionHistoryReader({
        appId: "cli_test",
        appSecret: "app-secret-canary",
        sourceChatId: "oc_source",
        readerOpenId: "ou_reader",
        credentialFile: f.credentialFile,
        clock: () => 1791363605000,
        httpInstance: server.httpInstance,
      }).readSubmissionHistory({
        businessDate: "2026-10-07",
        sourceChatId: "oc_source",
        replyPolicy: "exclude",
      }),
    ).toMatchObject({ status: "complete" });
  } finally {
    await server.close();
    f.close();
  }
});

test("dangling credential links are rejected before contacting Lark", () => {
  const f = fixture();
  try {
    symlinkSync(join(f.directory, "missing.json"), f.credentialFile);
    const result = f.command("start");
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "blocked",
      reason: "credentials_already_exist",
    });
    expect(existsSync(f.requests)).toBe(false);
  } finally {
    f.close();
  }
});

test("login refuses write permissions before requesting consent", () => {
  const f = fixture();
  try {
    const result = f.command("start", {
      LARK_OAUTH_SCOPES: "im:message:send_as_user",
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "blocked",
      reason: "invalid_configuration",
    });
    expect(existsSync(f.requests)).toBe(false);
  } finally {
    f.close();
  }
});

test("unsafe provider lifetimes cannot create an unusable credential file", () => {
  const f = fixture();
  try {
    expect(f.command("start").status).toBe(0);
    const result = f.command("finish", { OAUTH_TEST_MODE: "bad_lifetime" });
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "blocked",
      reason: "credentials_invalid",
    });
    expect(existsSync(f.credentialFile)).toBe(false);
  } finally {
    f.close();
  }
});

test.each([
  ["denied", "access_denied"],
  ["wrong_reader", "credential_scope_mismatch"],
  ["missing_scope", "credentials_invalid"],
  ["dpop", "credentials_invalid"],
  ["disconnect", "authorization_failed"],
])(
  "a %s login cannot save credentials or replay a consumed session",
  (mode, reason) => {
    const f = fixture();
    try {
      expect(f.command("start").status).toBe(0);
      const result = f.command("finish", { OAUTH_TEST_MODE: mode });
      expect(JSON.parse(result.stdout)).toMatchObject({
        status: "blocked",
        reason,
      });
      expect(result.stdout + result.stderr).not.toContain("secret-canary");
      expect(existsSync(f.credentialFile)).toBe(false);
      const before = readFileSync(f.requests, "utf8");
      expect(JSON.parse(f.command("finish").stdout)).toMatchObject({
        status: "blocked",
        reason: "credentials_require_reauthorization",
      });
      expect(readFileSync(f.requests, "utf8")).toBe(before);
      expect(f.command("start").status).toBe(0);
    } finally {
      f.close();
    }
  },
);

test("expired sessions fail locally before polling", () => {
  const f = fixture();
  try {
    expect(f.command("start").status).toBe(0);
    const before = readFileSync(f.requests, "utf8");
    expect(
      JSON.parse(
        f.command("finish", { OAUTH_TEST_NOW: "1791363841000" }).stdout,
      ),
    ).toMatchObject({ status: "blocked", reason: "credentials_expired" });
    expect(readFileSync(f.requests, "utf8")).toBe(before);
  } finally {
    f.close();
  }
});

test("provider slow-down increases the polling interval without exposing codes", () => {
  const f = fixture();
  try {
    expect(f.command("start").status).toBe(0);
    const result = f.command("finish", { OAUTH_TEST_MODE: "slow_down" });
    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).not.toContain("secret-canary");
    const events = result.stderr
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "worker_login_completed",
        attemptCount: 2,
        durationMs: 7000,
        entryPoint: "worker_auth_finish",
        runId: expect.any(String),
      }),
    );
  } finally {
    f.close();
  }
});

test("existing credentials are never replaced by a new login", () => {
  const f = fixture();
  try {
    writeFileSync(f.credentialFile, "original-private-grant", { mode: 0o600 });
    expect(JSON.parse(f.command("start").stdout)).toMatchObject({
      status: "blocked",
      reason: "credentials_already_exist",
    });
    expect(readFileSync(f.credentialFile, "utf8")).toBe(
      "original-private-grant",
    );
    expect(existsSync(f.requests)).toBe(false);
  } finally {
    f.close();
  }
});

test("unsafe session storage is not read or sent to Lark", () => {
  const f = fixture();
  try {
    expect(f.command("start").status).toBe(0);
    chmodSync(`${f.credentialFile}.login.json`, 0o644);
    const before = readFileSync(f.requests, "utf8");
    expect(JSON.parse(f.command("finish").stdout)).toMatchObject({
      status: "blocked",
      reason: "credentials_storage_unsafe",
    });
    expect(readFileSync(f.requests, "utf8")).toBe(before);
  } finally {
    f.close();
  }
});

test("another credential owner blocks login without consuming its lock", () => {
  const f = fixture();
  try {
    writeFileSync(`${f.credentialFile}.lock`, "owner", { mode: 0o600 });
    const result = f.command("start");
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "blocked",
      reason: "credentials_refresh_busy",
    });
    expect(readFileSync(`${f.credentialFile}.lock`, "utf8")).toBe("owner");
    expect(existsSync(f.requests)).toBe(false);
  } finally {
    f.close();
  }
});

test("invalid logging configuration returns a safe command failure", () => {
  const f = fixture();
  try {
    const result = f.command("start", {
      LOG_LEVEL: "not-a-level-secret-canary",
    });
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "blocked",
      reason: "invalid_log_level",
    });
    expect(result.stdout + result.stderr).not.toContain("secret-canary");
    expect(existsSync(f.requests)).toBe(false);
  } finally {
    f.close();
  }
});

test("login refuses group-message access without the permission required by the history endpoint", () => {
  const f = fixture();
  try {
    const result = f.command("start", {
      LARK_OAUTH_SCOPES: "im:message.group_msg:get_as_user",
    });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "blocked",
      reason: "invalid_configuration",
    });
    expect(existsSync(f.requests)).toBe(false);
  } finally {
    f.close();
  }
});
