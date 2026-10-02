import { Client, Domain, LoggerLevel } from "@larksuiteoapi/node-sdk";
import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";

const sqlite = new Database(":memory:");
try {
  const mode = process.env.APP_MODE ?? "preview";
  if (mode !== "preview" && mode !== "test" && mode !== "production") {
    throw new Error("APP_MODE must be preview, test or production");
  }
  const outbound = process.env.ENABLE_OUTBOUND ?? "false";
  if (outbound !== "true" && outbound !== "false") {
    throw new Error("ENABLE_OUTBOUND must be true or false");
  }
  if (outbound === "true") {
    throw new Error(
      mode === "preview"
        ? "ENABLE_OUTBOUND must be false in preview mode"
        : "Outbound activation is disabled; keep ENABLE_OUTBOUND=false",
    );
  }
  const result = drizzle(sqlite).get<{ value: number }>(sql`select 1 as value`);
  if (result?.value !== 1) {
    throw new Error("SQLite compatibility check failed");
  }
  new Client({
    appId: "preflight-only",
    appSecret: "preflight-only",
    domain: Domain.Lark,
    loggerLevel: LoggerLevel.error,
  });
  console.log(
    JSON.stringify({
      mode,
      outboundEnabled: false,
      businessTimezone: "Africa/Nairobi",
      checks: { sqlite: "ok", larkSdk: "ok" },
    }),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : "Preflight failed");
  process.exitCode = 1;
} finally {
  sqlite.close();
}
