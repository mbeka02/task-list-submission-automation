import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { openBriefCoordinator } from "../../src/brief-coordinator.js";
import { createBriefGenerator } from "../../src/brief-generator-factory.js";
import { openBriefLedger } from "../../src/brief-ledger.js";
import { createLarkDeliveryTransport } from "../../src/lark-delivery.js";
import {
  businessDate,
  config,
  message,
  scan,
} from "../support/brief-coordinator-fixtures.js";
import { briefProviderHttpServer } from "../support/brief-provider-http-server.js";
import {
  type CapturedLarkRequest,
  larkHttpServer,
} from "../support/lark-http-server.js";
import { logCapture } from "../support/log-capture.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const now = Date.parse("2026-10-01T10:15:01+03:00");

async function setup(
  override?: (
    request: CapturedLarkRequest,
    result: { body: unknown; status?: number },
  ) =>
    | { body: unknown; status?: number; delayMs?: number; disconnect?: boolean }
    | undefined,
  fixture: {
    clock?: () => number;
    input?: ReturnType<typeof scan>;
    providerBody?: unknown;
    providerStatus?: number;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "brief-publishing-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, "ledger.sqlite");
  const ledger = openBriefLedger({ ...config, databasePath });
  const prepared = ledger.prepareDailyBrief({
    businessDate,
    scan: fixture.input ?? scan(),
  });
  ledger.close();
  if (prepared.status !== "frozen") throw new Error("Fixture not frozen");
  const provider = await briefProviderHttpServer(() => ({
    ...(fixture.providerStatus ? { status: fixture.providerStatus } : {}),
    body: fixture.providerBody ?? {
      candidates: [
        {
          finishReason: "STOP",
          content: {
            parts: [
              {
                text: JSON.stringify({
                  rows: [
                    { entryRef: "entry-1", summary: "Draft client drawings." },
                    {
                      entryRef: "entry-2",
                      summary: "Check project estimates.",
                    },
                  ],
                  notes: [],
                }),
              },
            ],
          },
        },
      ],
    },
  }));
  cleanups.push(provider.close);
  const blocks: unknown[] = [];
  let revision = 1;
  let members: unknown[] = [];
  const respond = (request: CapturedLarkRequest) => {
    if (request.path.includes("tenant_access_token"))
      return {
        body: { code: 0, tenant_access_token: "synthetic-token", expire: 7200 },
      };
    if (request.path.endsWith("/public"))
      return {
        body: {
          code: 0,
          data: { permission_public: { link_share_entity: "closed" } },
        },
      };
    if (request.path.endsWith("/members")) {
      if (request.method === "POST") members = [request.body];
      return {
        body: { code: 0, data: { items: members, member: members[0] } },
      };
    }
    if (request.path === "/open-apis/docx/v1/documents")
      return {
        body: {
          code: 0,
          data: {
            document: {
              document_id: "docSynthetic",
              revision_id: 1,
              title: "Today's brief — 2026-10-01",
            },
          },
        },
      };
    if (request.path.endsWith("/children")) {
      blocks.push(...(request.body as { children: unknown[] }).children);
      revision++;
      return {
        body: {
          code: 0,
          data: { children: [], document_revision_id: revision },
        },
      };
    }
    if (request.path.endsWith("/blocks"))
      return {
        body: {
          code: 0,
          data: {
            items: [
              {
                block_id: "docSynthetic",
                block_type: 1,
                children: blocks.map((_, i) => `b${i}`),
              },
              ...blocks.map((block, i) => ({
                ...(block as object),
                block_id: `b${i}`,
                parent_id: "docSynthetic",
              })),
            ],
            has_more: false,
          },
        },
      };
    if (request.path.endsWith("/docSynthetic"))
      return {
        body: {
          code: 0,
          data: {
            document: {
              document_id: "docSynthetic",
              title: "Today's brief — 2026-10-01",
              revision_id: revision,
            },
          },
        },
      };
    if (request.path === "/open-apis/im/v1/messages")
      return {
        body: {
          code: 0,
          data: { message_id: "om_brief", chat_id: "oc_management" },
        },
      };
    throw new Error("Unexpected Lark request");
  };
  const lark = await larkHttpServer((request) => {
    const result = respond(request);
    return override?.(request, result) ?? result;
  });
  cleanups.push(lark.close);
  const options = {
    ...config,
    databasePath,
    clock: fixture.clock ?? (() => now),
    template: "Today's brief",
    instructions: "Summarize only supplied work.",
    generator: createBriefGenerator({
      provider: "gemini" as const,
      apiKey: "synthetic-key",
      model: config.model,
    }),
    docPublishing: {
      appSecret: "synthetic-secret",
      stagingFolderToken: "folderPrivate",
      documentBaseUrl: "https://synthetic.larksuite.com/docx/",
      httpInstance: lark.httpInstance,
    },
    transport: createLarkDeliveryTransport({
      appId: config.appId,
      appSecret: "synthetic-secret",
      allowedDestinationChatIds: [config.destinationChatId],
      httpInstance: lark.httpInstance,
      clock: () => now,
    }),
  };
  const coordinator = openBriefCoordinator(options);
  cleanups.push(coordinator.close);
  return {
    coordinator,
    options,
    provider,
    lark,
    briefId: prepared.brief.id,
    blocks: () => blocks,
    members: () => members,
  };
}

test("publication timings and link delivery retain the brief run without logging the document body or URL", async () => {
  const environment = await setup();
  const logs = logCapture();
  const coordinator = openBriefCoordinator({
    ...environment.options,
    logger: logs.logger,
  });
  cleanups.push(coordinator.close);
  expect(
    await coordinator.completeDailyBrief({ briefId: environment.briefId, now }),
  ).toMatchObject({ status: "published" });
  expect(logs.events()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        event: "document_step_completed",
        stage: "create",
        durationMs: expect.any(Number),
      }),
      expect.objectContaining({
        event: "document_step_completed",
        stage: "privacy",
      }),
      expect.objectContaining({
        event: "document_step_completed",
        stage: "write",
      }),
      expect.objectContaining({
        event: "document_step_completed",
        stage: "verify",
      }),
      expect.objectContaining({
        event: "document_step_completed",
        stage: "share",
      }),
      expect.objectContaining({ event: "delivery_completed", status: "sent" }),
      expect.objectContaining({
        event: "brief_completed",
        status: "published",
      }),
    ]),
  );
  expect(new Set(logs.events().map((event) => event.runId)).size).toBe(1);
  expect(
    logs
      .events()
      .every(
        (event) =>
          event.briefId === environment.briefId &&
          event.entryPoint === "brief_api",
      ),
  ).toBe(true);
  for (const canary of [
    "docSynthetic",
    "folderPrivate",
    "synthetic-secret",
    "synthetic-token",
    "Alice",
    "Draft client drawings",
    "https://synthetic.larksuite.com",
    "Today's brief",
  ])
    expect(logs.text()).not.toContain(canary);
});

