import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

/** Seed the previously released storage format; assertions use public ledger methods after upgrade. */
export function createPreBriefDatabase(path: string) {
  const original = fileURLToPath(new URL("../../drizzle/", import.meta.url));
  const folder = join(dirname(path), "pre-brief-migrations");
  mkdirSync(join(folder, "meta"), { recursive: true });
  const journal: { entries: { idx: number; tag: string }[] } = JSON.parse(
    readFileSync(join(original, "meta", "_journal.json"), "utf8"),
  );
  const entries = journal.entries.filter((entry) => entry.idx <= 5);
  for (const entry of entries)
    copyFileSync(
      join(original, `${entry.tag}.sql`),
      join(folder, `${entry.tag}.sql`),
    );
  writeFileSync(
    join(folder, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries }),
  );
  const sqlite = new Database(path);
  try {
    migrate(drizzle(sqlite), { migrationsFolder: folder });
    sqlite.exec(`INSERT INTO daily_delivery (id, appId, businessDate, sourceChatId, destinationChatId, kind, policyVersion, text, sendUuid, state)
      VALUES ('previous-report', 'cli_test', '2026-10-01', 'oc_source', 'oc_management', 'report', 'policy-v1', '1 October 2026\n1. Alice', 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 'pending'),
      ('previous-reminder', 'cli_test', '2026-10-01', 'oc_source', 'oc_source', 'reminder', 'policy-v1', 'Please post your task list.', 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', 'pending');`);
  } finally {
    sqlite.close();
  }
}
