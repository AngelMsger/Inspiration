/** Live Feishu docx reads. A complete, revision-pinned block listing precedes each import. */
import { type ConnectorContext, type Source, schemaErrors } from "@inspiration/contracts";
import { ConnectionError, remoteJson } from "../http.ts";
import type { DocumentMeta, FeishuApi, FeishuBlock, FeishuDocument } from "./api.ts";

const ROOT = "https://open.feishu.cn/open-apis/";
const OBJECT = { type: "object" };
const META = {
  type: "object",
  required: ["document"],
  properties: {
    document: {
      type: "object",
      required: ["document_id", "revision_id", "title"],
      properties: {
        document_id: { type: "string", pattern: "^[a-zA-Z0-9]+$" },
        revision_id: { type: "integer", minimum: 0 },
        title: { type: "string" },
      },
    },
  },
};
const BLOCKS = {
  type: "object",
  required: ["items", "has_more"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        required: ["block_id", "block_type"],
        properties: {
          block_id: { type: "string" },
          block_type: { type: "integer" },
          children: { type: "array", items: { type: "string" } },
        },
      },
    },
    has_more: { type: "boolean" },
    page_token: { type: "string" },
  },
};

/** Only docx and wiki page links are accepted; links are parsed locally, never fetched. */
export function feishuLink(link: string): { kind: "docx" | "wiki"; token: string; url: string } {
  const url = new URL(link);
  const match = /^\/(docx|wiki)\/([a-zA-Z0-9]+)\/?$/.exec(url.pathname);
  if (
    url.protocol !== "https:" ||
    !(url.hostname === "feishu.cn" || url.hostname.endsWith(".feishu.cn")) ||
    url.username ||
    url.password ||
    !match
  ) {
    throw new RangeError("use a Feishu docx or wiki page URL");
  }
  return { kind: match[1] as "docx" | "wiki", token: match[2] as string, url: `${url.origin}${url.pathname}` };
}

export class HttpFeishuApi implements FeishuApi {
  readonly connectionScoped = true;
  readonly #source: Source;
  readonly #ctx: ConnectorContext;
  readonly #targets = new Map<string, ReturnType<typeof feishuLink>>();
  #token?: { value: string; until: number };

  constructor(source: Source, ctx: ConnectorContext) {
    this.#source = source;
    this.#ctx = ctx;
    if (!source.scope.ids?.length) throw new RangeError("add at least one Feishu document URL");
    for (const input of source.scope.ids) {
      const link = feishuLink(input);
      // A wiki page keeps its identity even if its underlying docx target changes.
      this.#targets.set(link.kind === "wiki" ? `wiki:${link.token}` : link.token, link);
    }
  }

  async #access(): Promise<string> {
    if (this.#token && this.#token.until > Date.now()) return this.#token.value;
    const credentials: unknown = JSON.parse(await this.#ctx.secret(this.#source.credentials_ref ?? ""));
    if (
      schemaErrors(
        {
          type: "object",
          required: ["app_id", "app_secret"],
          properties: {
            app_id: { type: "string", minLength: 1 },
            app_secret: { type: "string", minLength: 1 },
          },
          additionalProperties: false,
        },
        credentials,
      ).length
    )
      throw new ConnectionError("Feishu: configure the app ID and app secret.");
    const data = await remoteJson<{ code: number; tenant_access_token?: string; expire?: number }>(
      new URL(`${ROOT}auth/v3/tenant_access_token/internal`),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(credentials),
      },
      {
        type: "object",
        required: ["code"],
        properties: { code: { type: "integer" }, tenant_access_token: { type: "string" }, expire: { type: "number" } },
      },
      "Feishu",
    );
    if (data.code !== 0 || !data.tenant_access_token || !data.expire)
      throw new ConnectionError(
        `Feishu: app authentication failed (${data.code}). Check app ID, app secret and app availability.`,
      );
    this.#token = { value: data.tenant_access_token, until: Date.now() + Math.max(0, data.expire - 60) * 1000 };
    return this.#token.value;
  }

  async #get<T>(path: string, schema: object): Promise<T> {
    const token = await this.#access();
    const response = await remoteJson<{ code: number; data?: unknown }>(
      new URL(path, ROOT),
      { headers: { authorization: `Bearer ${token}` } },
      {
        type: "object",
        required: ["code"],
        properties: { code: { type: "integer" }, data: OBJECT },
      },
      "Feishu",
    );
    if (response.code !== 0) {
      this.#token = undefined;
      throw new ConnectionError(
        `Feishu: API error ${response.code}. Check app permissions, publication status and document sharing with the app, then retry.`,
      );
    }
    if (schemaErrors(schema, response.data).length)
      throw new ConnectionError("Feishu: incomplete API response; retry sync.");
    return response.data as T;
  }

  async listDocuments(): Promise<{ document_id: string; url: string }[]> {
    return [...this.#targets].map(([document_id, link]) => ({ document_id, url: link.url }));
  }

  async document(targetId: string): Promise<FeishuDocument> {
    const link = this.#targets.get(targetId);
    if (!link) throw new RangeError("unknown Feishu document target");
    let id = link.token;
    if (link.kind === "wiki") {
      const { node } = await this.#get<{ node: { obj_type: string; obj_token: string } }>(
        `wiki/v2/spaces/get_node?token=${id}`,
        {
          type: "object",
          required: ["node"],
          properties: {
            node: {
              type: "object",
              required: ["obj_type", "obj_token"],
              properties: {
                obj_type: { type: "string" },
                obj_token: { type: "string", pattern: "^[a-zA-Z0-9]+$" },
              },
            },
          },
        },
      );
      if (node.obj_type !== "docx")
        throw new ConnectionError("Feishu: this wiki node is not an upgraded document (docx).");
      id = node.obj_token;
    }
    const { document: meta } = await this.#get<{ document: Omit<DocumentMeta, "modified_at"> }>(
      `docx/v1/documents/${id}`,
      META,
    );
    const blocks: FeishuBlock[] = [];
    let cursor = "";
    const seen = new Set<string>();
    do {
      const query = new URLSearchParams({
        page_size: "500",
        document_revision_id: String(meta.revision_id),
        ...(cursor && { page_token: cursor }),
      });
      const page = await this.#get<{ items: FeishuBlock[]; has_more: boolean; page_token?: string }>(
        `docx/v1/documents/${id}/blocks?${query}`,
        BLOCKS,
      );
      blocks.push(...page.items);
      cursor = page.has_more ? (page.page_token ?? "") : "";
      if (page.has_more && (!cursor || seen.has(cursor)))
        throw new ConnectionError("Feishu: incomplete block listing; retry sync.");
      seen.add(cursor);
    } while (cursor);
    return { meta: { ...meta, url: link.url }, blocks, members: [] };
  }

  async listApprovals(): Promise<never> {
    throw new RangeError("live approvals are not supported");
  }
  async approval(): Promise<never> {
    throw new RangeError("live approvals are not supported");
  }
}