test("a denied editor grant identifies the failed publication stage without logging the vendor body", async () => {
  const environment = await setup((request) =>
    request.path.endsWith("/members") && request.method === "POST"
      ? { status: 403, body: { code: 999, msg: "permission-body-canary" } }
      : undefined,
  );
  const logs = logCapture();
  const coordinator = openBriefCoordinator({
    ...environment.options,
    logger: logs.logger,
  });
  cleanups.push(coordinator.close);
  expect(
    await coordinator.completeDailyBrief({ briefId: environment.briefId, now }),
  ).toMatchObject({
    status: "review_required",
    reason: "document_operation_unverified",
  });
  expect(logs.events()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        event: "document_step_failed",
        stage: "share",
        reason: "document_operation_unverified",
        level: "warn",
      }),
      expect.objectContaining({
        event: "brief_completed",
        status: "review_required",
        reason: "document_operation_unverified",
      }),
    ]),
  );
  expect(logs.text()).not.toContain("permission-body-canary");
});

test("closes tenant-readable defaults on an app-owned Doc before writing the brief", async () => {
  let linkSharing = "tenant_readable";
  const { coordinator, briefId } = await setup((request, result) => {
    if (request.path.endsWith("/public")) {
      if (request.method === "PATCH") {
        if (
          JSON.stringify(request.body) !==
          JSON.stringify({ link_share_entity: "closed" })
        )
          return { body: { code: 400, msg: "Unexpected permission change" } };
        linkSharing = "closed";
      }
      return {
        body: {
          code: 0,
          data: { permission_public: { link_share_entity: linkSharing } },
        },
      };
    }
    if (request.path.endsWith("/members") && request.method === "GET") {
      const body = result.body as { data: { items: unknown[] } };
      if (body.data.items.length === 0)
        return {
          body: {
            code: 0,
            data: {
              items: [
                {
                  member_id: config.appId,
                  member_type: "appid",
                  perm: "full_access",
                },
              ],
            },
          },
        };
    }
    if (request.path.endsWith("/children") && linkSharing !== "closed")
      return { body: { code: 403, msg: "Content must remain private" } };
    return undefined;
  });
  expect(await coordinator.completeDailyBrief({ briefId, now })).toMatchObject({
    status: "published",
  });
  expect(linkSharing).toBe("closed");
});

