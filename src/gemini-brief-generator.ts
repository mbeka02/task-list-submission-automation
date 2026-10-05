import { ApiError, GoogleGenAI, ThinkingLevel } from "@google/genai";
import {
  type BriefGenerator,
  parseBriefDraft,
  validateBriefRequest,
} from "./brief-generator.js";

/** Developer API credentials and explicit model; caller cancellation can shorten the per-request timeout. */
export interface GeminiBriefGeneratorOptions {
  apiKey: string;
  model: string;
  timeoutMs?: number;
}

const responseSchema = {
  type: "object",
  required: ["rows", "notes"],
  additionalProperties: false,
  properties: {
    rows: {
      type: "array",
      items: {
        type: "object",
        required: ["entryRef", "summary"],
        additionalProperties: false,
        properties: {
          entryRef: { type: "string" },
          summary: { type: "string" },
        },
      },
    },
    notes: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        required: ["text", "entryRefs"],
        additionalProperties: false,
        properties: {
          text: { type: "string" },
          entryRefs: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

/** Gemini wire settings and responses stay behind the shared S9 interface; no SQL or Lark side effects. */
export function createGeminiBriefGenerator(
  options: GeminiBriefGeneratorOptions,
): BriefGenerator {
  return {
    /** Validate locally, make one bounded call, then validate final output and normalize safe metadata. */
    async generate(request, { signal }) {
      const validModel =
        /^gemini-3(?:\.\d+)?-flash(?:-lite)?(?:-preview)?$/.test(options.model);
      // Never echo malformed configuration: it could contain a pasted URL or credential.
      const model = validModel ? options.model : "unconfigured";
      const unknownUsage = {
        inputTokens: null,
        outputTokens: null,
        thinkingTokens: null,
        totalTokens: null,
      };
      if (signal.aborted)
        return {
          provider: "gemini",
          model,
          usage: unknownUsage,
          status: "failed",
          classification: "cancelled",
          reason: "cancelled",
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
          provider: "gemini",
          model,
          usage: unknownUsage,
          status: "failed",
          classification: "permanent",
          reason: "invalid_configuration",
        };
      const invalid = validateBriefRequest(request);
      if (invalid)
        return {
          provider: "gemini",
          model,
          usage: unknownUsage,
          status: "failed",
          classification: "permanent",
          reason: invalid,
        };
      let retryAfterMs: number | undefined;
      try {
        const client = new GoogleGenAI({
          apiKey: options.apiKey,
          vertexai: false,
          httpOptions: {
            baseUrl: "https://generativelanguage.googleapis.com",
            apiVersion: "v1beta",
            timeout: timeoutMs,
            retryOptions: { attempts: 1 },
            fetch: async (url, init) => {
              const response = await fetch(url, { ...init, redirect: "error" });
              const value = response.headers.get("retry-after");
              if (value !== null) {
                const delay = /^\d+(?:\.\d+)?$/.test(value)
                  ? Number(value) * 1000
                  : Date.parse(value) - Date.now();
                if (Number.isSafeInteger(delay) && delay >= 0)
                  retryAfterMs = delay;
              }
              return response;
            },
          },
        });
        const response = await client.models.generateContent({
          model,
          contents: JSON.stringify({
            entries: request.entries.map((entry) => ({
              entryRef: entry.entryRef,
              taskText: entry.taskText,
            })),
          }),
          config: {
            systemInstruction: `${request.instructions}\n\nOUTPUT TEMPLATE (layout reference):\n${request.template}`,
            responseMimeType: "application/json",
            responseJsonSchema: responseSchema,
            maxOutputTokens: 4096,
            thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
            abortSignal: signal,
          },
        });
        const metadata = response.usageMetadata;
        const inputTokens = tokenCount(metadata?.promptTokenCount);
        const totalTokens = tokenCount(metadata?.totalTokenCount);
        const meta = {
          provider: "gemini" as const,
          model,
          usage: {
            inputTokens,
            totalTokens,
            thinkingTokens: tokenCount(metadata?.thoughtsTokenCount),
            outputTokens:
              inputTokens !== null && totalTokens !== null
                ? tokenCount(totalTokens - inputTokens)
                : tokenCount(metadata?.candidatesTokenCount) !== null &&
                    tokenCount(metadata?.thoughtsTokenCount) !== null
                  ? tokenCount(
                      (metadata?.candidatesTokenCount ?? 0) +
                        (metadata?.thoughtsTokenCount ?? 0),
                    )
                  : null,
          },
        };
        const candidate = response.candidates?.[0];
        if (
          response.promptFeedback?.blockReason ||
          [
            "SAFETY",
            "RECITATION",
            "BLOCKLIST",
            "PROHIBITED_CONTENT",
            "SPII",
          ].includes(candidate?.finishReason ?? "")
        )
          return {
            ...meta,
            status: "failed",
            classification: "permanent",
            reason: "refused",
          };
        if (candidate?.finishReason === "MAX_TOKENS")
          return {
            ...meta,
            status: "failed",
            classification: "permanent",
            reason: "truncated",
          };
        if (
          response.candidates?.length !== 1 ||
          candidate?.finishReason !== "STOP"
        )
          return {
            ...meta,
            status: "failed",
            classification: "permanent",
            reason: "invalid_response",
          };
        // Read visible text directly so SDK convenience getters cannot log unexpected response parts.
        const parts = candidate.content?.parts?.filter((part) => !part.thought);
        if (
          !parts?.length ||
          parts.some((part) => typeof part.text !== "string")
        )
          return {
            ...meta,
            status: "failed",
            classification: "permanent",
            reason: "invalid_response",
          };
        let decoded: unknown;
        try {
          decoded = JSON.parse(parts.map((part) => part.text).join(""));
        } catch {
          return {
            ...meta,
            status: "failed",
            classification: "permanent",
            reason: "invalid_output",
          };
        }
        const draft = parseBriefDraft(
          decoded,
          request.entries.map((entry) => entry.entryRef),
        );
        if (!draft)
          return {
            ...meta,
            status: "failed",
            classification: "permanent",
            reason: "invalid_output",
          };
        return { ...meta, status: "generated", draft };
      } catch (error) {
        let classification: "transient" | "permanent" | "cancelled" =
          "transient";
        let reason = "network_error";
        if (signal.aborted) {
          classification = "cancelled";
          reason = "cancelled";
        } else if (
          error instanceof Error &&
          ["AbortError", "TimeoutError"].includes(error.name)
        )
          reason = "timeout";
        else if (error instanceof ApiError) {
          const status = error.status;
          classification =
            status === 408 || status === 429 || status >= 500
              ? "transient"
              : "permanent";
          reason =
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
        }
        return {
          provider: "gemini",
          model,
          usage: unknownUsage,
          status: "failed",
          classification,
          reason,
          ...(classification === "transient" && retryAfterMs !== undefined
            ? { retryAfterMs }
            : {}),
        };
      }
    },
  };
}

/** Omitted or malformed vendor counters remain unknown; negative arithmetic cannot become billable usage. */
function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}
