import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const entrypoint = fileURLToPath(
  new URL("../../src/preflight.ts", import.meta.url),
);

test("preflight checks local dependencies in preview mode with sending disabled", () => {
  const output = execFileSync(
    process.execPath,
    ["--import", "tsx", entrypoint],
    {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: { PATH: process.env.PATH ?? "" },
      encoding: "utf8",
    },
  );

  expect(JSON.parse(output)).toMatchObject({
    mode: "preview",
    outboundEnabled: false,
    businessTimezone: "Africa/Nairobi",
    checks: { sqlite: "ok", larkSdk: "ok" },
  });
});

test("preflight rejects sending enabled in preview mode without exposing secrets", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    env: {
      PATH: process.env.PATH ?? "",
      APP_MODE: "preview",
      ENABLE_OUTBOUND: "true",
      LARK_APP_SECRET: "synthetic-secret-never-print",
    },
    encoding: "utf8",
  });

  expect(result.status).toBe(1);
  expect(result.stderr).toContain(
    "ENABLE_OUTBOUND must be false in preview mode",
  );
  expect(result.stdout + result.stderr).not.toContain(
    "synthetic-secret-never-print",
  );
});

test("preflight recognises test mode while keeping outbound delivery disabled", () => {
  const output = execFileSync(
    process.execPath,
    ["--import", "tsx", entrypoint],
    {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: { PATH: process.env.PATH ?? "", APP_MODE: "test" },
      encoding: "utf8",
    },
  );

  expect(JSON.parse(output)).toMatchObject({
    mode: "test",
    outboundEnabled: false,
  });
});

test("preflight rejects an unknown mode rather than silently accepting a typo", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    env: { PATH: process.env.PATH ?? "", APP_MODE: "prodution" },
    encoding: "utf8",
  });

  expect(result.status).toBe(1);
  expect(result.stderr).toContain(
    "APP_MODE must be preview, test or production",
  );
});

test("preflight rejects an ambiguous outbound setting", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    env: { PATH: process.env.PATH ?? "", ENABLE_OUTBOUND: "yes" },
    encoding: "utf8",
  });

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("ENABLE_OUTBOUND must be true or false");
});

test("preflight keeps outbound activation disabled after local implementation", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", entrypoint], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    env: {
      PATH: process.env.PATH ?? "",
      APP_MODE: "production",
      ENABLE_OUTBOUND: "true",
    },
    encoding: "utf8",
  });

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Outbound activation is disabled");
});
