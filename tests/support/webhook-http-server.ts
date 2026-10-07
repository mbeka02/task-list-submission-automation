import { createServer } from "node:http";
import { vi } from "vitest";

/** Replace only Lark's HTTPS network boundary with real loopback HTTP and synthetic data. */
export async function webhookHttpServer(
  respond: () => {
    body?: unknown;
    rawBody?: string;
    status?: number;
    delayMs?: number;
    disconnect?: boolean;
    headers?: Record<string, string>;
  },
) {
  const requests: { path: string; method: string; body: unknown }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({
      path: request.url ?? "",
      method: request.method ?? "",
      body: JSON.parse(Buffer.concat(chunks).toString()),
    });
    const result = respond();
    if (result.disconnect) {
      request.socket.destroy();
      return;
    }
    if (result.delayMs)
      await new Promise((resolve) => setTimeout(resolve, result.delayMs));
    response.writeHead(result.status ?? 200, {
      "content-type": "application/json",
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
    (input: string | URL | Request, options?: RequestInit) => {
      const target = new URL(input instanceof Request ? input.url : input);
      if (target.origin !== "https://open.larksuite.com")
        throw new Error("Unexpected webhook host");
      return nativeFetch(
        `http://127.0.0.1:${address.port}${target.pathname}`,
        options,
      );
    },
  );
  return {
    requests,
    close: async () => {
      vi.unstubAllGlobals();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
