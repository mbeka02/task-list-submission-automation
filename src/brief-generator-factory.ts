import type { BriefGenerator } from "./brief-generator.js";
import { createDeepSeekBriefGenerator } from "./deepseek-brief-generator.js";
import { createGeminiBriefGenerator } from "./gemini-brief-generator.js";

/** Explicit provider selection; the caller supplies that provider's key and model. */
export interface BriefGeneratorOptions {
  provider: "gemini" | "deepseek";
  apiKey: string;
  model: string;
  timeoutMs?: number;
}

/** Select one S9 adapter without environment reads, network calls or automatic failover. */
export function createBriefGenerator(
  options: BriefGeneratorOptions,
): BriefGenerator {
  switch (options.provider) {
    case "gemini":
      return createGeminiBriefGenerator(options);
    case "deepseek":
      return createDeepSeekBriefGenerator(options);
    default:
      throw new Error("unsupported_brief_provider");
  }
}
