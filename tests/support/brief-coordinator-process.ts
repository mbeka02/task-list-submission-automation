import { openBriefCoordinator } from "../../src/brief-coordinator.js";
import { createBriefGenerator } from "../../src/brief-generator-factory.js";

/** Child-process crash fixture. Redirect only official provider calls to the parent's local HTTP server. */
const { origin, now, ...options } = JSON.parse(process.argv[2] ?? "{}");
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin))
  throw new Error("Unsafe fixture origin");
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (
    ![
      "https://generativelanguage.googleapis.com",
      "https://api.deepseek.com",
    ].includes(url.origin)
  )
    throw new Error("Unexpected provider origin");
  return nativeFetch(`${origin}${url.pathname}${url.search}`, init);
};
const worker = openBriefCoordinator({
  ...options,
  clock: () => now,
  generator: createBriefGenerator({
    provider: options.provider,
    apiKey: "synthetic-key",
    model: options.model,
  }),
});
try {
  console.log(
    JSON.stringify(
      await worker.completeDailyBrief({ briefId: options.briefId, now }),
    ),
  );
} finally {
  worker.close();
}
