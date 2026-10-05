import { createServer } from "node:http";
import { defaultHttpInstance } from "@larksuiteoapi/node-sdk";

export interface CapturedLarkRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  authorization: string | undefined;
  body?: unknown;
}

export async function larkHttpServer(
  respond: (request: CapturedLarkRequest) => {
    body: unknown;
    status?: number;
    delayMs?: number;
    disconnect?: boolean;
  },
) {
  const requests: CapturedLarkRequest[] = [];
  const origins: string[] = [];
  const server = createServer(async (incoming, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const url = new URL(incoming.url ?? "/", "http://localhost");
    const request = {
      method: incoming.method ?? "",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      authorization: incoming.headers.authorization,
      ...(rawBody ? { body: JSON.parse(rawBody) as unknown } : {}),
    };
    requests.push(request);
    try {
      const result = respond(request);
      if (result.disconnect) {
        incoming.socket.destroy();
        return;
      }
      if (result.delayMs)
        await new Promise((resolve) => setTimeout(resolve, result.delayMs));
      response.writeHead(result.status ?? 200, {
        "Content-Type": "application/json",
      });
      response.end(JSON.stringify(result.body));
    } catch {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ code: 1, msg: "Fixture response failed" }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Local HTTP server unavailable");
  const httpInstance = defaultHttpInstance.create({
    timeout: 1000,
    proxy: false,
  });
  httpInstance.interceptors.request.use((request) => {
    const target = new URL(request.url ?? "");
    origins.push(target.origin);
    if (
      target.origin !== "https://open.larksuite.com" &&
      target.origin !== "https://accounts.larksuite.com"
    )
      throw new Error("Unexpected SDK domain");
    request.url = `http://127.0.0.1:${address.port}${target.pathname}`;
    return request;
  });
  httpInstance.interceptors.response.use((response) => response.data);
  return {
    requests,
    origins,
    httpInstance,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
