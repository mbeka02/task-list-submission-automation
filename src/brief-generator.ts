/** Provider-neutral model input. Names, identities, dates and late labels stay with the renderer. */
export interface BriefGenerationRequest {
  template: string;
  instructions: string;
  entries: readonly { entryRef: string; taskText: string }[];
}

/** Structured content only; opaque source references let the application restore frozen ordering. */
export interface BriefDraft {
  rows: { entryRef: string; summary: string }[];
  notes: { text: string; entryRefs: string[] }[];
}

/** Missing usage is unknown, not zero. Output includes reasoning; thinking is a subset, not an extra charge. */
export interface BriefTokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  totalTokens: number | null;
}

/** Safe application outcomes never expose provider exceptions, response bodies or credentials. */
export type BriefGenerationResult = {
  provider: "gemini" | "deepseek";
  model: string;
  usage: BriefTokenUsage;
} & (
  | { status: "generated"; draft: BriefDraft }
  | {
      status: "failed";
      classification: "transient" | "permanent" | "cancelled";
      reason: string;
      retryAfterMs?: number;
    }
);

/** One bounded provider attempt; the later coordinator owns retries, fallback and persistence. */
export interface BriefGenerator {
  generate(
    request: BriefGenerationRequest,
    options: { signal: AbortSignal },
  ): Promise<BriefGenerationResult>;
}

/** Internal shared validation for adapters: structured JSON is not enough to prove complete membership. */
export function parseBriefDraft(
  value: unknown,
  entryRefs: readonly string[],
): BriefDraft | null {
  if (
    !record(value) ||
    !exactKeys(value, ["rows", "notes"]) ||
    !Array.isArray(value.rows) ||
    !Array.isArray(value.notes) ||
    value.rows.length !== entryRefs.length ||
    value.notes.length > 5
  )
    return null;
  const known = new Set(entryRefs);
  const seen = new Set<string>();
  const rows: BriefDraft["rows"] = [];
  for (const row of value.rows) {
    if (
      !record(row) ||
      !exactKeys(row, ["entryRef", "summary"]) ||
      typeof row.entryRef !== "string" ||
      !known.has(row.entryRef) ||
      seen.has(row.entryRef) ||
      !shortText(row.summary, 400)
    )
      return null;
    seen.add(row.entryRef);
    rows.push({ entryRef: row.entryRef, summary: row.summary.trim() });
  }
  const notes: BriefDraft["notes"] = [];
  for (const note of value.notes) {
    if (
      !record(note) ||
      !exactKeys(note, ["text", "entryRefs"]) ||
      !shortText(note.text, 240) ||
      !Array.isArray(note.entryRefs) ||
      note.entryRefs.length === 0
    )
      return null;
    const refs: string[] = [];
    for (const ref of note.entryRefs) {
      if (typeof ref !== "string" || !known.has(ref) || refs.includes(ref))
        return null;
      refs.push(ref);
    }
    notes.push({ text: note.text.trim(), entryRefs: refs });
  }
  return { rows, notes };
}

/** Narrow untrusted JSON before inspecting its fields. */
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Additional model fields cannot change the agreed output shape. */
function exactKeys(value: Record<string, unknown>, keys: string[]) {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
/** Count Unicode code points so surrogate pairs are not charged as two characters. */
function shortText(value: unknown, limit: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Array.from(value).length <= limit
  );
}

/** Internal input guard shared by providers; UTF-8 bytes are a safety bound, not a token estimate. */
export function validateBriefRequest(
  request: BriefGenerationRequest,
): "invalid_request" | "input_too_large" | null {
  if (
    typeof request.template !== "string" ||
    !request.template.trim() ||
    typeof request.instructions !== "string" ||
    !request.instructions.trim() ||
    !Array.isArray(request.entries) ||
    request.entries.length === 0
  )
    return "invalid_request";
  if (request.entries.length > 100) return "input_too_large";
  const refs = new Set<string>();
  for (const entry of request.entries) {
    if (
      !record(entry) ||
      typeof entry.entryRef !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(entry.entryRef) ||
      refs.has(entry.entryRef) ||
      typeof entry.taskText !== "string" ||
      !entry.taskText.trim()
    )
      return "invalid_request";
    refs.add(entry.entryRef);
  }
  const input = {
    template: request.template,
    instructions: request.instructions,
    entries: request.entries.map((entry) => ({
      entryRef: entry.entryRef,
      taskText: entry.taskText,
    })),
  };
  return Buffer.byteLength(JSON.stringify(input), "utf8") > 65536
    ? "input_too_large"
    : null;
}
