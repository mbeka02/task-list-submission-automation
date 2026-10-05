import { createServer } from "node:http";
import { vi } from "vitest";

/** A real local HTTP endpoint behind the real SDK; only Google's transport destination is redirected. */
export async function geminiHttpServer(
  respond: () => {
    body: unknown;
    status?: number;
    headers?: Record<string, string>;
    delayMs?: number;
  },
) {
  const requests: {
    method: string;
    path: string;
    apiKey: string | undefined;
    body: unknown;
  }[] = [];
  const origins: string[] = [];
  const server = createServer(async (incoming, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    requests.push({
      method: incoming.method ?? "",
      path: incoming.url ?? "",
      apiKey:
        typeof incoming.headers["x-goog-api-key"] === "string"
          ? incoming.headers["x-goog-api-key"]
          : undefined,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
    });
    const result = respond();
    if (result.delayMs)
      await new Promise((resolve) => setTimeout(resolve, result.delayMs));
    response.writeHead(result.status ?? 200, {
      "Content-Type": "application/json",
      ...result.headers,
    });
    response.end(JSON.stringify(result.body));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture unavailable");
  const originalFetch = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      origins.push(url.origin);
      if (url.origin !== "https://generativelanguage.googleapis.com")
        throw new Error("Unexpected Gemini origin");
      return originalFetch(
        `http://127.0.0.1:${address.port}${url.pathname}${url.search}`,
        init,
      );
    },
  );
  return {
    requests,
    origins,
    close: async () => {
      vi.unstubAllGlobals();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