test("does not change sharing when the new Doc is owned by another app", async () => {
  let linkSharing = "tenant_readable";
  const { coordinator, briefId, blocks } = await setup((request) => {
    if (request.path.endsWith("/public")) {
      if (request.method === "PATCH") linkSharing = "closed";
      return {
        body: {
          code: 0,
          data: { permission_public: { link_share_entity: linkSharing } },
        },
      };
    }
    if (request.path.endsWith("/members") && request.method === "GET")
      return {
        body: {
          code: 0,
          data: {
            items: [
              {
                member_id: "cli_other",
                member_type: "appid",
                perm: "full_access",
              },
            ],
          },
        },
      };
    return undefined;
  });
  expect(await coordinator.completeDailyBrief({ briefId, now })).toMatchObject({
    status: "review_required",
  });
  expect(linkSharing).toBe("tenant_readable");
  expect(blocks()).toEqual([]);
});

test("an acknowledged privacy change must be confirmed before any brief content is written", async () => {
  const { coordinator, briefId, blocks } = await setup((request, result) => {
    if (request.path.endsWith("/public"))
      return {
        body: {
          code: 0,
          data: {
            permission_public: {
              link_share_entity:
                request.method === "PATCH" ? "closed" : "tenant_readable",
            },
          },
        },
      };
    if (request.path.endsWith("/members") && request.method === "GET")
      return {
        body: {
          code: 0,
          data: {
            items: [
              {
                member_id: config.appId,
                member_type: "appid",
                perm: "full_access",
              },
            ],
          },
        },
      };
    return result;
  });
  expect(await coordinator.completeDailyBrief({ briefId, now })).toMatchObject({
    status: "review_required",
  });
  expect(blocks()).toEqual([]);
});

test("rechecks collaborators after closing the new Doc's link access", async () => {
  let closed = false;
  const { coordinator, briefId, blocks } = await setup((request) => {
    if (request.path.endsWith("/public")) {
      if (request.method === "PATCH") closed = true;
      return {
        body: {
          code: 0,
          data: {
            permission_public: {
              link_share_entity: closed ? "closed" : "tenant_readable",
            },
          },
        },
      };
    }
    if (request.path.endsWith("/members") && request.method === "GET")
      return {
        body: {
          code: 0,
          data: {
            items: [
              {
                member_id: config.appId,
                member_type: "appid",
                perm: "full_access",
              },
              ...(closed
                ? [
                    {
                      member_id: "ou_unapproved",
                      member_type: "openid",
                      perm: "view",
                    },
                  ]
                : []),
            ],
          },
        },
      };
    return undefined;
  });
  expect(await coordinator.completeDailyBrief({ briefId, now })).toMatchObject({
    status: "review_required",
  });
  expect(blocks()).toEqual([]);
});

