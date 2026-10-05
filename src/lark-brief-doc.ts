import { createHash } from "node:crypto";
import {
  Client,
  Domain,
  defaultHttpInstance,
  type HttpInstance,
  LoggerLevel,
  withTenantToken,
} from "@larksuiteoapi/node-sdk";
import type { BriefContent } from "./brief-content.js";

/** App-owned native Docs, staged privately in an explicitly selected folder. */
export interface BriefDocOptions {
  appSecret: string;
  stagingFolderToken: string;
  /** Approved tenant URL ending in /docx/; links never come from model output. */
  documentBaseUrl: string;
  httpInstance?: HttpInstance | typeof defaultHttpInstance;
}
/** Supported native text runs; model text cannot inject mentions, links or embedded resources. */
type Element = {
  text_run: {
    content: string;
    text_element_style?: {
      bold?: boolean;
      italic?: boolean;
      text_color?: number;
    };
  };
};
type TextBlock = {
  elements: Element[];
  style?: { background_color: "LightBlueBackground" };
};
/** Flat native blocks keep creation batches and ordered readback deterministic. */
type Block = {
  block_type: number;
  text?: TextBlock;
  heading1?: TextBlock;
  heading2?: TextBlock;
  bullet?: TextBlock;
};
const fieldFor = new Map<number, "text" | "heading1" | "heading2" | "bullet">([
  [2, "text"],
  [3, "heading1"],
  [4, "heading2"],
  [12, "bullet"],
] as const);
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Render identity and lateness locally, never from model prose or Markdown instructions. */
export function renderBriefDoc(content: BriefContent) {
  const run = (content: string): Element => ({ text_run: { content } });
  const blocks: Block[] = [
    {
      block_type: 3,
      heading1: {
        elements: [run(content.title)],
        style: { background_color: "LightBlueBackground" },
      },
    },
    {
      block_type: 2,
      text: {
        elements: [
          {
            text_run: {
              content: content.captureLine,
              text_element_style: { text_color: 7 },
            },
          },
        ],
      },
    },
    { block_type: 4, heading2: { elements: [run("What everyone is doing")] } },
    ...content.rows.map(
      (row): Block => ({
        block_type: 12,
        bullet: {
          elements: [
            {
              text_run: {
                content: `${row.displayName}${row.timeliness === "late" ? " (late)" : ""}: `,
                text_element_style: { bold: true },
              },
            },
            run(row.text),
          ],
        },
      }),
    ),
  ];
  if (content.notice)
    blocks.push({ block_type: 2, text: { elements: [run(content.notice)] } });
  if (content.notes.length) {
    blocks.push({
      block_type: 4,
      heading2: { elements: [run("Relevant notes")] },
    });
    for (const note of content.notes)
      blocks.push({ block_type: 12, bullet: { elements: [run(note.text)] } });
  }
  blocks.push({
    block_type: 2,
    text: {
      elements: [
        {
          text_run: {
            content: content.footer,
            text_element_style: { italic: true, text_color: 7 },
          },
        },
      ],
    },
  });
  return { blocks, hash: digest(blocks.map(canonicalBlock)) };
}

