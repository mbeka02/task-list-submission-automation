import { lstatSync, readFileSync } from "node:fs";
import { createDueWorker, type HolidayCalendar } from "./due-worker.js";

const reminderText =
  "Please post today's task list in this group by 10:00 AM Nairobi time.";

/** Require scope/configuration explicitly; never include a missing field's value in an error. */
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error("missing_worker_configuration");
  return value;
}

/** Check JSON shape before handing calendar dates/provenance to the worker's semantic validator. */
function calendarShape(value: unknown): value is HolidayCalendar {
  if (typeof value !== "object" || value === null) return false;
  return (
    "version" in value &&
    typeof value.version === "string" &&
    "fromDate" in value &&
    typeof value.fromDate === "string" &&
    "throughDate" in value &&
    typeof value.throughDate === "string" &&
    "reviewedOn" in value &&
    typeof value.reviewedOn === "string" &&
    "sourceUrls" in value &&
    Array.isArray(value.sourceUrls) &&
    value.sourceUrls.every((item) => typeof item === "string") &&
    "publicHolidays" in value &&
    Array.isArray(value.publicHolidays) &&
    value.publicHolidays.every((item) => typeof item === "string")
  );
}

/** Load a regular JSON file; parsing failures expose no local paths or document contents. */
function loadCalendar(path: string): HolidayCalendar {
  try {
    if (!lstatSync(path).isFile()) throw new Error();
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!calendarShape(value)) throw new Error();
    return value;
  } catch {
    throw new Error("invalid_calendar_file");
  }
}

/** Configure inspection or preview work; no outbound adapter is installed in this slice. */
function openWorker(inspect: boolean) {
  const appId = required("LARK_APP_ID");
  const sourceChatId = required("SOURCE_CHAT_ID");
  const restore = process.env.WORKER_RESTORE_MODE ?? "false";
  if (restore !== "true" && restore !== "false")
    throw new Error("invalid_worker_configuration");
  return createDueWorker({
    databasePath: required("SQLITE_FILE_PATH"),
    appId,
    sourceChatId,
    destinationChatId: required("MANAGEMENT_CHAT_ID"),
    activationDate: required("ACTIVATION_DATE"),
    calendar: loadCalendar(required("HOLIDAY_CALENDAR_PATH")),
    policy: {
      policyVersion: process.env.POLICY_VERSION ?? "task-list-v1",
      replyPolicy: "exclude",
    },
    reminderText,
    readOnly: inspect,
    restoreMode: restore === "true",
    reader: inspect
      ? {
          appId,
          sourceChatId,
          appSecret: "status-only",
          getUserAccessToken: async () => {
            throw new Error("inspection_only");
          },
        }
      : {
          appId,
          sourceChatId,
          appSecret: required("LARK_APP_SECRET"),
          readerOpenId: required("LARK_READER_OPEN_ID"),
          credentialFile: required("LARK_USER_CREDENTIAL_FILE"),
        },
  });
}

/** Run startup/periodic checks serially; shutdown waits for the active check before closing SQLite. */
async function main() {
  const mode = process.env.APP_MODE ?? "preview";
  if (!["preview", "test", "production"].includes(mode))
    throw new Error("invalid_worker_configuration");
  const outbound = process.env.ENABLE_OUTBOUND ?? "false";
  if (outbound !== "false")
    throw new Error(
      outbound === "true"
        ? "outbound_requires_activation"
        : "invalid_worker_configuration",
    );
  if ((process.env.BUSINESS_TIMEZONE ?? "Africa/Nairobi") !== "Africa/Nairobi")
    throw new Error("invalid_worker_configuration");
  const args = process.argv.slice(2);
  const inspect = args[0] === "status" && args.length === 1;
  const once = args[0] === "run" && args.length === 2 && args[1] === "--once";
  const continuous = args[0] === "run" && args.length === 1;
  if (!inspect && !once && !continuous) throw new Error("invalid_arguments");
  const interval = Number(process.env.WORKER_CHECK_INTERVAL_MS ?? 60_000);
  if (!Number.isSafeInteger(interval) || interval < 1000 || interval > 3600_000)
    throw new Error("invalid_worker_configuration");
  const worker = openWorker(inspect);
  let stopped = false;
  let cancelWait: (() => void) | null = null;
  /** Stop scheduling more work and release an idle wait; leave an active attempt to finish. */
  const stop = () => {
    stopped = true;
    cancelWait?.();
  };
  if (continuous) {
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  }
  try {
    let previous = "";
    do {
      const result = inspect
        ? worker.getStatus({ now: Date.now() })
        : await worker.runDueWork({ now: Date.now() });
      const rendered = JSON.stringify({ ...result, outboundEnabled: false });
      // Emit changed operator state, keeping unchanged minute checks quiet.
      if (rendered !== previous) console.log(rendered);
      previous = rendered;
      process.exitCode =
        result.status === "blocked" ||
        (!inspect &&
          result.status !== "paused" &&
          result.report.state === "blocked")
          ? 1
          : 0;
      if (!continuous || stopped) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, interval);
        cancelWait = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      cancelWait = null;
    } while (!stopped);
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    worker.close();
  }
}

try {
  await main();
} catch (error) {
  const known = [
    "invalid_arguments",
    "missing_worker_configuration",
    "invalid_calendar_file",
    "invalid_worker_configuration",
    "outbound_requires_activation",
  ];
  console.log(
    JSON.stringify({
      status: "blocked",
      reason:
        error instanceof Error && known.includes(error.message)
          ? error.message
          : "storage_unavailable",
      outboundEnabled: false,
    }),
  );
  process.exitCode = 1;
}
