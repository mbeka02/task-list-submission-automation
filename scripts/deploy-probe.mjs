// Validate the actual built status command against disposable SQLite, without
// opening the live ledger, using OAuth, running due work or migrating live data.
import { openReportLedger } from "./dist/report-ledger.js";

process.env.SQLITE_FILE_PATH = "/tmp/deployment-validation.sqlite";
const ledger = openReportLedger({
  databasePath: process.env.SQLITE_FILE_PATH,
  appId: process.env.LARK_APP_ID ?? "",
  sourceChatId: process.env.SOURCE_CHAT_ID ?? "",
  destinationChatId: process.env.MANAGEMENT_CHAT_ID ?? "",
});
ledger.close();
process.argv = [process.execPath, "dist/worker-command.js", "status"];
await import("./dist/worker-command.js");