test("publishes a formatted private Doc with verified management editor access and a durable link announcement", async () => {
  const { coordinator, provider, lark, briefId, blocks, members } =
    await setup();
  expect(
    await coordinator.completeDailyBrief({ briefId: briefId, now }),
  ).toMatchObject({
    status: "published",
    documentUrl: "https://synthetic.larksuite.com/docx/docSynthetic",
  });
  const stored = coordinator.getBrief(briefId);
  expect(stored).toMatchObject({
    publicationState: "published",
    documentUrl: "https://synthetic.larksuite.com/docx/docSynthetic",
    documentRevision: 2,
  });
  expect(JSON.stringify(stored)).not.toContain("Draft client drawings.");
  expect(JSON.stringify(stored)).not.toContain("Check project estimates.");
  expect(blocks()).toContainEqual({
    block_type: 12,
    bullet: {
      elements: [
        {
          text_run: {
            content: "Bob (late): ",
            text_element_style: { bold: true },
          },
        },
        { text_run: { content: "Check project estimates." } },
      ],
    },
  });
  expect(blocks()).toContainEqual({
    block_type: 2,
    text: {
      elements: [
        {
          text_run: {
            content: "AI-generated brief.",
            text_element_style: { italic: true, text_color: 7 },
          },
        },
      ],
    },
  });
  expect(members()).toEqual([
    {
      member_type: "openchat",
      member_id: "oc_management",
      perm: "edit",
      type: "chat",
    },
  ]);
  const delivery = coordinator.getDelivery(
    stored?.announcementDeliveryId ?? "",
  );
  expect(delivery).toMatchObject({
    kind: "brief",
    state: "sent",
    messageId: "om_brief",
    text: "Today's brief — 2026-10-01\nhttps://synthetic.larksuite.com/docx/docSynthetic",
  });
  expect(provider.requests).toHaveLength(1);
  expect(
    lark.requests.filter((r) => r.path === "/open-apis/im/v1/messages"),
  ).toHaveLength(1);
});

test("restarting a published brief preserves human edits and retries only its saved announcement", async () => {
  const { coordinator, options, provider, lark, briefId, blocks } =
    await setup();
  expect((await coordinator.completeDailyBrief({ briefId, now })).status).toBe(
    "published",
  );
  blocks().push({
    block_type: 2,
    text: {
      elements: [
        { text_run: { content: "Human correction after publication" } },
      ],
    },
  });
  const stored = coordinator.getBrief(briefId);
  const before = lark.requests.length;
  const restarted = openBriefCoordinator(options);
  cleanups.push(restarted.close);
  expect(await restarted.completeDailyBrief({ briefId, now })).toMatchObject({
    status: "published",
    documentUrl: stored?.documentUrl,
    deliveryId: stored?.announcementDeliveryId,
  });
  expect(lark.requests).toHaveLength(before);
  expect(provider.requests).toHaveLength(1);
  expect(
    restarted.getDelivery(stored?.announcementDeliveryId ?? "")?.sendUuid,
  ).toBe(
    coordinator.getDelivery(stored?.announcementDeliveryId ?? "")?.sendUuid,
  );
});

test("recovers a fully written known Doc after a lost write acknowledgement without regenerating or rewriting", async () => {
  let loseWrite = true;
  const { coordinator, options, provider, lark, briefId } = await setup(
    (request) => {
      if (loseWrite && request.path.endsWith("/children"))
        return { status: 503, body: { code: 1 } };
      return undefined;
    },
  );
  expect((await coordinator.completeDailyBrief({ briefId, now })).status).toBe(
    "review_required",
  );
  expect(coordinator.getBrief(briefId)?.documentUrl).toBe(
    "https://synthetic.larksuite.com/docx/docSynthetic",
  );
  loseWrite = false;
  const restarted = openBriefCoordinator(options);
  cleanups.push(restarted.close);
  expect((await restarted.completeDailyBrief({ briefId, now })).status).toBe(
    "published",
  );
  expect(provider.requests).toHaveLength(1);
  expect(
    lark.requests.filter((r) => r.path.endsWith("/children")),
  ).toHaveLength(1);
  expect(
    lark.requests.filter((r) => r.path === "/open-apis/docx/v1/documents"),
  ).toHaveLength(1);
});