/** Internal SDK adapter: bounded requests, app identity only, and no content-bearing logs. */
export function openLarkBriefDoc(appId: string, options: BriefDocOptions) {
  const base = new URL(options.documentBaseUrl);
  if (
    base.protocol !== "https:" ||
    !base.hostname.endsWith(".larksuite.com") ||
    base.pathname !== "/docx/" ||
    base.search ||
    base.hash ||
    base.username ||
    base.password ||
    base.port ||
    !/^[A-Za-z0-9_-]+$/.test(options.stagingFolderToken)
  )
    throw new Error("Invalid private Doc configuration");
  const http = defaultHttpInstance.create({
    timeout: 15000,
    maxRedirects: 0,
    maxContentLength: 2 * 1024 * 1024,
  });
  http.interceptors.response.use((response) => response.data);
  const silent = () => {};
  const client = new Client({
    appId,
    appSecret: options.appSecret,
    domain: Domain.Lark,
    disableTokenCache: true,
    httpInstance: (options.httpInstance ?? http) as HttpInstance,
    loggerLevel: LoggerLevel.error,
    logger: {
      error: silent,
      warn: silent,
      info: silent,
      debug: silent,
      trace: silent,
    },
  });
  let token = "";
  return {
    async authenticate() {
      const response: unknown = await client.auth.tenantAccessToken.internal({
        data: { app_id: appId, app_secret: options.appSecret },
      });
      if (
        !response ||
        typeof response !== "object" ||
        !("code" in response) ||
        response.code !== 0 ||
        !("tenant_access_token" in response) ||
        typeof response.tenant_access_token !== "string" ||
        !response.tenant_access_token
      )
        throw new Error("Doc credentials unavailable");
      token = response.tenant_access_token;
    },
    async create(title: string) {
      const response = await client.docx.document.create(
        { data: { title, folder_token: options.stagingFolderToken } },
        withTenantToken(token),
      );
      const document = response.data?.document;
      if (
        response.code !== 0 ||
        !document?.document_id ||
        !/^[A-Za-z0-9_-]+$/.test(document.document_id) ||
        !Number.isSafeInteger(document.revision_id)
      )
        throw new Error("Doc creation outcome unknown");
      return {
        url: new URL(document.document_id, base).href,
        revision: document.revision_id as number,
      };
    },
    async assertPrivate(id: string) {
      const settings = await client.drive.v2.permissionPublic.get(
        { path: { token: id }, params: { type: "docx" } },
        withTenantToken(token),
      );
      const collaborators = await client.drive.permissionMember.list(
        { path: { token: id }, params: { type: "docx" } },
        withTenantToken(token),
      );
      const members = collaborators.data?.items;
      if (
        settings.code !== 0 ||
        settings.data?.permission_public?.link_share_entity !== "closed" ||
        collaborators.code !== 0 ||
        !members ||
        members.length > 1 ||
        members.some(
          (member) =>
            member.perm !== "full_access" ||
            !["openid", "userid", "appid"].includes(member.member_type),
        )
      )
        throw new Error("Private staging access unverified");
    },
    async write(
      id: string,
      blocks: Block[],
      operationToken: string,
      revision: number,
    ) {
      const response = await client.docx.documentBlockChildren.create(
        {
          path: { document_id: id, block_id: id },
          params: {
            client_token: operationToken,
            document_revision_id: revision,
          },
          data: { children: blocks, index: -1 },
        },
        withTenantToken(token),
      );
      if (
        response.code !== 0 ||
        !Number.isSafeInteger(response.data?.document_revision_id)
      )
        throw new Error("Doc write outcome unknown");
      return response.data?.document_revision_id as number;
    },
    async verify(id: string, title: string, expectedHash: string) {
      const metadata = await client.docx.document.get(
        { path: { document_id: id } },
        withTenantToken(token),
      );
      const revision = metadata.data?.document?.revision_id;
      if (
        metadata.code !== 0 ||
        metadata.data?.document?.title !== title ||
        !Number.isSafeInteger(revision)
      )
        throw new Error("Doc metadata unverified");
      const items: {
        block_id?: string | undefined;
        parent_id?: string | undefined;
        children?: string[] | undefined;
        block_type: number;
        [key: string]: unknown;
      }[] = [];
      let pageToken: string | undefined;
      const seenTokens = new Set<string>();
      do {
        const response = await client.docx.documentBlock.list(
          {
            path: { document_id: id },
            params: {
              page_size: 500,
              document_revision_id: revision as number,
              ...(pageToken ? { page_token: pageToken } : {}),
            },
          },
          withTenantToken(token),
        );
        if (
          response.code !== 0 ||
          !response.data?.items ||
          typeof response.data.has_more !== "boolean"
        )
          throw new Error("Doc readback incomplete");
        items.push(...response.data.items);
        if (items.length > 2000) throw new Error("Doc readback exceeds bound");
        pageToken = response.data.has_more
          ? response.data.page_token
          : undefined;
        if (response.data.has_more && (!pageToken || seenTokens.has(pageToken)))
          throw new Error("Doc readback incomplete");
        if (pageToken) seenTokens.add(pageToken);
        if (seenTokens.size > 10)
          throw new Error("Doc readback exceeds page bound");
      } while (pageToken);
      const root = items.find(
        (block) => block.block_id === id && block.block_type === 1,
      );
      const children = root?.children;
      if (
        !root ||
        !children ||
        new Set(children).size !== children.length ||
        items.length !== children.length + 1 ||
        new Set(items.map((item) => item.block_id)).size !== items.length
      )
        throw new Error("Doc hierarchy unverified");
      const blocks = children.map((child) => {
        const block = items.find((item) => item.block_id === child);
        if (!block || block.parent_id !== id || block.children?.length)
          throw new Error("Doc hierarchy unverified");
        return canonicalBlock(block);
      });
      if (digest(blocks) !== expectedHash)
        throw new Error("Doc content unverified");
      const current = await client.docx.document.get(
        { path: { document_id: id } },
        withTenantToken(token),
      );
      if (
        current.code !== 0 ||
        current.data?.document?.revision_id !== revision ||
        current.data?.document?.title !== title
      )
        throw new Error("Doc changed during verification");
      return revision as number;
    },
    async share(id: string, chatId: string, guard: () => void) {
      const list = () =>
        client.drive.permissionMember.list(
          { path: { token: id }, params: { type: "docx" } },
          withTenantToken(token),
        );
      const existing = await list();
      if (existing.code !== 0 || !existing.data?.items)
        throw new Error("Doc collaborators unverified");
      if (
        existing.data.items.some(
          (member) =>
            !(
              member.member_type === "openchat" &&
              member.member_id === chatId &&
              ["view", "edit"].includes(member.perm)
            ) &&
            !(
              member.perm === "full_access" &&
              ["openid", "userid", "appid"].includes(member.member_type)
            ),
        ) ||
        existing.data.items.filter((member) => member.perm === "full_access")
          .length > 1
      )
        throw new Error("Unexpected Doc collaborators");
      const settings = await client.drive.v2.permissionPublic.get(
        { path: { token: id }, params: { type: "docx" } },
        withTenantToken(token),
      );
      if (
        settings.code !== 0 ||
        settings.data?.permission_public?.link_share_entity !== "closed"
      )
        throw new Error("Public Doc access unverified");
      const granted = existing.data.items.some(
        (member) =>
          member.member_type === "openchat" &&
          member.member_id === chatId &&
          member.perm === "edit",
      );
      if (!granted) {
        guard();
        const response = await client.drive.permissionMember.create(
          {
            path: { token: id },
            params: { type: "docx", need_notification: false },
            data: {
              member_type: "openchat",
              member_id: chatId,
              perm: "edit",
              type: "chat",
            },
          },
          withTenantToken(token),
        );
        if (response.code !== 0) throw new Error("Doc sharing unverified");
      }
      const members = await list();
      if (
        members.code !== 0 ||
        !members.data?.items?.some(
          (member) =>
            member.member_type === "openchat" &&
            member.member_id === chatId &&
            member.perm === "edit",
        )
      )
        throw new Error("Doc editor access unverified");
    },
  };
}

