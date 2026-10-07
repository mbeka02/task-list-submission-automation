import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { Client, Domain, LoggerLevel } from "@larksuiteoapi/node-sdk";
import {
  createOperationalLogger,
  operationalEvent,
  withObservedRun,
} from "./observability.js";
import {
  CredentialError,
  fileUserAccessToken,
} from "./user-oauth-credentials.js";

/** Failures carry operator-safe categories; provider bodies and credential values never escape. */
class LoginError extends Error {}
function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new LoginError("missing_worker_configuration");
  return value;
}
/** One private session belongs to the configured app, reader and requested permissions. */
interface LoginSession {
  version: 1;
  appId: string;
  readerOpenId: string;
  scopes: string[];
  deviceCode: string;
  expiresAtMs: number;
  intervalMs: number;
  state: "awaiting" | "consuming";
}
function privateDirectory(path: string) {
  const info = lstatSync(dirname(path));
  if (
    !info.isDirectory() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  )
    throw new LoginError("credentials_storage_unsafe");
}
/** Open without following symlinks; bound untrusted local JSON before parsing it. */
function privateRead(path: string): unknown {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0 ||
      info.size > 65536
    )
      throw new LoginError("credentials_storage_unsafe");
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally {
    closeSync(fd);
  }
}
/** Commit private session state durably before a token request can consume the device code. */
function save(path: string, value: unknown, newOnly = false) {
  const pending = `${path}.pending-${randomUUID()}`;
  const fd = openSync(pending, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    if (newOnly) linkSync(pending, path);
    else renameSync(pending, path);
    const directory = openSync(dirname(path), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    rmSync(pending, { force: true });
  }
}
/** Fixed Lark device endpoint; neither secrets nor response bodies enter diagnostics. */
async function request(
  path: string,
  form: URLSearchParams,
  authorization?: string,
  expiresAtMs = Date.now() + 15000,
) {
  try {
    const response = await fetch(`https://accounts.larksuite.com${path}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(
        Math.max(1, Math.min(15000, expiresAtMs - Date.now())),
      ),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(authorization ? { authorization } : {}),
      },
      body: form,
    });
    const text = await response.text();
    if (text.length > 65536) throw new LoginError("invalid_response");
    const body: unknown = JSON.parse(text);
    if (typeof body !== "object" || body === null || Array.isArray(body))
      throw new LoginError("invalid_response");
    return { status: response.status, body: body as Record<string, unknown> };
  } catch (error) {
    if (error instanceof LoginError) throw error;
    throw new LoginError("authorization_failed");
  }
}
function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
/** Resume only a matching, untouched session; lost/uncertain token issuance is never replayed. */
function session(
  value: unknown,
  appId: string,
  readerOpenId: string,
  scopes: string[],
): LoginSession {
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== 1 ||
    !("appId" in value) ||
    value.appId !== appId ||
    !("readerOpenId" in value) ||
    value.readerOpenId !== readerOpenId ||
    !("scopes" in value) ||
    JSON.stringify(value.scopes) !== JSON.stringify(scopes) ||
    !("deviceCode" in value) ||
    !nonempty(value.deviceCode) ||
    !("expiresAtMs" in value) ||
    !positive(value.expiresAtMs) ||
    !("intervalMs" in value) ||
    !positive(value.intervalMs) ||
    !("state" in value) ||
    value.state !== "awaiting"
  )
    throw new LoginError("credentials_require_reauthorization");
  return value as LoginSession;
}
/** Exchange at the provider's cadence, then publish a verified grant without replacing any existing one. */
async function finish(
  file: string,
  appId: string,
  appSecret: string,
  readerOpenId: string,
  scopes: string[],
) {
  const loginPath = `${file}.login.json`;
  const saved = session(privateRead(loginPath), appId, readerOpenId, scopes);
  const started = Date.now();
  let interval = saved.intervalMs;
  let attempt = 0;
  while (true) {
    if (Date.now() + interval >= saved.expiresAtMs)
      throw new LoginError("credentials_expired");
    await new Promise((resolve) => setTimeout(resolve, interval));
    if (Date.now() >= saved.expiresAtMs)
      throw new LoginError("credentials_expired");
    const issuedAt = Date.now();
    save(loginPath, { ...saved, state: "consuming" });
    const result = await request(
      "/oauth/v3/token",
      new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: saved.deviceCode,
        client_id: appId,
        client_secret: appSecret,
      }),
      undefined,
      saved.expiresAtMs,
    );
    attempt++;
    const body = result.body;
    if (
      result.status === 400 &&
      (body.error === "authorization_pending" || body.error === "slow_down")
    ) {
      if (body.error === "slow_down") interval += 5000;
      save(loginPath, { ...saved, intervalMs: interval });
      continue;
    }
    if (body.error === "access_denied") throw new LoginError("access_denied");
    if (body.error === "expired_token" || body.error === "invalid_grant")
      throw new LoginError("credentials_expired");
    if (
      result.status !== 200 ||
      typeof body.token_type !== "string" ||
      body.token_type.toLowerCase() !== "bearer" ||
      !nonempty(body.access_token) ||
      !nonempty(body.refresh_token) ||
      !positive(body.expires_in) ||
      !positive(body.refresh_token_expires_in) ||
      !nonempty(body.scope) ||
      !scopes.every((scope) =>
        (body.scope as string).split(/\s+/).includes(scope),
      )
    )
      throw new LoginError("credentials_invalid");
    if (
      !Number.isSafeInteger(issuedAt + body.expires_in * 1000) ||
      !Number.isSafeInteger(issuedAt + body.refresh_token_expires_in * 1000)
    )
      throw new LoginError("credentials_invalid");
    if (Date.now() >= saved.expiresAtMs)
      throw new LoginError("credentials_expired");
    let identity: unknown;
    try {
      const response = await fetch(
        "https://open.larksuite.com/open-apis/authen/v1/user_info",
        {
          headers: { authorization: `Bearer ${body.access_token}` },
          redirect: "error",
          signal: AbortSignal.timeout(
            Math.max(1, Math.min(15000, saved.expiresAtMs - Date.now())),
          ),
        },
      );
      if (response.status !== 200) throw new Error();
      identity = await response.json();
    } catch {
      throw new LoginError("authorization_failed");
    }
    if (
      typeof identity !== "object" ||
      identity === null ||
      !("code" in identity) ||
      identity.code !== 0 ||
      !("data" in identity) ||
      typeof identity.data !== "object" ||
      identity.data === null ||
      !("open_id" in identity.data) ||
      identity.data.open_id !== readerOpenId
    )
      throw new LoginError("credential_scope_mismatch");
    if (
      Date.now() >= saved.expiresAtMs ||
      Date.now() >= issuedAt + body.expires_in * 1000
    )
      throw new LoginError("credentials_expired");
    save(
      file,
      {
        version: 1,
        state: "ready",
        appId,
        readerOpenId,
        accessToken: body.access_token,
        expiresAtMs: issuedAt + body.expires_in * 1000,
        refreshToken: body.refresh_token,
        refreshExpiresAtMs: issuedAt + body.refresh_token_expires_in * 1000,
      },
      true,
    );
    rmSync(loginPath);
    operationalEvent("info", "worker_login_completed", {
      status: "ready",
      attemptCount: attempt,
      durationMs: Date.now() - started,
    });
    console.log(JSON.stringify({ status: "ready", readerOpenId }));
    return;
  }
}
async function main() {
  if (
    process.argv.length !== 3 ||
    !["start", "finish", "refresh"].includes(process.argv[2] ?? "")
  )
    throw new LoginError("invalid_arguments");
  const appId = required("LARK_APP_ID");
  const appSecret = required("LARK_APP_SECRET");
  const readerOpenId = required("LARK_READER_OPEN_ID");
  const file = required("LARK_USER_CREDENTIAL_FILE");
  if (process.argv[2] === "refresh") {
    const started = Date.now();
    const silent = () => {};
    const client = new Client({
      appId,
      appSecret,
      domain: Domain.Lark,
      disableTokenCache: true,
      loggerLevel: LoggerLevel.error,
      logger: {
        error: silent,
        warn: silent,
        info: silent,
        debug: silent,
        trace: silent,
      },
    });
    try {
      await fileUserAccessToken({
        credentialFile: file,
        appId,
        readerOpenId,
        client,
        clock: Date.now,
        forceRefresh: true,
      })();
    } catch (error) {
      throw new LoginError(
        error instanceof CredentialError ? error.reason : "credentials_invalid",
      );
    }
    operationalEvent("info", "worker_credentials_refreshed", {
      status: "ready",
      durationMs: Date.now() - started,
    });
    console.log(JSON.stringify({ status: "ready", readerOpenId }));
    return;
  }
  const scopes = [
    ...new Set([
      ...required("LARK_OAUTH_SCOPES").split(/\s+/),
      "offline_access",
    ]),
  ].sort();
  const docStrategy = process.env.LARK_DOC_AUTH_STRATEGY ?? "app";
  if (!["app", "user_oauth"].includes(docStrategy))
    throw new LoginError("invalid_configuration");
  const docScopes = [
    "docx:document",
    "docs:permission.member:retrieve",
    "docs:permission.member:create",
    "docs:permission.setting:read",
    "docs:permission.setting:write_only",
  ];
  const allowedScopes = new Set([
    ...(docStrategy === "user_oauth" ? docScopes : []),
    "offline_access",
    "im:message:readonly",
    "im:message.group_msg:get_as_user",
    "im:chat:read",
    "contact:user.base:readonly",
  ]);
  if (
    scopes.some((scope) => !allowedScopes.has(scope)) ||
    (docStrategy === "user_oauth" &&
      !docScopes.every((scope) => scopes.includes(scope))) ||
    !scopes.includes("im:message:readonly")
  )
    throw new LoginError("invalid_configuration");
  privateDirectory(file);
  try {
    lstatSync(file);
    throw new LoginError("credentials_already_exist");
  } catch (error) {
    if (
      !(
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      )
    )
      throw error;
  }
  let lock: number;
  try {
    lock = openSync(`${file}.lock`, "wx", 0o600);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EEXIST"
    )
      throw new LoginError("credentials_refresh_busy");
    throw error;
  }
  try {
    if (process.argv[2] === "finish") {
      await finish(file, appId, appSecret, readerOpenId, scopes);
      return;
    }
    const startedAtMs = Date.now();
    const result = await request(
      "/oauth/v1/device_authorization",
      new URLSearchParams({ client_id: appId, scope: scopes.join(" ") }),
      `Basic ${Buffer.from(`${appId}:${appSecret}`).toString("base64")}`,
    );
    const body = result.body;
    if (
      result.status !== 200 ||
      !nonempty(body.device_code) ||
      !nonempty(body.user_code) ||
      !positive(body.expires_in) ||
      !positive(body.interval)
    )
      throw new LoginError("invalid_response");
    const verificationUrl =
      body.verification_uri_complete ?? body.verification_uri;
    if (!nonempty(verificationUrl)) throw new LoginError("invalid_response");
    const url = new URL(verificationUrl);
    if (
      url.origin !== "https://accounts.larksuite.com" ||
      url.username ||
      url.password
    )
      throw new LoginError("invalid_response");
    const expiresAtMs = startedAtMs + body.expires_in * 1000;
    if (
      !Number.isSafeInteger(expiresAtMs) ||
      !Number.isSafeInteger(body.interval * 1000) ||
      Date.now() >= expiresAtMs
    )
      throw new LoginError("invalid_response");
    save(`${file}.login.json`, {
      version: 1,
      appId,
      readerOpenId,
      scopes,
      deviceCode: body.device_code,
      expiresAtMs,
      intervalMs: body.interval * 1000,
      state: "awaiting",
    } satisfies LoginSession);
    operationalEvent("info", "worker_login_started", {
      durationMs: Date.now() - startedAtMs,
      status: "pending",
    });
    console.log(
      JSON.stringify({
        status: "authorization_pending",
        verificationUrl,
        userCode: body.user_code,
        expiresAtMs,
      }),
    );
  } finally {
    closeSync(lock);
    rmSync(`${file}.lock`);
  }
}
try {
  const logger = createOperationalLogger({
    level: process.env.LOG_LEVEL ?? "info",
  });
  await withObservedRun(
    { logger },
    process.argv[2] === "refresh"
      ? "worker_auth_refresh"
      : process.argv[2] === "finish"
        ? "worker_auth_finish"
        : "worker_auth_start",
    async () => {
      try {
        await main();
      } catch (error) {
        const reason =
          error instanceof LoginError
            ? error.message
            : "credentials_storage_unsafe";
        operationalEvent("warn", "worker_login_failed", {
          reason,
          status: "blocked",
        });
        console.log(JSON.stringify({ status: "blocked", reason }));
        process.exitCode = 1;
      }
    },
  );
} catch {
  console.log(
    JSON.stringify({ status: "blocked", reason: "invalid_log_level" }),
  );
  process.exitCode = 1;
}
