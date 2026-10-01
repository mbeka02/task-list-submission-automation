import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type {
  OutboundReport,
  openReportLedger,
} from "../../src/report-ledger.js";

interface Event {
  event: string;
  result?:
    | ReturnType<ReturnType<typeof openReportLedger>["prepareDailyReport"]>
    | Awaited<
        ReturnType<ReturnType<typeof openReportLedger>["deliverDelivery"]>
      >;
  uuidCalls?: number;
  request?: OutboundReport;
}
export function ledgerProcess(fixture: object) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL("./ledger-process.ts", import.meta.url)),
      JSON.stringify(fixture),
    ],
    { stdio: ["pipe", "pipe", "pipe", "ipc"] },
  );
  const events: Event[] = [];
  let diagnostics = "";
  child.stderr?.on("data", (data) => {
    diagnostics += data.toString();
  });
  child.on("message", (event: Event) => {
    events.push(event);
  });
  function next(name: string): Promise<Event> {
    const found = events.findIndex((event) => event.event === name);
    if (found >= 0) {
      const event = events.splice(found, 1)[0];
      if (event) return Promise.resolve(event);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Child timed out at ${name}: ${diagnostics}`));
      }, 10_000);
      const listener = (event: Event) => {
        if (event.event === name) {
          const index = events.indexOf(event);
          if (index >= 0) events.splice(index, 1);
          cleanup();
          resolve(event);
        }
      };
      const failed = () => {
        cleanup();
        reject(new Error(`Child exited at ${name}: ${diagnostics}`));
      };
      function cleanup() {
        clearTimeout(timer);
        child.off("message", listener);
        child.off("exit", failed);
      }
      child.on("message", listener);
      child.on("exit", failed);
    });
  }
  return {
    next,
    go: () => child.send("go"),
    acknowledge: () => child.send("ack"),
    releaseUuid: () => child.stdin?.end(),
    close: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) =>
        child.once("exit", () => resolve()),
      );
      child.kill();
      await exited;
    },
  };
}
