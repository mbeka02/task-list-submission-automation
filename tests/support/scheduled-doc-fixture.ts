import type { CapturedLarkRequest } from "./lark-http-server.js";

/** Synthetic remote Doc state served through the real SDK; source-history requests use another fixture. */
export function scheduledDocFixture() {
  let title = "";
  let revision = 1;
  const blocks: object[] = [];
  let members: object[] = [];
  function respond(request: CapturedLarkRequest) {
    if (request.path === "/open-apis/docx/v1/documents") {
      title = (request.body as { title: string }).title;
      return {
        body: {
          code: 0,
          data: {
            document: {
              document_id: "docSchedule",
              revision_id: revision,
              title,
            },
          },
        },
      };
    }
    if (request.path.endsWith("/children")) {
      blocks.push(...(request.body as { children: object[] }).children);
      return { body: { code: 0, data: { document_revision_id: ++revision } } };
    }
    if (request.path.endsWith("/blocks"))
      return {
        body: {
          code: 0,
          data: {
            has_more: false,
            items: [
              {
                block_id: "docSchedule",
                block_type: 1,
                children: blocks.map((_, i) => `b${i}`),
              },
              ...blocks.map((block, i) => ({
                ...block,
                block_id: `b${i}`,
                parent_id: "docSchedule",
              })),
            ],
          },
        },
      };
    if (request.path.endsWith("/docSchedule"))
      return {
        body: {
          code: 0,
          data: {
            document: {
              document_id: "docSchedule",
              revision_id: revision,
              title,
            },
          },
        },
      };
    if (request.path.endsWith("/public"))
      return {
        body: {
          code: 0,
          data: { permission_public: { link_share_entity: "closed" } },
        },
      };
    if (request.path.endsWith("/members")) {
      if (request.method === "POST") members = [request.body as object];
      return {
        body: { code: 0, data: { items: members, member: members[0] } },
      };
    }
    if (
      request.path === "/open-apis/im/v1/messages" &&
      request.method === "POST"
    )
      return {
        body: {
          code: 0,
          data: {
            message_id: `om_send_${(request.body as { uuid: string }).uuid}`,
            chat_id: (request.body as { receive_id: string }).receive_id,
          },
        },
      };
    return undefined;
  }
  return { respond, blocks };
}
