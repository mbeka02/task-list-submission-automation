import type { BriefTokenUsage } from "./brief-generator.js";

/** Memory-only document input; names/order/late labels always come from the frozen ledger. */
export interface BriefContent {
  kind: "ai" | "fallback" | "empty";
  businessDate: string;
  title: string;
  captureLine: string;
  rows: {
    entryRef: string;
    displayName: string;
    timeliness: "on_time" | "late";
    text: string;
    abbreviated: boolean;
  }[];
  notes: { text: string; entryRefs: string[] }[];
  footer: string;
  notice?: string;
}

/** Persist operational evidence only, never model output, prompts, source text or vendor exceptions. */
export interface BriefGenerationAttempt {
  number: number;
  reservedAtMs: number;
  completedAtMs?: number;
  outcome: "reserved" | "generated" | "failed";
  reason?: string;
  classification?: "transient" | "permanent" | "cancelled";
  usage?: BriefTokenUsage;
}
