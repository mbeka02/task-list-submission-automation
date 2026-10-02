import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { AccessTokenError, type Client } from "@larksuiteoapi/node-sdk";
import type { UserAccessGrant } from "./submission-history.js";

interface SavedCredentials extends UserAccessGrant {
  version: 1;
  readerOpenId: string;
  state: "ready" | "requires_reauthorization" | "refreshing";
  refreshToken: string;
  refreshExpiresAtMs: number;
}

export class CredentialError extends Error {
  constructor(
    readonly reason:
      | "credentials_refresh_expired"
      | "credentials_revoked"
      | "credentials_require_reauthorization"
      | "credentials_refresh_uncertain"
      | "credentials_refresh_busy"
      | "credentials_storage_unsafe"
      | "credentials_timed_out",
  ) {
    super(reason);
  }
}

function valid(value: unknown): value is SavedCredentials {
  if (typeof value !== "object" || value === null) return false;
  return (
    "version" in value &&
    value.version === 1 &&
    "state" in value &&
    (value.state === "ready" ||
      value.state === "requires_reauthorization" ||
      value.state === "refreshing") &&
    "appId" in value &&
    typeof value.appId === "string" &&
    "readerOpenId" in value &&
    typeof value.readerOpenId === "string" &&
    "accessToken" in value &&
    typeof value.accessToken === "string" &&
    !!value.accessToken.trim() &&
    "expiresAtMs" in value &&
    Number.isSafeInteger(value.expiresAtMs) &&
    "refreshToken" in value &&
    typeof value.refreshToken === "string" &&
    !!value.refreshToken.trim() &&
    "refreshExpiresAtMs" in value &&
    Number.isSafeInteger(value.refreshExpiresAtMs)
  );
}

function save(path: string, value: SavedCredentials) {
  const pending = `${path}.pending-${randomUUID()}`;
  try {
    const file = openSync(pending, "wx", 0o600);
    try {
      writeFileSync(file, JSON.stringify(value));
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(pending, path);
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

export function fileUserAccessToken(options: {
  credentialFile: string;
  appId: string;
  readerOpenId: string;
  client: Client;
  clock: () => number;
}): () => Promise<UserAccessGrant> {
  return async () => {
    const directory = lstatSync(dirname(options.credentialFile));
    if (
      !directory.isDirectory() ||
      directory.uid !== process.getuid?.() ||
      (directory.mode & 0o077) !== 0
    )
      throw new CredentialError("credentials_storage_unsafe");
    const lockPath = `${options.credentialFile}.lock`;
    let lock: number;
    try {
      lock = openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "EEXIST"
      )
        throw new CredentialError("credentials_refresh_busy");
      throw error;
    }
    try {
      let descriptor: number;
      try {
        descriptor = openSync(
          options.credentialFile,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ELOOP"
        )
          throw new CredentialError("credentials_storage_unsafe");
        throw error;
      }
      let saved: unknown;
      try {
        const stats = fstatSync(descriptor);
        if (
          !stats.isFile() ||
          stats.uid !== process.getuid?.() ||
          (stats.mode & 0o077) !== 0 ||
          stats.size > 65536
        )
          throw new CredentialError("credentials_storage_unsafe");
        saved = JSON.parse(readFileSync(descriptor, "utf8"));
      } finally {
        closeSync(descriptor);
      }
      if (
        !valid(saved) ||
        saved.appId !== options.appId ||
        saved.readerOpenId !== options.readerOpenId
      )
        throw new Error("Invalid worker credentials");
      if (saved.state !== "ready")
        throw new CredentialError("credentials_require_reauthorization");
      const startedAtMs = options.clock();
      if (saved.expiresAtMs > startedAtMs + 30_000) return saved;
      if (saved.refreshExpiresAtMs <= startedAtMs)
        throw new CredentialError("credentials_refresh_expired");
      // Commit intent before a rotating refresh key can be consumed by the provider.
      save(options.credentialFile, { ...saved, state: "refreshing" });
      try {
        const renewed = await options.client.accessToken.refresh({
          refreshToken: saved.refreshToken,
        });
        if (
          typeof renewed.accessToken !== "string" ||
          !renewed.accessToken.trim() ||
          typeof renewed.refreshToken !== "string" ||
          !renewed.refreshToken.trim() ||
          !Number.isSafeInteger(renewed.expiresIn) ||
          !renewed.expiresIn ||
          renewed.expiresIn < 0 ||
          !Number.isSafeInteger(renewed.refreshTokenExpiresIn) ||
          !renewed.refreshTokenExpiresIn ||
          renewed.refreshTokenExpiresIn < 0
        )
          throw new Error("Invalid renewal response");
        const replacement: SavedCredentials = {
          ...saved,
          state: "ready",
          accessToken: renewed.accessToken,
          expiresAtMs: startedAtMs + renewed.expiresIn * 1000,
          refreshToken: renewed.refreshToken,
          refreshExpiresAtMs:
            startedAtMs + renewed.refreshTokenExpiresIn * 1000,
        };
        if (!valid(replacement)) throw new Error("Invalid renewal response");
        save(options.credentialFile, replacement);
        return replacement;
      } catch (error) {
        if (
          error instanceof AccessTokenError &&
          error.error === "invalid_grant"
        ) {
          save(options.credentialFile, {
            ...saved,
            state: "requires_reauthorization",
          });
          throw new CredentialError("credentials_revoked");
        }
        throw new CredentialError("credentials_refresh_uncertain");
      }
    } finally {
      closeSync(lock);
      rmSync(lockPath);
    }
  };
}
