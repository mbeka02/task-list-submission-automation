import {
  Client,
  Domain,
  defaultHttpInstance,
  type HttpInstance,
  LoggerLevel,
  withTenantToken,
} from "@larksuiteoapi/node-sdk";
import type { DeliveryTransport, TransportOutcome } from "./report-ledger.js";

/** Fixed app-bot credentials and explicitly permitted destination groups. */
export interface LarkDeliveryOptions {
  appId: string;
  appSecret: string;
  allowedDestinationChatIds: readonly string[];
  httpInstance?: HttpInstance | typeof defaultHttpInstance;
  clock?: () => number;
}

/** Extract a provider rejection only from HTTP statuses that cannot imply acceptance. */
function httpRejection(error: unknown): unknown {
  if (typeof error !== "object" || error === null || !("response" in error))
    return null;
  const response = error.response;
  if (
    typeof response !== "object" ||
    response === null ||
    !("status" in response) ||
    typeof response.status !== "number" ||
    ![400, 401, 403, 429].includes(response.status) ||
    !("data" in response)
  )
    return null;
  return response.data;
}

/** Only documented rejection codes establish that this request was rejected. */
function rejection(value: unknown): TransportOutcome | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("code" in value) ||
    typeof value.code !== "number"
  )
    return null;
  if (value.code === 230020 || value.code === 99991400)
    return {
      status: "retryable",
      reason: "rate_limited",
      retryAfterMs: 30_000,
    };
  if (
    [230002, 230006, 230018, 230027, 230034, 230035, 232009].includes(
      value.code,
    )
  )
    return { status: "failed", reason: "destination_denied" };
  return null;
}

/** App-bot adapter for S4; no live command or background sender is installed. */
export function createLarkDeliveryTransport(
  options: LarkDeliveryOptions,
): DeliveryTransport {
  const http = defaultHttpInstance.create({
    timeout: 15_000,
    maxRedirects: 0,
    maxContentLength: 1024 * 1024,
  });
  http.interceptors.response.use((response) => response.data);
  // SDK diagnostics may include credentials or request content. Return sanitized outcomes instead.
  const silent = () => {};
  const client = new Client({
    appId: options.appId,
    appSecret: options.appSecret,
    domain: Domain.Lark,
    disableTokenCache: true,
    httpInstance: (options.httpInstance ?? http) as HttpInstance,
    loggerLevel: LoggerLevel.error,
    logger: {
      error: silent,
      warn: silent,
      info: silent,
      debug: silent,
      trace: silent,
    },
  });
  const send: DeliveryTransport = async (request) => {
    if (
      request.appId !== options.appId ||
      !options.allowedDestinationChatIds.includes(request.destinationChatId)
    )
      return { status: "failed", reason: "outbound_scope_mismatch" };
    // Separate credential retrieval so its failure establishes that no message POST ran.
    let accessToken: string;
    try {
      const token: unknown = await client.auth.tenantAccessToken.internal({
        data: { app_id: options.appId, app_secret: options.appSecret },
      });
      if (typeof token !== "object" || token === null || !("code" in token))
        throw new Error("Credentials unavailable");
      if (token.code === 10014 || token.code === 99991543)
        return { status: "failed", reason: "credentials_invalid" };
      if (
        token.code !== 0 ||
        !("tenant_access_token" in token) ||
        typeof token.tenant_access_token !== "string" ||
        !token.tenant_access_token.trim()
      )
        throw new Error("Credentials unavailable");
      accessToken = token.tenant_access_token;
    } catch (error) {
      const rejected = httpRejection(error);
      if (
        typeof rejected === "object" &&
        rejected !== null &&
        "code" in rejected &&
        (rejected.code === 10014 || rejected.code === 99991543)
      )
        return { status: "failed", reason: "credentials_invalid" };
      return {
        status: "retryable",
        reason: "credentials_unavailable",
        retryAfterMs: 30_000,
      };
    }
    if (
      request.retryDeadlineMs !== undefined &&
      (options.clock ?? Date.now)() >= request.retryDeadlineMs
    )
      return { status: "uncertain", reason: "deduplication_window_expired" };
    if (
      request.claimDeadlineMs !== undefined &&
      (options.clock ?? Date.now)() >= request.claimDeadlineMs
    )
      return { status: "uncertain", reason: "claim_expired" };
    try {
      const response = await client.im.message.create(
        {
          params: { receive_id_type: "chat_id" },
          data: {
            receive_id: request.destinationChatId,
            msg_type: "text",
            content: JSON.stringify({ text: request.text }),
            uuid: request.uuid,
          },
        },
        withTenantToken(accessToken),
      );
      const rejected = rejection(response);
      if (rejected) return rejected;
      if (
        response.code !== 0 ||
        !response.data?.message_id ||
        response.data.chat_id !== request.destinationChatId
      )
        throw new Error("Acknowledgement unavailable");
      return { messageId: response.data.message_id };
    } catch (error) {
      const rejected = rejection(httpRejection(error));
      if (rejected) return rejected;
      throw new Error("Send outcome unknown");
    }
  };
  send.deduplication = "lark_uuid_one_hour";
  return send;
}