test("verifies native readback with server defaults, reordered object keys and paginated blocks", async () => {
  const { coordinator, briefId } = await setup((request, result) => {
    if (!request.path.endsWith("/blocks")) return undefined;
    const body = result.body as {
      code: number;
      data: { items: { block_type: number; [key: string]: unknown }[] };
    };
    const items = body.data.items.map((item) => {
      const value = item[
        (
          { 2: "text", 3: "heading1", 4: "heading2", 12: "bullet" } as Record<
            number,
            string
          >
        )[item.block_type] ?? ""
      ] as
        | {
            elements?: {
              text_run: { content: string; text_element_style?: object };
            }[];
            style?: object;
          }
        | undefined;
      if (value?.elements) {
        value.elements = value.elements.map((element) => ({
          text_run: {
            text_element_style: {
              bold: false,
              italic: false,
              underline: false,
              ...element.text_run.text_element_style,
            },
            content: element.text_run.content,
          },
        }));
        value.style = { align: 1, done: false, ...value.style };
      }
      return item;
    });
    const second = request.query.page_token === "second";
    return {
      body: {
        code: 0,
        data: {
          items: second ? items.slice(3) : items.slice(0, 3),
          has_more: !second,
          ...(second ? {} : { page_token: "second" }),
        },
      },
    };
  });
  expect((await coordinator.completeDailyBrief({ briefId, now })).status).toBe(
    "published",
  );
});

test("recovers an acknowledged editor grant by reading collaborators instead of granting again", async () => {
  let loseGrant = true;
  const { coordinator, options, lark, briefId } = await setup((request) => {
    if (
      loseGrant &&
      request.path.endsWith("/members") &&
      request.method === "POST"
    )
      return { status: 503, body: { code: 1 } };
    return undefined;
  });
  expect((await coordinator.completeDailyBrief({ briefId, now })).status).toBe(
    "review_required",
  );
  loseGrant = false;
  const restarted = openBriefCoordinator(options);
  cleanups.push(restarted.close);
  expect((await restarted.completeDailyBrief({ briefId, now })).status).toBe(
    "published",
  );
  expect(
    lark.requests.filter(
      (r) => r.path.endsWith("/members") && r.method === "POST",
    ),
  ).toHaveLength(1);
});

test("a competing publisher cannot create or send while another publisher owns the Doc claim", async () => {
  let signalCreate: () => void = () => {};
  const creating = new Promise<void>((resolve) => {
    signalCreate = resolve;
  });
  const { coordinator, options, lark, briefId } = await setup(
    (request, result) => {
      if (request.path === "/open-apis/docx/v1/documents") {
        signalCreate();
        return { ...result, delayMs: 80 };
      }
      return undefined;
    },
  );
  const first = coordinator.completeDailyBrief({ briefId, now });
  await creating;
  const other = openBriefCoordinator(options);
  cleanups.push(other.close);
  const competing = await other.completeDailyBrief({ briefId, now });
  const completed = await first;
  expect(competing).toMatchObject({
    status: "not_started",
    reason: "publication_claim_active",
  });
  expect(completed.status).toBe("published");
  expect(
    lark.requests.filter((r) => r.path === "/open-apis/docx/v1/documents"),
  ).toHaveLength(1);
});

test("an expired publication claim cannot write content or grant access after a delayed privacy check", async () => {
  let current = now;
  const { coordinator, lark, briefId } = await setup(
    (request) => {
      if (request.path.endsWith("/public")) current = now + 10 * 60_000 + 1;
      return undefined;
    },
    { clock: () => current },
  );
  expect((await coordinator.completeDailyBrief({ briefId, now })).status).toBe(
    "review_required",
  );
  expect(
    lark.requests.filter(
      (r) =>
        r.path.endsWith("/children") ||
        (r.path.endsWith("/members") && r.method === "POST"),
    ),
  ).toHaveLength(0);
});