/** Strip benign server defaults while retaining visible text, formatting and ordered runs. */
function canonicalBlock(block: { block_type: number; [key: string]: unknown }) {
  const field = fieldFor.get(block.block_type);
  if (!field) throw new Error("Unsupported Doc block");
  const value = block[field];
  if (
    !value ||
    typeof value !== "object" ||
    !("elements" in value) ||
    !Array.isArray(value.elements)
  )
    throw new Error("Invalid Doc text block");
  const elements = value.elements.map((element: unknown) => {
    if (
      !element ||
      typeof element !== "object" ||
      !("text_run" in element) ||
      Object.keys(element).some((key) => key !== "text_run")
    )
      throw new Error("Unexpected Doc element");
    const run = element.text_run;
    if (
      !run ||
      typeof run !== "object" ||
      !("content" in run) ||
      typeof run.content !== "string"
    )
      throw new Error("Invalid Doc text");
    const style =
      "text_element_style" in run ? run.text_element_style : undefined;
    return { content: run.content, style: cleanStyle(style) };
  });
  const style = "style" in value ? value.style : undefined;
  return { type: block.block_type, elements, style: cleanStyle(style) };
}
function cleanStyle(value: unknown) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Doc style");
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key, item]) =>
          item !== false &&
          item !== undefined &&
          !(key === "align" && item === 1) &&
          !(key === "text_color" && item === 0) &&
          !(key === "comment_ids" && Array.isArray(item) && item.length === 0),
      )
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}
