import { createOperationalLogger } from "../../src/observability.js";

/** Observe the real JSON sink, rather than mocking Pino methods or application collaborators. */
export function logCapture(level = "debug") {
  const lines: string[] = [];
  const logger = createOperationalLogger({
    level,
    destination: {
      write: (line) => {
        lines.push(line);
      },
    },
  });
  return {
    logger,
    text: () => lines.join(""),
    events: (): Record<string, unknown>[] =>
      lines.flatMap((line) =>
        line
          .trim()
          .split("\n")
          .map((item) => JSON.parse(item)),
      ),
  };
}