test("a lost create response records unknown creation and never creates a replacement", async () => {
  const { coordinator, options, lark, provider, briefId } = await setup(
    (request) =>
      request.path === "/open-apis/docx/v1/documents"
        ? { body: {}, disconnect: true }
        : undefined,
  );
  expect(await coordinator.completeDailyBrief({ briefId, now })).toMatchObject({
    status: "review_required",
    reason: "document_creation_unknown",
  });
  expect(coordinator.getBrief(briefId)).toMatchObject({
    publicationState: "review_required",
    publicationLastError: "document_creation_unknown",
    documentUrl: null,
    announcementDeliveryId: null,
  });
  const restarted = openBriefCoordinator(options);
  cleanups.push(restarted.close);
  expect((await restarted.completeDailyBrief({ briefId, now })).status).toBe(
    "review_required",
  );
  expect(provider.requests).toHaveLength(1);
  expect(
    lark.requests.filter((r) => r.path === "/open-apis/docx/v1/documents"),
  ).toHaveLength(1);
  expect(
    lark.requests.filter(
      (r) =>
        r.path.endsWith("/children") || r.path === "/open-apis/im/v1/messages",
    ),
  ).toHaveLength(0);
});

test("unapproved collaborators discovered before sharing block management access and announcements", async () => {
  let memberReads = 0;
  const { coordinator, lark, briefId } = await setup((request) => {
    if (
      request.path.endsWith("/members") &&
      request.method === "GET" &&
      ++memberReads > 1
    )
      return {
        body: {
          code: 0,
          data: {
            items: [
              {
                member_type: "openchat",
                member_id: "oc_unapproved",
                perm: "view",
              },
            ],
          },
        },
      };
    return undefined;
  });
  expect((await coordinator.completeDailyBrief({ briefId, now })).status).toBe(
    "review_required",
  );
  expect(
    lark.requests.filter(
      (r) =>
        r.method === "POST" &&
        (r.path.endsWith("/members") || r.path === "/open-apis/im/v1/messages"),
    ),
  ).toHaveLength(0);
});

test("publication recovery rejects a changed staging folder or tenant link configuration", async () => {
  const { coordinator, options, lark, briefId } = await setup();
  expect((await coordinator.completeDailyBrief({ briefId, now })).status).toBe(
    "published",
  );
  const before = lark.requests.length;
  const changed = openBriefCoordinator({
    ...options,
    docPublishing: {
      ...options.docPublishing,
      stagingFolderToken: "folderDifferent",
    },
  });
  cleanups.push(changed.close);
  expect(await changed.completeDailyBrief({ briefId, now })).toMatchObject({
    status: "blocked",
    reason: "publication_configuration_mismatch",
  });
  expect(lark.requests).toHaveLength(before);
});

test("a previously completed source fallback can be published without another model attempt", async () => {
  const { options, provider, briefId } = await setup(undefined, {
    providerStatus: 401,
    providerBody: { error: { code: 401 } },
  });
  const {
    docPublishing: _docs,
    transport: _transport,
    ...generationOptions
  } = options;
  const generationOnly = openBriefCoordinator(generationOptions);
  cleanups.push(generationOnly.close);
  expect(
    (await generationOnly.completeDailyBrief({ briefId, now })).status,
  ).toBe("ready");
  const publisher = openBriefCoordinator(options);
  cleanups.push(publisher.close);
  expect((await publisher.completeDailyBrief({ briefId, now })).status).toBe(
    "published",
  );
  expect(publisher.getBrief(briefId)?.generationKind).toBe("fallback");
  expect(provider.requests).toHaveLength(1);
});

test("partial multi-batch writes remain for review without appending, duplicating or dropping people", async () => {
  const input = scan(
    Array.from({ length: 60 }, (_, i) =>
      message(`Person${i}`, "09:45:00", `Task ${i}`),
    ),
  );
  const { coordinator, options, lark, provider, briefId, blocks } = await setup(
    (request) =>
      request.path.endsWith("/children")
        ? { body: {}, disconnect: true }
        : undefined,
    { input, providerStatus: 401, providerBody: { error: { code: 401 } } },
  );
  expect((await coordinator.completeDailyBrief({ briefId, now })).status).toBe(
    "review_required",
  );
  expect(blocks()).toHaveLength(50);
  expect(coordinator.getBrief(briefId)?.entries).toHaveLength(60);
  const restarted = openBriefCoordinator(options);
  cleanups.push(restarted.close);
  expect((await restarted.completeDailyBrief({ briefId, now })).status).toBe(
    "review_required",
  );
  expect(provider.requests).toHaveLength(1);
  expect(
    lark.requests.filter((r) => r.path.endsWith("/children")),
  ).toHaveLength(1);
  expect(
    lark.requests.filter((r) => r.path === "/open-apis/im/v1/messages"),
  ).toHaveLength(0);
});

