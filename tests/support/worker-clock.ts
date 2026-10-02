/** External clock fixture for process tests; production commands never read these settings. */
import { setTimeout as realTimeout } from "node:timers";

let fixedNow = Date.parse(
  process.env.WORKER_TEST_NOW ?? "2026-10-02T06:29:00.000Z",
);
Date.now = () => fixedNow;

// Advance a business minute when the real command schedules its default interval.
// The short wall delay coordinates the child process; it does not represent business time.
if (process.env.WORKER_TEST_ADVANCE_INTERVAL === "true") {
  Object.defineProperty(globalThis, "setTimeout", {
    value(
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) {
      return realTimeout(
        () => {
          if (delay === 60_000) fixedNow += 60_000;
          callback(...args);
        },
        delay === 60_000 ? 5 : delay,
      );
    },
  });
}
