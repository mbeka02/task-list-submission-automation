import { afterEach, expect, test } from "vitest";
import { createBriefGenerator } from "../../src/brief-generator-factory.js";
import { briefProviderHttpServer } from "../support/brief-provider-http-server.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
const request = {
  template: "Today’s brief\n{{rows}}\n{{notes}}\nAI-generated brief.",
  instructions: "Summarize supplied task data only.",
  entries: [
    { entryRef: "entry-1", taskText: "Task list\n1. Prepare drawings" },
  ],
} as const;
const draft = {
  rows: [{ entryRef: "entry-1", summary: "Prepare drawings." }],
  notes: [],
};
const providers = ["gemini", "deepseek"] as const;
function wire(provider: (typeof providers)[number], content: unknown) {
  return provider === "gemini"
    ? {
        candidates: [
          {
            finishReason: "STOP",
            content: { parts: [{ text: JSON.stringify(content) }] },
          },
        ],
      }
    : {
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify(content) },
          },
        ],
      };
}
function generator(provider: (typeof providers)[number]) {
  return createBriefGenerator({
    provider,
    apiKey: "synthetic-key",
    model: provider === "gemini" ? "gemini-3.5-flash-lite" : "deepseek-flash",
  });
}

test.each(providers)(
  "selects only %s and returns the shared result",
  async (provider) => {
    const server = await briefProviderHttpServer(() => ({
      body: wire(provider, draft),
    }));
    cleanups.push(server.close);
    expect(
      await generator(provider).generate(request, {
        signal: new AbortController().signal,
      }),
    ).toMatchObject({ status: "generated", provider, draft });
    expect(server.origins).toEqual([
      provider === "gemini"
        ? "https://generativelanguage.googleapis.com"
        : "https://api.deepseek.com",
    ]);
    expect(server.requests).toHaveLength(1);
  },
);

test("rejects an unknown runtime provider before networking", async () => {
  const server = await briefProviderHttpServer(() => ({ body: {} }));
  cleanups.push(server.close);
  // JavaScript/environment callers can bypass TypeScript's provider union.
  const options = JSON.parse(
    '{"provider":"unsupported","apiKey":"synthetic-key","model":"model"}',
  );
  expect(() => createBriefGenerator(options)).toThrow(
    "unsupported_brief_provider",
  );
  expect(server.origins).toHaveLength(0);
});

test.each(providers)(
  "%s enforces the same reference and output limits",
  async (provider) => {
    const invalidDrafts = [
      { rows: [{ entryRef: "unknown", summary: "Invented work" }], notes: [] },
      { rows: [], notes: [] },
      { rows: [{ entryRef: "entry-1", summary: "x".repeat(401) }], notes: [] },
      {
        ...draft,
        notes: [{ text: "Unsupported note", entryRefs: ["unknown"] }],
      },
      { ...draft, notes: [{ text: "x".repeat(241), entryRefs: ["entry-1"] }] },
      {
        ...draft,
        notes: Array.from({ length: 6 }, () => ({
          text: "Note",
          entryRefs: ["entry-1"],
        })),
      },
      { ...draft, privateField: "unexpected" },
    ];
    let index = 0;
    const server = await briefProviderHttpServer(() => ({
      body: wire(provider, invalidDrafts[index++]),
    }));
    cleanups.push(server.close);
    for (const _ of invalidDrafts) {
      expect(
        await generator(provider).generate(request, {
          signal: new AbortController().signal,
        }),
      ).toMatchObject({
        status: "failed",
        classification: "permanent",
        reason: "invalid_output",
      });
    }
    expect(server.requests).toHaveLength(7);
  },
);

test.each(providers)(
  "%s strips identity fields and does not fall back on an outage",
  async (provider) => {
    const server = await briefProviderHttpServer(() => ({
      status: 503,
      body: {
        error: { code: 503, message: "private source and synthetic-key" },
      },
    }));
    cleanups.push(server.close);
    const input = {
      ...request,
      entries: [
        {
          ...request.entries[0],
          name: "Private Employee",
          senderOpenId: "private-id",
          late: true,
        },
      ],
    };
    const result = await generator(provider).generate(input, {
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      status: "failed",
      provider,
      classification: "transient",
      reason: "provider_unavailable",
    });
    expect(server.requests).toHaveLength(1);
    expect(JSON.stringify(server.requests[0]?.body)).not.toContain(
      "Private Employee",
    );
    expect(JSON.stringify(server.requests[0]?.body)).not.toContain(
      "private-id",
    );
    expect(JSON.stringify(result)).not.toContain("private source");
    expect(JSON.stringify(result)).not.toContain("synthetic-key");
  },
);