test("an empty capture publishes a truthful native Doc without contacting a model", async () => {
  const { coordinator, provider, briefId, blocks } = await setup(undefined, {
    input: scan([]),
  });
  expect((await coordinator.completeDailyBrief({ briefId, now })).status).toBe(
    "published",
  );
  expect(provider.requests).toHaveLength(0);
  expect(JSON.stringify(blocks())).toContain(
    "No qualifying task lists received before 10:15 AM Nairobi.",
  );
  expect(JSON.stringify(blocks())).not.toContain("AI-generated brief.");
  expect(coordinator.getBrief(briefId)?.generationKind).toBe("empty");
});

test("fallback publishes every source extract in bounded native block batches with a distinct footer", async () => {
  const input = scan(
    Array.from({ length: 60 }, (_, i) =>
      message(`Person${i}`, "09:45:00", `Task ${i}`),
    ),
  );
  const { coordinator, lark, provider, briefId, blocks } = await setup(
    undefined,
    { input, providerStatus: 401, providerBody: { error: { code: 401 } } },
  );
  expect((await coordinator.completeDailyBrief({ briefId, now })).status).toBe(
    "published",
  );
  expect(provider.requests).toHaveLength(1);
  expect(
    blocks().filter(
      (block) => (block as { block_type: number }).block_type === 12,
    ),
  ).toHaveLength(60);
  expect(JSON.stringify(blocks())).toContain(
    "AI unavailable — prepared from submitted task lists.",
  );
  expect(
    lark.requests
      .filter((r) => r.path.endsWith("/children"))
      .map((r) => (r.body as { children: unknown[] }).children.length),
  ).toEqual([50, 14]);
  expect(coordinator.getBrief(briefId)?.documentWriteTokens).toHaveLength(2);
  expect(coordinator.getBrief(briefId)?.documentRevision).toBe(3);
});

test("online backup and isolated restore preserve the Doc reference without generated content and pause external work", async () => {
  const { coordinator, options, lark, provider, briefId } = await setup();
  expect((await coordinator.completeDailyBrief({ briefId, now })).status).toBe(
    "published",
  );
  const backup = join(options.databasePath, "..", "backup.sqlite");
  const restored = join(options.databasePath, "..", "restored.sqlite");
  const command = (args: string[]) =>
    spawnSync(
      process.execPath,
      ["--import", "tsx", "src/storage-command.ts", ...args],
      {
        encoding: "utf8",
        timeout: 10000,
        env: { PATH: process.env.PATH, SQLITE_FILE_PATH: options.databasePath },
      },
    );
  const saved = command(["backup", "--output", backup]);
  expect(saved.status).toBe(0);
  expect(
    readFileSync(backup).includes(Buffer.from("Draft client drawings.")),
  ).toBe(false);
  expect(
    readFileSync(backup).includes(Buffer.from("Check project estimates.")),
  ).toBe(false);
  expect(
    command(["restore", "--backup", backup, "--output", restored]).status,
  ).toBe(0);
  const inspected = openBriefCoordinator({
    ...options,
    databasePath: restored,
  });
  cleanups.push(inspected.close);
  expect(inspected.getBrief(briefId)).toMatchObject({
    publicationState: "published",
    documentUrl: "https://synthetic.larksuite.com/docx/docSynthetic",
  });
  const before = lark.requests.length;
  expect(await inspected.completeDailyBrief({ briefId, now })).toMatchObject({
    status: "not_started",
    reason: "restore_review_required",
  });
  expect(lark.requests).toHaveLength(before);
  expect(provider.requests).toHaveLength(1);
});

