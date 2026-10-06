import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { createBriefGenerator } from "/app/dist/brief-generator-factory.js";
import { openBriefLedger } from "/app/dist/brief-ledger.js";
import { createDueWorker } from "/app/dist/due-worker.js";
import { createLarkDeliveryTransport } from "/app/dist/lark-delivery.js";
import { openReportLedger } from "/app/dist/report-ledger.js";

// Mounted acceptance driver only: real packaged modules, synthetic loopback HTTP,
// and in-memory remote Doc state. No fixture bodies are written to disk or logs.
const require = createRequire("/app/package.json");
const { defaultHttpInstance } = require("@larksuiteoapi/node-sdk");
const date = "2026-10-02";
const appId = process.env.LARK_APP_ID;
const sourceChatId = process.env.SOURCE_CHAT_ID;
const destinationChatId = process.env.MANAGEMENT_CHAT_ID;
const provider = process.env.BRIEF_PROVIDER;
const model =
  provider === "gemini" ? "gemini-3.5-flash-lite" : "deepseek-flash";
const mode = process.argv[2];
const policy = {
  appId,
  sourceChatId,
  timeZone: "Africa/Nairobi",
  publicHolidays: [],
  replyPolicy: "exclude",
  policyVersion: "synthetic-policy-v1/synthetic-release-v1",
};
const scope = {
  databasePath: process.env.SQLITE_FILE_PATH,
  appId,
  sourceChatId,
  destinationChatId,
  policy,
  provider,
  model,
  templateVersion: "template-v1",
  promptVersion: "prompt-v1",
  schemaVersion: "schema-v1",
};
const canary = "AI_ONLY_RELEASE_CANARY_47d012";
const draft = {
  rows: [
    { entryRef: "entry-1", summary: `${canary} — prepare drawings.` },
    { entryRef: "entry-2", summary: "Review estimates." },
  ],
  notes: [],
};
const requests = [];
let title = "";
let revision = 1;
const blocks = [];
let members = [];

/** Emulate external wire responses; an inspection/resume request is a release failure. */
function responseFor(method, path, body) {
  if (mode !== "publish") throw new Error("Unexpected HTTP during recovery");
  if (path.includes(":generateContent"))
    return {
      candidates: [
        {
          finishReason: "STOP",
          content: { parts: [{ text: JSON.stringify(draft) }] },
        },
      ],
    };
  if (path === "/chat/completions")
    return {
      choices: [
        { finish_reason: "stop", message: { content: JSON.stringify(draft) } },
      ],
    };
  if (path.includes("tenant_access_token"))
    return { code: 0, tenant_access_token: "synthetic-token", expire: 7200 };
  if (path === "/open-apis/im/v1/messages") {
    if (method === "POST")
      return {
        code: 0,
        data: {
          message_id: `om_release_${body.uuid}`,
          chat_id: body.receive_id,
        },
      };
    return {
      code: 0,
      data: {
        has_more: false,
        items: [
          ["Alice", "09:45:00", "Synthetic source task A"],
          ["Bob", "10:07:00", "Synthetic source task B"],
        ].map(([name, time, task]) => ({
          message_id: `om_${name}`,
          chat_id: sourceChatId,
          msg_type: "text",
          create_time: String(Date.parse(`${date}T${time}+03:00`)),
          update_time: String(Date.parse(`${date}T${time}+03:00`)),
          deleted: false,
          updated: false,
          sender: {
            id: `ou_${name}`,
            id_type: "open_id",
            sender_type: "user",
            tenant_key: "synthetic_external_tenant",
            sender_name: name,
          },
          body: { content: JSON.stringify({ text: `Task list\n1. ${task}` }) },
        })),
      },
    };
  }
  if (path === "/open-apis/docx/v1/documents") {
    title = body.title;
    return {
      code: 0,
      data: {
        document: { document_id: "docRelease", revision_id: revision, title },
      },
    };
  }
  if (path.endsWith("/children")) {
    blocks.push(...body.children);
    return { code: 0, data: { document_revision_id: ++revision } };
  }
  if (path.endsWith("/blocks"))
    return {
      code: 0,
      data: {
        has_more: false,
        items: [
          {
            block_id: "docRelease",
            block_type: 1,
            children: blocks.map((_, i) => `b${i}`),
          },
          ...blocks.map((block, i) => ({
            ...block,
            block_id: `b${i}`,
            parent_id: "docRelease",
          })),
        ],
      },
    };
  if (path.endsWith("/docRelease"))
    return {
      code: 0,
      data: {
        document: { document_id: "docRelease", revision_id: revision, title },
      },
    };
  if (path.endsWith("/public"))
    return {
      code: 0,
      data: { permission_public: { link_share_entity: "closed" } },
    };
  if (path.endsWith("/members")) {
    if (method === "POST") members = [body];
    return { code: 0, data: { items: members, member: members[0] } };
  }
  throw new Error("Unrecognised fixture route");
}

