// Synthetic loopback HTTP for the real command/SDK; never part of the release image.
import { createServer } from "node:http";
import { defaultHttpInstance } from "@larksuiteoapi/node-sdk";

if (process.env.WORKER_TEST_HTTP === "true") {
  const sourceChatId = "oc_source";
  const date = "2026-10-02";
  const draft = {
    rows: [
      { entryRef: "entry-1", summary: "Prepare drawings." },
      { entryRef: "entry-2", summary: "Review estimates." },
    ],
    notes: [],
  };
  let title = "",
    revision = 1,
    members = [];
  const blocks = [];
  function responseFor(method, path, body) {
    if (path.startsWith("/open-apis/bot/v2/hook/")) {
      const reminder = body?.content?.text?.startsWith(
        "Please post today's task list",
      );
      const expected = reminder
        ? "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb"
        : "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
      return {
        code:
          method === "POST" &&
          path.endsWith(expected) &&
          body.sign &&
          body.timestamp
            ? 0
            : 19024,
      };
    }
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
          {
            finish_reason: "stop",
            message: { content: JSON.stringify(draft) },
          },
        ],
      };
    if (path.includes("tenant_access_token"))
      return { code: 0, tenant_access_token: "synthetic-token", expire: 7200 };
    if (path === "/open-apis/im/v1/messages") {
      if (method === "POST")
        return {
          code: 0,
          data: {
            message_id:
              body.receive_id === "oc_source"
                ? "om_reminder"
                : `om_release_${body.uuid}`,
            chat_id:
              body.receive_id === "ou_admin" ? "oc_direct" : body.receive_id,
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
            body: {
              content: JSON.stringify({ text: `Task list\n1. ${task}` }),
            },
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
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    try {
      const result = responseFor(
        req.method,
        new URL(req.url, "http://localhost").pathname,
        body,
      );
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
    } catch {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: 1 }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  const base = `http://127.0.0.1:${server.address().port}`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => {
    const target = new URL(url);
    if (
      target.origin !== "https://generativelanguage.googleapis.com" &&
      !(
        target.origin === "https://open.larksuite.com" &&
        target.pathname.startsWith("/open-apis/bot/v2/hook/")
      )
    )
      throw new Error("Unexpected model origin");
    return originalFetch(base + target.pathname + target.search, options);
  };
  const rewrite = (request) => {
    const target = new URL(request.url);
    if (target.origin !== "https://open.larksuite.com")
      throw new Error("Unexpected external origin");
    request.url = base + target.pathname + target.search;
    request.proxy = false;
    return request;
  };
  defaultHttpInstance.interceptors.request.use(rewrite);
  const create = defaultHttpInstance.create.bind(defaultHttpInstance);
  defaultHttpInstance.create = (...args) => {
    const http = create(...args);
    http.interceptors.request.use(rewrite);
    return http;
  };
}
