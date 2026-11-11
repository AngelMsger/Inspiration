/** Confluence Data Center/Server pages, scoped to one space, using a personal access token.
 * The connection's view is imported into the destination space; source ACLs are not mirrored.
 * Reading rendered HTML includes supported Confluence macros without treating storage XML as text.
 */
import {
  type Connector,
  type ConnectorContext,
  type Cursor,
  canonicalJson,
  contentHash,
  type ListPage,
  type NormalizedDocument,
  type ScopeSpec,
  type Source,
  type SourceRef,
  sameVersion,
  type Version,
} from "@inspiration/contracts";
import { aclSnapshot } from "./acl.ts";
import { connectionUrl, remoteJson } from "./http.ts";

const PAGE_REF = {
  type: "object",
  required: ["id", "title"],
  properties: {
    id: { type: "string", pattern: "^[0-9]+$" },
    title: { type: "string" },
  },
};
const PAGE = {
  type: "object",
  required: ["id", "title", "version", "body", "ancestors"],
  properties: {
    id: { type: "string", pattern: "^[0-9]+$" },
    title: { type: "string" },
    version: {
      type: "object",
      required: ["number", "when"],
      properties: {
        number: { type: "integer", minimum: 1 },
        when: { type: "string", format: "date-time" },
      },
    },
    body: {
      type: "object",
      required: ["view"],
      properties: {
        view: {
          type: "object",
          required: ["value"],
          properties: { value: { type: "string" } },
        },
      },
    },
    ancestors: {
      type: "array",
      items: { type: "object", required: ["title"], properties: { title: { type: "string" } } },
    },
  },
};
interface Page {
  id: string;
  title: string;
  version: { number: number; when: string };
  body: { view: { value: string } };
  ancestors: { title: string }[];
}
interface PageList {
  results: Pick<Page, "id" | "title">[];
  start: number;
  limit: number;
  size: number;
  _links?: { next?: string };
}
const EXPAND = "version,body.view,ancestors";

export class ConfluenceConnector implements Connector {
  readonly type = "confluence";
  readonly source: Source;
  readonly #ctx: ConnectorContext;
  readonly #base: URL;

  constructor(source: Source, ctx: ConnectorContext) {
    this.source = source;
    this.#ctx = ctx;
    this.#base = connectionUrl(String(source.scope.options?.base_url ?? ""));
    if (source.scope.ids?.length !== 1 || !source.scope.ids[0]) throw new RangeError("choose one Confluence space key");
  }

  capabilities() {
    return { list: true, fetch: true, acl: true, acl_fidelity: "connection_scoped" as const, files: true };
  }

  async #read<T>(path: string, schema: object): Promise<T> {
    const token = await this.#ctx.secret(this.source.credentials_ref ?? "");
    return remoteJson<T>(
      new URL(path, this.#base),
      { headers: { authorization: `Bearer ${token}`, accept: "application/json" } },
      schema,
      "Confluence",
    );
  }

  #ref(page: Pick<Page, "id" | "title">): SourceRef {
    return {
      source_id: this.source.id,
      external_id: page.id,
      title: page.title,
      kind: "document",
      uri: new URL(`pages/viewpage.action?pageId=${page.id}`, this.#base).href,
    };
  }

  #version(page: Page): Version {
    return {
      external_version: String(page.version.number),
      modified_at: page.version.when,
      content_hash: contentHash(page.body.view.value),
      metadata_hash: contentHash(canonicalJson([page.title, page.ancestors])),
      acl_hash: this.#acl(page.id).acl_hash,
    };
  }

  async list(scope: ScopeSpec, cursor?: Cursor): Promise<ListPage> {
    const start = cursor ? Number(cursor) : 0;
    if (!Number.isSafeInteger(start) || start < 0) throw new RangeError("invalid Confluence cursor");
    const query = new URLSearchParams({
      spaceKey: scope.ids?.[0] ?? "",
      type: "page",
      status: "current",
      start: String(start),
      limit: "25",
    });
    const page = await this.#read<PageList>(`rest/api/content?${query}`, {
      type: "object",
      required: ["results", "start", "limit", "size"],
      properties: {
        results: { type: "array", items: PAGE_REF },
        start: { const: start },
        limit: { type: "integer", minimum: 1 },
        size: { type: "integer", minimum: 0 },
        _links: { type: "object", properties: { next: { type: "string" } } },
      },
    });
    if (page._links?.next && !page.results.length)
      throw new RangeError("Confluence returned an incomplete page; retry sync");
    // Only use the server's indication of another page, never its URL, which could move the token to another host.
    return {
      items: page.results.map((p) => ({ ref: this.#ref(p) })),
      ...(page._links?.next && { next_cursor: String(start + page.results.length) }),
    };
  }

  async fetch(ref: SourceRef, known?: Version) {
    if (!/^\d+$/.test(ref.external_id)) throw new RangeError("invalid Confluence page ID");
    const page = await this.#read<Page>(`rest/api/content/${ref.external_id}?expand=${EXPAND}`, PAGE);
    const version = this.#version(page);
    if (sameVersion(known, version)) return { unchanged: true as const };
    const file = await this.#ctx.blobs.put(new TextEncoder().encode(page.body.view.value), {
      mimeType: "text/html",
      filename: `${page.id}.html`,
    });
    const doc: NormalizedDocument = {
      ref: this.#ref(page),
      version,
      title: page.title,
      mime_type: "text/html",
      file,
      metadata: { modified_at: page.version.when, path: page.ancestors.map((a) => a.title), url: this.#ref(page).uri },
      acl: this.#acl(page.id),
    };
    return doc;
  }

  #acl(id: string) {
    return aclSnapshot(this.source.id, id, [], { fidelity: "connection_scoped", capturedAt: new Date() });
  }
  async acl(ref: SourceRef) {
    return this.#acl(ref.external_id);
  }
}

export function confluenceConnector(source: Source, ctx: ConnectorContext): Connector {
  return new ConfluenceConnector(source, ctx);
}