const server = createServer(async (incoming, outgoing) => {
  const chunks = [];
  for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  const url = new URL(incoming.url, "http://localhost");
  const body = raw ? JSON.parse(raw) : null;
  const method = incoming.method;
  requests.push({ method, path: url.pathname });
  try {
    const result = responseFor(method, url.pathname, body);
    outgoing.writeHead(200, { "Content-Type": "application/json" });
    outgoing.end(JSON.stringify(result));
  } catch {
    outgoing.writeHead(500, { "Content-Type": "application/json" });
    outgoing.end(JSON.stringify({ code: 1 }));
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const httpInstance = defaultHttpInstance.create({
  timeout: 1000,
  proxy: false,
});
httpInstance.interceptors.request.use((request) => {
  const target = new URL(request.url);
  if (target.origin !== "https://open.larksuite.com")
    throw new Error("Unexpected Lark origin");
  request.url = `${origin}${target.pathname}`;
  return request;
});
httpInstance.interceptors.response.use((response) => response.data);
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const target = new URL(input instanceof Request ? input.url : input);
  const expected =
    provider === "gemini"
      ? "https://generativelanguage.googleapis.com"
      : "https://api.deepseek.com";
  if (target.origin !== expected) throw new Error("Unexpected provider origin");
  return nativeFetch(`${origin}${target.pathname}${target.search}`, init);
};

try {
  const worker = createDueWorker({
    ...scope,
    activationDate: date,
    readOnly: mode === "inspect",
    calendar: JSON.parse(
      readFileSync(process.env.HOLIDAY_CALENDAR_PATH, "utf8"),
    ),
    policy: { policyVersion: "synthetic-policy-v1", replyPolicy: "exclude" },
    reminderText:
      "Please post today's task list in this group by 10:00 AM Nairobi time.",
    clock: Date.now,
    reader: {
      appId,
      sourceChatId,
      appSecret: "synthetic-secret",
      httpInstance,
      getUserAccessToken: async () => ({
        appId,
        accessToken: "synthetic-user-token",
        expiresAtMs: Date.now() + 3600000,
      }),
    },
    transport: createLarkDeliveryTransport({
      appId,
      appSecret: "synthetic-secret",
      allowedDestinationChatIds: [sourceChatId, destinationChatId],
      httpInstance,
      clock: Date.now,
    }),
    brief: {
      ...scope,
      activationDate: date,
      mode: "publish",
      generator: createBriefGenerator({
        provider,
        model,
        apiKey: "synthetic-release-key",
      }),
      template: "Today's brief",
      instructions: "Summarize only supplied tasks.",
      docPublishing: {
        appSecret: "synthetic-secret",
        stagingFolderToken: "folderPrivate",
        documentBaseUrl: "https://synthetic.larksuite.com/docx/",
        httpInstance,
      },
    },
  });
  let status;
  try {
    status =
      mode === "inspect"
        ? worker.getStatus({ now: Date.now() })
        : await worker.runDueWork({ now: Date.now() });
  } finally {
    worker.close();
  }
  const briefLedger = openBriefLedger({ ...scope, readOnly: true });
  const reportLedger = openReportLedger({ ...scope, readOnly: true });
  const reminderLedger = openReportLedger({
    ...scope,
    destinationChatId: sourceChatId,
    readOnly: true,
  });
  let saved;
  try {
    const brief = briefLedger.getDailyBrief(date);
    const briefDelivery = brief?.announcementDeliveryId
      ? reportLedger.getDelivery(brief.announcementDeliveryId)
      : null;
    const project = (delivery) =>
      delivery && {
        id: delivery.id,
        kind: delivery.kind,
        state: delivery.state,
        text: delivery.text,
        uuid: delivery.sendUuid,
        messageId: delivery.messageId,
        attemptCount: delivery.attemptCount,
      };
    saved = {
      brief: brief && {
        id: brief.id,
        documentUrl: brief.documentUrl,
        provider: brief.provider,
        generationKind: brief.generationKind,
        generationAttemptCount: brief.generationAttemptCount,
        entries: brief.entries.map((entry) => [
          entry.displayName,
          entry.timeliness,
        ]),
      },
      announcement: project(briefDelivery),
      report: project(reportLedger.getDailyDelivery(date, "report")),
      reminder: project(reminderLedger.getDailyDelivery(date, "reminder")),
    };
  } finally {
    briefLedger.close();
    reportLedger.close();
    reminderLedger.close();
  }
  const bytes = readFileSync(process.env.SQLITE_FILE_PATH);
  console.log(
    JSON.stringify({
      status,
      saved,
      http: {
        total: requests.length,
        model: requests.filter(
          (r) =>
            r.path.includes(":generateContent") ||
            r.path === "/chat/completions",
        ).length,
        docCreates: requests.filter(
          (r) => r.path === "/open-apis/docx/v1/documents",
        ).length,
      },
      retention: {
        generatedBodyStored: bytes.includes(Buffer.from(canary)),
        sourceEvidenceStored: bytes.includes(
          Buffer.from("Synthetic source task A"),
        ),
      },
      presentation: {
        modelTextPresent: JSON.stringify(blocks).includes(canary),
        lateLabelPresent: JSON.stringify(blocks).includes("Bob (late): "),
        footerPresent: JSON.stringify(blocks).includes("AI-generated brief."),
      },
    }),
  );
} finally {
  globalThis.fetch = nativeFetch;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
