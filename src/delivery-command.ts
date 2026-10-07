import { lstatSync } from "node:fs";
import { openReportLedger } from "./report-ledger.js";
import { configuredReportRecipient, recipientKey } from "./report-recipient.js";

/**
 * Inspect delivery state or record a reviewed outcome in the configured ledger.
 * This command constructs no transport: even a not-sent decision cannot send a message.
 */
function run() {
  const [action, ...args] = process.argv.slice(2);
  const values = new Map<string, string>();
  // Accept explicit flag/value pairs; duplicates or missing values would make a review ambiguous.
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
  // Bind recovery to the configured app and groups; a delivery ID alone grants no access.
  const databasePath = process.env.SQLITE_FILE_PATH;
  const appId = process.env.LARK_APP_ID;
  const sourceChatId = process.env.SOURCE_CHAT_ID;
  const destinationChatId = recipientKey(
    configuredReportRecipient(process.env),
  );
  if (
    !databasePath?.trim() ||
    !appId?.trim() ||
    !sourceChatId?.trim() ||
    !destinationChatId?.trim()
  )
    throw new Error("missing_ledger_configuration");
  // Require an existing regular file so recovery cannot silently create a new, empty ledger.
  if (!lstatSync(databasePath).isFile()) throw new Error("ledger_unavailable");
  const scope = {
    databasePath,
    appId,
    sourceChatId,
    readOnly: action === "status",
  };
  const destinations = new Set([destinationChatId, sourceChatId]);
  const opened: ReturnType<typeof openReportLedger>[] = [];
  try {
    /** Resolve IDs only in the configured report/reminder scopes, never an arbitrary destination. */
    function findDelivery() {
      for (const destination of destinations) {
        const ledger = openReportLedger({
          ...scope,
          destinationChatId: destination,
        });
        opened.push(ledger);
        const delivery = ledger.getDelivery(values.get("--id") ?? "");
        if (
          delivery &&
          ((["report", "brief"].includes(delivery.kind) &&
            destination === destinationChatId) ||
            (delivery.kind === "reminder" && destination === sourceChatId))
        )
          return { ledger, delivery };
      }
      return null;
    }
    const selected = findDelivery();
    if (!selected) throw new Error("delivery_not_found");
    const { ledger, delivery } = selected;
    if (action === "reconcile") {
      const decision = values.get("--decision");
      const expected = values.get("--expected-attempt");
      if (
        (decision !== "sent" && decision !== "not-sent") ||
        !expected ||
        !/^[1-9]\d*$/.test(expected)
      )
        throw new Error("invalid_arguments");
      // The expected attempt prevents a decision based on stale status from resolving a newer send.
      // The ledger validates the evidence and saves the decision and audit record together.
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
    // Status omits report content and source evidence; reading it never advances delivery state.
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
        // An uncertain send can be replayed only within the stored adapter's UUID safety window.
        uncertainReplayUntilMs:
          delivery.adapterKind === "lark_app_api" &&
          delivery.firstAttemptMs !== null
            ? delivery.firstAttemptMs + 55 * 60_000
            : null,
        // Expired claims are unknown outcomes, not proof that no message reached Lark.
        reconciliationRequired:
          delivery.state === "failed" ||
          (delivery.state === "uncertain" &&
            (delivery.adapterKind !== "lark_app_api" ||
              delivery.firstAttemptMs === null ||
              Date.now() >= delivery.firstAttemptMs + 55 * 60_000 ||
              (delivery.kind === "reminder" &&
                Date.now() >=
                  Date.parse(`${delivery.businessDate}T10:00:00.000+03:00`)) ||
              delivery.nextAttemptMs === null)) ||
          (delivery.state === "sending" &&
            delivery.claimExpiresMs !== null &&
            Date.now() >= delivery.claimExpiresMs),
      },
    };
  } finally {
    for (const ledger of opened) ledger.close();
  }
}
try {
  const result = run();
  console.log(JSON.stringify(result));
  if (result.status === "blocked") process.exitCode = 1;
} catch (error) {
  // Expose stable operator reasons, never raw storage errors or configuration values.
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
