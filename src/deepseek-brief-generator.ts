import {
  type BriefGenerator,
  parseBriefDraft,
  validateBriefRequest,
} from "./brief-generator.js";

/** DeepSeek key/model and a bounded request timeout; credentials are passed only in the auth header. */
export interface DeepSeekBriefGeneratorOptions {
  apiKey: string;
  model: string;
  timeoutMs?: number;
}

/** Native HTTP implementation of S9; no vendor SDK, storage, publishing or automatic retries. */
export function createDeepSeekBriefGenerator(
  options: DeepSeekBriefGeneratorOptions,
): BriefGenerator {
  return {
    /** Validate before networking; only final, complete JSON can become an application draft. */
    async generate(request, { signal }) {
      const validModel = ["deepseek-flash", "deepseek-v4-pro"].includes(
        options.model,
      );
      // Malformed configuration may contain pasted secrets; never echo it in results.
      const model = validModel ? options.model : "unconfigured";
      const emptyUsage = {
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        thinkingTokens: null,
      };
      if (signal.aborted)
        return {
          provider: "deepseek",
          model,
          status: "failed",
          classification: "cancelled",
          reason: "cancelled",
          usage: emptyUsage,
        };
      const timeoutMs = options.timeoutMs ?? 15000;
      if (
        !options.apiKey.trim() ||
        !validModel ||
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > 15000
      )
        return {
          provider: "deepseek",
          model,
          status: "failed",
          classification: "permanent",
          reason: "invalid_configuration",
          usage: emptyUsage,
        };
      const invalid = validateBriefRequest(request);
      if (invalid)
        return {
          provider: "deepseek",
          model,
          status: "failed",
          classification: "permanent",
          reason: invalid,
          usage: emptyUsage,
        };
      // Keep the deadline active through body consumption and release cancellation listeners afterward.
      const controller = new AbortController();
      let timedOut = false;
      const cancel = () => controller.abort();
      signal.addEventListener("abort", cancel, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      timer.unref();
      try {
        const response = await fetch(
          "https://api.deepseek.com/chat/completions",
          {
            method: "POST",
            redirect: "error",
            headers: {
              Authorization: `Bearer ${options.apiKey}`,
              "Content-Type": "application/json",
            },
            signal: controller.signal,
            body: JSON.stringify({
              model,
              stream: false,
              max_tokens: 4096,
              thinking: { type: "disabled" },
              response_format: { type: "json_object" },
              messages: [
                {
                  role: "system",
                  content: `${request.instructions}\n\nOUTPUT TEMPLATE:\n${request.template}\n\nReturn only JSON with this shape: {"rows":[{"entryRef":"supplied-reference","summary":"concise work"}],"notes":[{"text":"source-backed note","entryRefs":["supplied-reference"]}]}. Include every supplied entryRef once. Use an empty notes array when none apply.`,
                },
                {
                  role: "user",
                  content: JSON.stringify({
                    entries: request.entries.map((entry) => ({
                      entryRef: entry.entryRef,
                      taskText: entry.taskText,
                    })),
                  }),
                },
              ],
            }),
          },
        );
        if (!response.ok) {
          const status = response.status;
          const classification =
            status === 408 || status === 429 || status >= 500
              ? ("transient" as const)
              : ("permanent" as const);
          const reason =
            status === 429
              ? "rate_limited"
              : status === 408
                ? "timeout"
                : status >= 500
                  ? "provider_unavailable"
                  : status === 401
                    ? "credentials_invalid"
                    : status === 402
                      ? "billing_required"
                      : status === 403
                        ? "access_denied"
                        : status === 404
                          ? "model_unavailable"
                          : status === 400
                            ? "invalid_request"
                            : "http_error";
          const header = response.headers.get("retry-after");
          const delay =
            header === null
              ? NaN
              : /^\d+(?:\.\d+)?$/.test(header)
                ? Number(header) * 1000
                : Date.parse(header) - Date.now();
          // Discard vendor error bodies: they can contain credentials or submitted task text.
          await response.body?.cancel().catch(() => {});
          return {
            provider: "deepseek",
            model,
            status: "failed",
            classification,
            reason,
            usage: emptyUsage,
            ...(classification === "transient" &&
            Number.isSafeInteger(delay) &&
            delay >= 0
              ? { retryAfterMs: delay }
              : {}),
          };
        }
        let body: unknown;
        try {
          body = await response.json();
        } catch (error) {
          if (error instanceof SyntaxError)
            return {
              provider: "deepseek",
              model,
              status: "failed",
              classification: "permanent",
              reason: "invalid_response",
              usage: emptyUsage,
            };
          throw error;
        }

        const metadata = record(body) && record(body.usage) ? body.usage : {};
        const details = record(metadata.completion_tokens_details)
          ? metadata.completion_tokens_details
          : {};
        // Completion already includes reasoning; prompt already includes cache hit/miss tokens.
        const usage = {
          inputTokens: tokenCount(metadata.prompt_tokens),
          outputTokens: tokenCount(metadata.completion_tokens),
          totalTokens: tokenCount(metadata.total_tokens),
          thinkingTokens: tokenCount(details.reasoning_tokens),
        };
        const fail = (reason: string) => ({
          provider: "deepseek" as const,
          model,
          status: "failed" as const,
          classification: "permanent" as const,
          reason,
          usage,
        });
        const choices =
          record(body) && Array.isArray(body.choices) ? body.choices : [];
        const choice: unknown = choices[0];
        if (record(choice) && choice.finish_reason === "length")
          return fail("truncated");
        if (record(choice) && choice.finish_reason === "content_filter")
          return fail("refused");
        if (
          choices.length !== 1 ||
          !record(choice) ||
          choice.finish_reason !== "stop" ||
          !record(choice.message) ||
          typeof choice.message.content !== "string"
        )
          return fail("invalid_response");
        let decoded: unknown;
        try {
          decoded = JSON.parse(choice.message.content);
        } catch {
          return fail("invalid_output");
        }
        const draft = parseBriefDraft(
          decoded,
          request.entries.map((entry) => entry.entryRef),
        );
        if (!draft) return fail("invalid_output");
        return {
          provider: "deepseek",
          model,
          status: "generated",
          draft,
          usage,
        };
      } catch {
        return {
          provider: "deepseek",
          model,
          status: "failed",
          classification: signal.aborted ? "cancelled" : "transient",
          reason: signal.aborted
            ? "cancelled"
            : timedOut
              ? "timeout"
              : "network_error",
          usage: emptyUsage,
        };
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
      }
    },
  };
}

/** Narrow untrusted provider envelopes without relying on vendor casts. */
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Unsupported counters stay unknown rather than silently becoming zero usage. */
function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}
