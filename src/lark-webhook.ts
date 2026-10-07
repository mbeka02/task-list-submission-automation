import { createHash, createHmac } from "node:crypto";
import type { DeliveryTransport } from "./report-ledger.js";

/** A signed webhook is reviewed against one destination; the URL itself is a secret. */
export interface LarkWebhookOptions {
  appId: string;
  destinationChatId: string;
  webhookUrl: string;
  signingSecret: string;
  clock?: () => number;
  timeoutMs?: number;
}

/** One signed POST. A success receipt has no message ID and confers no duplicate suppression. */
export function createLarkWebhookTransport(
  options: LarkWebhookOptions,
): DeliveryTransport {
  try {
    const url = new URL(options.webhookUrl);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "open.larksuite.com" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]{16,128}$/.test(
        url.pathname,
      ) ||
      url.href !== options.webhookUrl ||
      !options.appId.trim() ||
      !/^oc_[A-Za-z0-9_]+$/.test(options.destinationChatId) ||
      !options.signingSecret.trim() ||
      !Number.isSafeInteger(options.timeoutMs ?? 15000) ||
      (options.timeoutMs ?? 15000) < 1 ||
      (options.timeoutMs ?? 15000) > 15000
    )
      throw new Error();
  } catch {
    throw new Error("invalid_webhook_configuration");
  }
  const clock = options.clock ?? Date.now;
  const send: DeliveryTransport = async (request) => {
    if (
      request.appId !== options.appId ||
      request.destinationChatId !== options.destinationChatId
    )
      return { status: "failed", reason: "outbound_scope_mismatch" };
    const currentMs = clock();
    if (!Number.isSafeInteger(currentMs) || currentMs < 0)
      return { status: "failed", reason: "invalid_delivery_time" };
    if (
      request.deliveryDeadlineMs !== undefined &&
      currentMs >= request.deliveryDeadlineMs
    )
      return { status: "failed", reason: "delivery_window_expired" };
    const timestamp = String(Math.floor(currentMs / 1000));
    // Lark signs an empty message using timestamp + newline + secret as the HMAC key.
    const sign = createHmac("sha256", `${timestamp}\n${options.signingSecret}`)
      .update("")
      .digest("base64");
    const payload = JSON.stringify({
      timestamp,
      sign,
      msg_type: "text",
      content: { text: request.text },
    });
    if (Buffer.byteLength(payload, "utf8") > 20_000)
      return { status: "failed", reason: "message_too_large" };
    const response = await fetch(options.webhookUrl, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? 15000),
      headers: { "content-type": "application/json" },
      body: payload,
    });
    // Bound streamed bytes as well as Content-Length; a POST may already have arrived.
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Webhook outcome unknown");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 65_536) throw new Error("Webhook outcome unknown");
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel();
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (
      (response.ok || response.status === 429) &&
      typeof body === "object" &&
      body !== null &&
      "code" in body &&
      body.code === 11232
    )
      return {
        status: "retryable",
        reason: "rate_limited",
        retryAfterMs: 30_000,
      };
    if (
      (response.ok || response.status === 400) &&
      typeof body === "object" &&
      body !== null &&
      "code" in body &&
      typeof body.code === "number" &&
      [19021, 19022, 19024, 9499].includes(body.code)
    )
      return { status: "failed", reason: "destination_denied" };
    if (
      !response.ok ||
      typeof body !== "object" ||
      body === null ||
      !("code" in body) ||
      body.code !== 0
    )
      throw new Error("Webhook outcome unknown");
    return { webhookAccepted: true };
  };
  send.kind = "lark_webhook";
  send.binding = createHash("sha256").update(options.webhookUrl).digest("hex");
  return send;
}
