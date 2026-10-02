import { lstatSync } from "node:fs";
import { openReportLedger } from "./report-ledger.js";

/** Local operator entrypoint: no SDK transport is constructed here. */
function run() {
  const [action, ...args] = process.argv.slice(2);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || !value?.trim() || values.has(name))
      throw new Error("invalid_arguments");
    values.set(name, value);
  }
  if (
    !values.has("--id") ||
    (action !== "status" && action !== "reconcile") ||
    (action === "status" && values.size !== 1) ||
    [...values.keys()].some(
      (key) =>
        ![
          "--id",
          "--decision",
          "--expected-attempt",
          "--operator",
          "--reason",
          "--message-id",
        ].includes(key),
    )
  )
    throw new Error("invalid_arguments");
  const databasePath = process.env.SQLITE_FILE_PATH;
  const appId = process.env.LARK_APP_ID;
  const sourceChatId = process.env.SOURCE_CHAT_ID;
  const destinationChatId = process.env.MANAGEMENT_CHAT_ID;
  if (
    !databasePath?.trim() ||
    !appId?.trim() ||
    !sourceChatId?.trim() ||
    !destinationChatId?.trim()
  )
    throw new Error("missing_ledger_configuration");
  if (!lstatSync(databasePath).isFile()) throw new Error("ledger_unavailable");
  const ledger = openReportLedger({
    databasePath,
    appId,
    sourceChatId,
    destinationChatId,
    readOnly: action === "status",
  });
  try {
    if (action === "reconcile") {
      const decision = values.get("--decision");
      const expected = values.get("--expected-attempt");
      if (
        (decision !== "sent" && decision !== "not-sent") ||
        !expected ||
        !/^[1-9]\d*$/.test(expected)
      )
        throw new Error("invalid_arguments");
      const messageId = values.get("--message-id");
      return ledger.reconcileDelivery({
        deliveryId: values.get("--id") ?? "",
        now: Date.now(),
        decision,
        expectedAttempt: Number(expected),
        operator: values.get("--operator") ?? "",
        reason: values.get("--reason") ?? "",
        ...(messageId === undefined ? {} : { messageId }),
      });
    }
    const delivery = ledger.getDelivery(values.get("--id") ?? "");
    if (!delivery) throw new Error("delivery_not_found");
    return {
      status: "ok",
      delivery: {
        id: delivery.id,
        businessDate: delivery.businessDate,
        kind: delivery.kind,
        revision: delivery.revision,
        state: delivery.state,
        attemptCount: delivery.attemptCount,
        firstAttemptMs: delivery.firstAttemptMs,
        nextAttemptMs: delivery.nextAttemptMs,
        claimExpiresMs: delivery.claimExpiresMs,
        messageId: delivery.messageId,
        lastError: delivery.lastError,
        adapterKind: delivery.adapterKind,
        reconciliations: delivery.reconciliations,
        uncertainReplayUntilMs:
          delivery.adapterKind === "lark_app_api" &&
          delivery.firstAttemptMs !== null
            ? delivery.firstAttemptMs + 55 * 60_000
            : null,
        reconciliationRequired:
          delivery.state === "failed" ||
          (delivery.state === "uncertain" &&
            (delivery.adapterKind !== "lark_app_api" ||
              delivery.firstAttemptMs === null ||
              Date.now() >= delivery.firstAttemptMs + 55 * 60_000 ||
              delivery.nextAttemptMs === null)) ||
          (delivery.state === "sending" &&
            delivery.claimExpiresMs !== null &&
            Date.now() >= delivery.claimExpiresMs),
      },
    };
  } finally {
    ledger.close();
  }
}
try {
  const result = run();
  console.log(JSON.stringify(result));
  if (result.status === "blocked") process.exitCode = 1;
} catch (error) {
  const known = [
    "invalid_arguments",
    "missing_ledger_configuration",
    "delivery_not_found",
    "ledger_unavailable",
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
