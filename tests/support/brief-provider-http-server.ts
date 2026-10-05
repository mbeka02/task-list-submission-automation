import { createServer } from "node:http";
import { vi } from "vitest";

/** Real HTTP fixtures for either provider; never forward synthetic credentials to a remote service. */
export async function briefProviderHttpServer(
  respond: () => {
    body?: unknown;
    rawBody?: string;
    status?: number;
    headers?: Record<string, string>;
    delayMs?: number;
    disconnect?: boolean;
  },
) {
  const requests: {
    path: string;
    method: string;
    authorization: string | undefined;
    body: unknown;
  }[] = [];
  const origins: string[] = [];
  const server = createServer(async (incoming, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    requests.push({
      path: incoming.url ?? "",
      method: incoming.method ?? "",
      authorization: incoming.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
    });
    const result = respond();
    if (result.disconnect) {
      incoming.socket.destroy();
      return;
    }
    if (result.delayMs)
      await new Promise((resolve) => setTimeout(resolve, result.delayMs));
    response.writeHead(result.status ?? 200, {
      "Content-Type": "application/json",
      ...result.headers,
    });
    response.end(result.rawBody ?? JSON.stringify(result.body));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture unavailable");
  const nativeFetch = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (
        ![
          "https://api.deepseek.com",
          "https://generativelanguage.googleapis.com",
        ].includes(url.origin)
      )
        throw new Error("Unexpected provider origin");
      origins.push(url.origin);
      return nativeFetch(
        `http://127.0.0.1:${address.port}${url.pathname}${url.search}`,
        init,
      );
    },
  );
  return {
    origin: `http://127.0.0.1:${address.port}`,
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
