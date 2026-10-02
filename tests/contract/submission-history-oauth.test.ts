import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createSubmissionHistoryReader } from "../../src/submission-history.js";
import { larkHttpServer } from "../support/lark-http-server.js";

const now = 1790924460000;
const config = {
  appId: "cli_test",
  appSecret: "synthetic-app-secret",
  sourceChatId: "oc_source",
  readerOpenId: "ou_owner",
};
const input = {
  businessDate: "2026-10-02",
  sourceChatId: "oc_source",
  replyPolicy: "exclude",
} as const;
const credentials = {
  version: 1,
  state: "ready",
  appId: "cli_test",
  readerOpenId: "ou_owner",
  accessToken: "expired-access",
  expiresAtMs: now - 1,
  refreshToken: "initial-refresh",
  refreshExpiresAtMs: now + 86400000,
};

test.each(["readable by other users", "symbolic link"])(
  "unsafe credential storage is rejected before any request: %s",
  async (kind) => {
    const directory = mkdtempSync(join(tmpdir(), "task-list-oauth-"));
    const credentialFile = join(directory, "user-oauth.json");
    if (kind === "symbolic link") {
      const target = join(directory, "target.json");
      writeFileSync(target, JSON.stringify(credentials), { mode: 0o600 });
      symlinkSync(target, credentialFile);
    } else
      writeFileSync(credentialFile, JSON.stringify(credentials), {
        mode: 0o644,
      });
    const server = await larkHttpServer(() => ({ body: {} }));
    try {
      expect(
        await createSubmissionHistoryReader({
          ...config,
          credentialFile,
          httpInstance: server.httpInstance,
          clock: () => now,
        }).readSubmissionHistory(input),
      ).toMatchObject({
        status: "unavailable",
        reason: "credentials_storage_unsafe",
      });
      expect(server.requests).toEqual([]);
    } finally {
      await server.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("competing readers cannot consume the same refresh key", async () => {
  const directory = mkdtempSync(join(tmpdir(), "task-list-oauth-"));
  const credentialFile = join(directory, "user-oauth.json");
  writeFileSync(credentialFile, JSON.stringify(credentials), { mode: 0o600 });
  const server = await larkHttpServer((incoming) => ({
    body:
      incoming.method === "POST"
        ? {
            access_token: "new-access",
            expires_in: 3600,
            refresh_token: "new-refresh",
            refresh_token_expires_in: 86400,
          }
        : { code: 0, data: { has_more: false, items: [] } },
  }));
  const options = {
    ...config,
    credentialFile,
    httpInstance: server.httpInstance,
    clock: () => now,
  };
  try {
    const [first, competing] = await Promise.all([
      createSubmissionHistoryReader(options).readSubmissionHistory(input),
      createSubmissionHistoryReader(options).readSubmissionHistory(input),
    ]);
    expect(first).toMatchObject({ status: "complete" });
    expect(competing).toMatchObject({
      status: "unavailable",
      reason: "credentials_refresh_busy",
    });
    expect(server.requests.map((value) => value.method)).toEqual([
      "POST",
      "GET",
    ]);
    expect(
      await createSubmissionHistoryReader(options).readSubmissionHistory(input),
    ).toMatchObject({ status: "complete" });
    expect(server.requests.map((value) => value.method)).toEqual([
      "POST",
      "GET",
      "GET",
    ]);
  } finally {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test.each([
  {},
  {
    access_token: "new-access",
    expires_in: 3600,
    refresh_token_expires_in: 86400,
  },
  {
    access_token: "new-access",
    refresh_token: "new-refresh",
    expires_in: -1,
    refresh_token_expires_in: 86400,
  },
  {
    access_token: "new-access",
    refresh_token: "new-refresh",
    expires_in: 3600,
    refresh_token_expires_in: 0,
  },
])(
  "an uncertain or invalid renewal cannot replay the old refresh key after restart (%j)",
  async (body) => {
    const directory = mkdtempSync(join(tmpdir(), "task-list-oauth-"));
    const credentialFile = join(directory, "user-oauth.json");
    writeFileSync(credentialFile, JSON.stringify(credentials), { mode: 0o600 });
    const server = await larkHttpServer(() => ({ body }));
    const options = {
      ...config,
      credentialFile,
      httpInstance: server.httpInstance,
      clock: () => now,
    };
    try {
      expect(
        await createSubmissionHistoryReader(options).readSubmissionHistory(
          input,
        ),
      ).toMatchObject({
        status: "unavailable",
        reason: "credentials_refresh_uncertain",
      });
      expect(
        await createSubmissionHistoryReader(options).readSubmissionHistory(
          input,
        ),
      ).toMatchObject({
        status: "unavailable",
        reason: "credentials_require_reauthorization",
      });
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("revoked authorization is remembered across reader restarts without exposing provider text", async () => {
  const directory = mkdtempSync(join(tmpdir(), "task-list-oauth-"));
  const credentialFile = join(directory, "user-oauth.json");
  writeFileSync(credentialFile, JSON.stringify(credentials), { mode: 0o600 });
  const server = await larkHttpServer(() => ({
    status: 400,
    body: {
      error: "invalid_grant",
      error_description: "initial-refresh synthetic-app-secret",
    },
  }));
  const options = {
    ...config,
    credentialFile,
    httpInstance: server.httpInstance,
    clock: () => now,
  };
  try {
    const first =
      await createSubmissionHistoryReader(options).readSubmissionHistory(input);
    expect(first).toMatchObject({
      status: "unavailable",
      reason: "credentials_revoked",
    });
    expect(JSON.stringify(first)).not.toContain("initial-refresh");
    expect(JSON.stringify(first)).not.toContain("synthetic-app-secret");
    expect(
      await createSubmissionHistoryReader(options).readSubmissionHistory(input),
    ).toMatchObject({
      status: "unavailable",
      reason: "credentials_require_reauthorization",
    });
    expect(server.requests).toHaveLength(1);
  } finally {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an expired refresh grant requires reauthorization without contacting Lark", async () => {
  const directory = mkdtempSync(join(tmpdir(), "task-list-oauth-"));
  const credentialFile = join(directory, "user-oauth.json");
  writeFileSync(
    credentialFile,
    JSON.stringify({ ...credentials, refreshExpiresAtMs: now }),
    { mode: 0o600 },
  );
  const server = await larkHttpServer(() => ({ body: {} }));
  try {
    const reader = createSubmissionHistoryReader({
      ...config,
      credentialFile,
      httpInstance: server.httpInstance,
      clock: () => now,
    });
    expect(await reader.readSubmissionHistory(input)).toMatchObject({
      status: "unavailable",
      reason: "credentials_refresh_expired",
    });
    expect(server.requests).toEqual([]);
  } finally {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("renewed user credentials survive reopening and the next renewal uses the rotated refresh key", async () => {
  const directory = mkdtempSync(join(tmpdir(), "task-list-oauth-"));
  const credentialFile = join(directory, "user-oauth.json");
  writeFileSync(credentialFile, JSON.stringify(credentials), { mode: 0o600 });
  let currentTime = now;
  let renewals = 0;
  const server = await larkHttpServer((incoming) => {
    if (incoming.path === "/oauth/v3/token") {
      renewals += 1;
      return {
        body: {
          access_token: `renewed-access-${renewals}`,
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: `renewed-refresh-${renewals}`,
          refresh_token_expires_in: 86400,
        },
      };
    }
    return { body: { code: 0, data: { has_more: false, items: [] } } };
  });
  const options = {
    ...config,
    credentialFile,
    httpInstance: server.httpInstance,
    clock: () => currentTime,
  };
  try {
    expect(
      await createSubmissionHistoryReader(options).readSubmissionHistory(input),
    ).toMatchObject({ status: "complete", messages: [] });
    expect(
      await createSubmissionHistoryReader(options).readSubmissionHistory(input),
    ).toMatchObject({ status: "complete" });
    currentTime = 1790931660000;
    expect(
      await createSubmissionHistoryReader(options).readSubmissionHistory(input),
    ).toMatchObject({ status: "complete" });
    expect(server.origins).toEqual([
      "https://accounts.larksuite.com",
      "https://open.larksuite.com",
      "https://open.larksuite.com",
      "https://accounts.larksuite.com",
      "https://open.larksuite.com",
    ]);
    expect(
      server.requests
        .filter((value) => value.method === "POST")
        .map((value) => ({ path: value.path, body: value.body })),
    ).toEqual([
      {
        path: "/oauth/v3/token",
        body: {
          client_id: "cli_test",
          client_secret: "synthetic-app-secret",
          grant_type: "refresh_token",
          refresh_token: "initial-refresh",
        },
      },
      {
        path: "/oauth/v3/token",
        body: {
          client_id: "cli_test",
          client_secret: "synthetic-app-secret",
          grant_type: "refresh_token",
          refresh_token: "renewed-refresh-1",
        },
      },
    ]);
    expect(
      server.requests
        .filter((value) => value.method === "GET")
        .map((value) => value.authorization),
    ).toEqual([
      "Bearer renewed-access-1",
      "Bearer renewed-access-1",
      "Bearer renewed-access-2",
    ]);
  } finally {
    await server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
