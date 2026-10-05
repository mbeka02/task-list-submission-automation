import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { restoreReviewPath } from "./storage-recovery.js";

/** Accept only an intact ledger at this release's exact migration level; this command never migrates. */
function validateLedger(database: Database.Database) {
  try {
    const migrations = readMigrationFiles({
      migrationsFolder: fileURLToPath(new URL("../drizzle/", import.meta.url)),
    });
    const applied = database
      .prepare<[], { hash: string; created_at: number }>(
        "SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at",
      )
      .all();
    if (
      applied.length !== migrations.length ||
      applied.some(
        (row, index) =>
          row.hash !== migrations[index]?.hash ||
          row.created_at !== migrations[index]?.folderMillis,
      )
    )
      throw new Error();
    for (const table of [
      "message",
      "message_observation",
      "daily_delivery",
      "report_entry",
      "daily_brief",
      "brief_entry",
    ])
      database.prepare(`SELECT * FROM ${table} LIMIT 0`).all();
    const violations = database.pragma("foreign_key_check");
    if (
      database.pragma("integrity_check", { simple: true }) !== "ok" ||
      !Array.isArray(violations) ||
      violations.length !== 0
    )
      throw new Error();
  } catch {
    throw new Error("invalid_ledger");
  }
}

/** Flush directory entries as well as file contents before reporting durable publication. */
function syncDirectory(path: string) {
  const directory = openSync(path, "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

/** Refuse all existing destinations, including dangling symlinks, before creating restore metadata. */
function requireNewOutput(output: string, ownsRestoreMarker = false) {
  const paths = [output, `${output}-wal`, `${output}-shm`, `${output}-journal`];
  if (!ownsRestoreMarker) paths.push(restoreReviewPath(output));
  for (const path of paths) {
    try {
      lstatSync(path);
      throw new Error("output_exists");
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
  }
}

/** Publish a complete private snapshot atomically; a competing output is never replaced. */
async function snapshot(
  source: string,
  output: string,
  ownsRestoreMarker = false,
) {
  requireNewOutput(output, ownsRestoreMarker);
  if (!lstatSync(source).isFile()) throw new Error("invalid_source");
  const database = new Database(source, {
    readonly: true,
    fileMustExist: true,
  });
  let temporary: string | undefined;
  try {
    validateLedger(database);
    temporary = mkdtempSync(join(dirname(output), ".task-list-snapshot-"));
    const path = join(temporary, "snapshot.sqlite");
    await database.backup(path);
    const completed = new Database(path, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      validateLedger(completed);
    } finally {
      completed.close();
    }
    const file = openSync(path, "r");
    try {
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    // A hard link publishes only a completed file and cannot replace another process's output.
    requireNewOutput(output, ownsRestoreMarker);
    try {
      linkSync(path, output);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "EEXIST"
      )
        throw new Error("output_exists");
      throw error;
    }
    syncDirectory(dirname(output));
  } finally {
    database.close();
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}

/** Snapshot committed SQLite state through its online backup API, including live WAL writes. */
async function main() {
  const args = process.argv.slice(2);
  const backup =
    args.length === 3 && args[0] === "backup" && args[1] === "--output";
  const restore =
    args.length === 5 &&
    args[0] === "restore" &&
    args[1] === "--backup" &&
    args[3] === "--output";
  if (!backup && !restore) throw new Error("invalid_arguments");
  const source = restore ? args[2] : process.env.SQLITE_FILE_PATH;
  const output = restore ? args[4] : args[2];
  if (!source || !output) throw new Error("missing_storage_configuration");
  process.umask(0o077);
  if (restore) {
    requireNewOutput(output);
    const marker = restoreReviewPath(output);
    const file = openSync(marker, "wx", 0o600);
    try {
      writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          restoreReviewRequired: true,
          restoredAt: new Date().toISOString(),
        }),
      );
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    syncDirectory(dirname(output));
    try {
      await snapshot(source, output, true);
    } catch (error) {
      // A published restore must remain paused even if a later durability check failed.
      try {
        lstatSync(output);
      } catch (inspectionError) {
        if (
          typeof inspectionError === "object" &&
          inspectionError !== null &&
          "code" in inspectionError &&
          inspectionError.code === "ENOENT"
        )
          rmSync(marker);
      }
      throw error;
    }
    console.log(
      JSON.stringify({ status: "restored", restoreReviewRequired: true }),
    );
    return;
  }
  await snapshot(source, output);
  console.log(JSON.stringify({ status: "backed_up" }));
}

try {
  await main();
} catch (error) {
  const known = [
    "invalid_arguments",
    "missing_storage_configuration",
    "output_exists",
    "invalid_source",
    "invalid_ledger",
  ];
  console.log(
    JSON.stringify({
      status: "blocked",
      reason:
        error instanceof Error && known.includes(error.message)
          ? error.message
          : "storage_unavailable",
    }),
  );
  process.exitCode = 1;
}
