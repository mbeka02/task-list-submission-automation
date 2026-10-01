import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

// Seed the previous migration's external storage format. All assertions stay
// through S3/S4 after upgrading, rather than querying current private tables.
export function createLegacyDatabase(path: string) {
  const original = fileURLToPath(new URL("../../drizzle/", import.meta.url));
  const folder = join(dirname(path), "legacy-migrations");
  mkdirSync(join(folder, "meta"), { recursive: true });
  const journal: { entries: { tag: string }[] } = JSON.parse(
    readFileSync(join(original, "meta", "_journal.json"), "utf8"),
  );
  const first = journal.entries[0];
  if (!first) throw new Error("Missing initial migration");
  copyFileSync(
    join(original, `${first.tag}.sql`),
    join(folder, `${first.tag}.sql`),
  );
  writeFileSync(
    join(folder, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries: [first] }),
  );
  const sqlite = new Database(path);
  try {
    migrate(drizzle(sqlite), { migrationsFolder: folder });
    sqlite.exec(`INSERT INTO daily_delivery (id, appId, businessDate, sourceChatId, destinationChatId, policyVersion, text, sendUuid, state)
      VALUES ('legacy-report', 'cli_test', '2026-10-01', 'oc_source', 'oc_destination', 'test-v0', '1 October 2026\n1. Anthony', 'cccccccc-3333-4333-8333-cccccccccccc', 'pending');
      INSERT INTO report_entry (deliveryId, position, payload) VALUES ('legacy-report', 0, '{"displayName":"Anthony","senderIdentity":{"appId":"cli_test","tenantKey":"tenant_external","openId":"ou_anthony"},"evidence":{"observationId":"legacy-obs","messageId":"legacy-msg"}}');`);
  } finally {
    sqlite.close();
  }
}
