import { readFileSync } from "node:fs";
import {
  openReportLedger,
  type PrepareReportInput,
} from "../../src/report-ledger.js";

interface Fixture {
  databasePath: string;
  appId: string;
  sourceChatId: string;
  destinationChatId: string;
  now: number;
  action: "prepare" | "deliver";
  input: PrepareReportInput;
  deliveryId?: string;
  holdUuid?: boolean;
}
const fixture: Fixture = JSON.parse(process.argv[2] ?? "{}");
let uuidCalls = 0;
const ledger = openReportLedger({
  ...fixture,
  clock: () => fixture.now,
  newSendUuid: () => {
    uuidCalls++;
    if (fixture.holdUuid) {
      process.send?.({ event: "uuid" });
      readFileSync(0);
    }
    return "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
  },
  transport: async (request) => {
    process.send?.({ event: "request", request });
    await new Promise<void>((resolve) => {
      const listener = (message: unknown) => {
        if (message === "ack") {
          process.off("message", listener);
          resolve();
        }
      };
      process.on("message", listener);
    });
    return { messageId: "om_process_ack" };
  },
});
process.on("message", async (message: unknown) => {
  if (message !== "go") return;
  process.send?.({ event: "starting" });
  const result =
    fixture.action === "prepare"
      ? ledger.prepareDailyReport(fixture.input)
      : await ledger.deliverDelivery({
          deliveryId: fixture.deliveryId ?? "",
          now: fixture.now,
        });
  process.send?.({ event: "result", result, uuidCalls });
});
process.send?.({ event: "ready" });