test("restore pause introduced during publication prevents content writes and sharing", async () => {
  let path = "";
  const { coordinator, options, lark, briefId } = await setup((request) => {
    if (request.path.endsWith("/public"))
      writeFileSync(`${path}-restore-review.json`, "{}");
    return undefined;
  });
  path = options.databasePath;
  expect((await coordinator.completeDailyBrief({ briefId, now })).status).toBe(
    "review_required",
  );
  expect(coordinator.getBrief(briefId)?.documentUrl).toBe(
    "https://synthetic.larksuite.com/docx/docSynthetic",
  );
  expect(
    lark.requests.filter(
      (r) =>
        r.path.endsWith("/children") ||
        (r.path.endsWith("/members") && r.method === "POST"),
    ),
  ).toHaveLength(0);
  expect(await coordinator.completeDailyBrief({ briefId, now })).toMatchObject({
    status: "not_started",
    reason: "restore_review_required",
  });
});

test("a retryable link announcement reuses the saved link and UUID while retaining human edits", async () => {
  let current = now;
  let sends = 0;
  const { coordinator, options, lark, provider, briefId, blocks } = await setup(
    (request) => {
      if (request.path === "/open-apis/im/v1/messages" && ++sends === 1)
        return { body: { code: 230020 } };
      return undefined;
    },
    { clock: () => current },
  );
  expect((await coordinator.completeDailyBrief({ briefId, now })).status).toBe(
    "published",
  );
  const id = coordinator.getBrief(briefId)?.announcementDeliveryId ?? "";
  expect(coordinator.getDelivery(id)?.state).toBe("retryable");
  const uuid = coordinator.getDelivery(id)?.sendUuid;
  blocks().push({
    block_type: 2,
    text: { elements: [{ text_run: { content: "Management's correction" } }] },
  });
  current += 30000;
  const restarted = openBriefCoordinator(options);
  cleanups.push(restarted.close);
  expect(
    (await restarted.completeDailyBrief({ briefId, now: current })).status,
  ).toBe("published");
  expect(restarted.getDelivery(id)).toMatchObject({
    state: "sent",
    sendUuid: uuid,
    attemptCount: 2,
  });
  expect(
    lark.requests.filter((r) => r.path.endsWith("/children")),
  ).toHaveLength(1);
  expect(
    lark.requests.filter((r) => r.path === "/open-apis/docx/v1/documents"),
  ).toHaveLength(1);
  expect(provider.requests).toHaveLength(1);
  expect(
    lark.requests
      .filter((r) => r.path === "/open-apis/im/v1/messages")
      .map((r) => (r.body as { uuid: string }).uuid),
  ).toEqual([uuid, uuid]);
});

test("a readback page without an explicit completion flag cannot authorize publication", async () => {
  const { coordinator, lark, briefId } = await setup((request, result) => {
    if (!request.path.endsWith("/blocks")) return undefined;
    const data = (result.body as { data: { items: unknown[] } }).data;
    return { body: { code: 0, data: { items: data.items } } };
  });
  expect((await coordinator.completeDailyBrief({ briefId, now })).status).toBe(
    "review_required",
  );
  expect(
    lark.requests.filter(
      (r) =>
        (r.path.endsWith("/members") && r.method === "POST") ||
        r.path === "/open-apis/im/v1/messages",
    ),
  ).toHaveLength(0);
});

test("a scheduled work deadline crossed during Doc privacy checks stops content writes and sharing", async () => {
  let current = now;
  const deadlineMs = now + 60000;
  const { coordinator, lark, briefId } = await setup(
    (request) => {
      if (request.path.endsWith("/public")) current = deadlineMs;
      return undefined;
    },
    { clock: () => current },
  );
  expect(
    (await coordinator.completeDailyBrief({ briefId, now, deadlineMs })).status,
  ).toBe("review_required");
  expect(
    lark.requests.filter(
      (r) =>
        r.path.endsWith("/children") ||
        (r.method === "POST" && r.path.endsWith("/members")) ||
        r.path === "/open-apis/im/v1/messages",
    ),
  ).toHaveLength(0);
});
