/**
 * The engine's HTTP API, version 0: the queries the business layer's web app makes on behalf
 * of a member. Bodies are the contract types of libs/contracts/schema/api.yaml and
 * retrieval.yaml, validated on the way in. Routes only translate: each reads through the
 * components' own methods, and every read is checked against the member's permissions there
 * or here, before anything is returned.
 *
 *     GET  /v0/spaces                                 SpaceList
 *     GET  /v0/spaces/:space/documents                DocumentTree
 *     GET  /v0/spaces/:space/topics                   TopicList, the space's knowledge outline
 *     GET  /v0/topics/:topic                          TopicView
 *     GET  /v0/documents?source=<id>&item=<external>  DocumentView, the latest version
 *     GET  /v0/documents?version=<id>                 DocumentView, the version a citation names
 *     POST /v0/search    SearchQuery                  SearchResult
 *     POST /v0/answers   AnswerQuery                  GroundedAnswer
 *     GET  /v0/inbox                                  Inbox, the member's open todos
 *     POST /v0/todos/:todo/resolve  ResolveTodo       Todo, closed
 *     GET  /v0/spaces/:space/overview                 SpaceOverview, for the space's maintainers
 *     POST /v0/sources/:source/sync                   SyncReport, the source synced now
 *
 * Resolving a todo and syncing a source are the writes. Only a todo's assignee may resolve it
 * (a todo of anyone else's answers 404), with a resolution it offers (else 400). Only a member
 * who may administer a space reads its overview or syncs its sources (spaces.ts). Both writes
 * answer once the engine has read everything they caused, so the next read sees the change.
 *
 * Identity: until the business layer signs principal tokens, a request names its tenant and
 * member in the x-inspiration-tenant and x-inspiration-member headers. That is a development
 * stand-in, trusted as given, so the API listens on localhost only. Errors are ApiError bodies:
 * 400 for a body or header that is not valid, 401 without a member, 404 for anything unknown
 * or not readable (the two look the same, so a reader never learns what exists).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type AnswerQuery,
  type ApiError,
  type ApiErrorCode,
  ContractError,
  type DocumentTree,
  type DocumentView,
  type Principal,
  parseAs,
  type ResolveTodo,
  type SearchQuery,
  type Space,
  type SpaceList,
  slotOf,
  type Tenant,
  type TopicList,
  type TopicView,
} from "@inspiration/contracts";
import { logger } from "@inspiration/kernel";
import { documentTree, entryOf, foldersOf, type ListedDocument } from "@inspiration/source-sync";
import type { Engine } from "./engine.ts";
import { maintains, overviewOf, syncNow } from "./spaces.ts";
import { factLabels, inboxOf, resolveTodo } from "./todos.ts";

const log = logger("engine.http");

/** What the business layer provisions and the engine does not keep: tenants and spaces by name. */
export interface Directory {
  tenant(tenantId: string): Tenant | undefined;
  spaces(tenantId: string): Space[];
}

class HttpError extends Error {
  override name = "HttpError";
  readonly status: number;
  readonly code: ApiErrorCode;
  constructor(status: number, code: ApiErrorCode, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const notFound = (what: string) => new HttpError(404, "not_found", `no ${what}`);
const MAX_BODY = 64 * 1024;

/** The request listener: route, read on behalf of the member, answer with JSON. */
export function apiHandler(engine: Engine, directory: Directory) {
  const routes: {
    method: string;
    path: RegExp;
    run: (who: Principal, m: RegExpMatchArray, req: Request) => Promise<unknown>;
  }[] = [
    { method: "GET", path: /^\/v0\/spaces$/, run: (who) => spaces(engine, directory, who) },
    {
      method: "GET",
      path: /^\/v0\/spaces\/([^/]+)\/documents$/,
      run: (who, m) => tree(engine, directory, who, decodeURIComponent(m[1] ?? "")),
    },
    {
      method: "GET",
      path: /^\/v0\/spaces\/([^/]+)\/topics$/,
      run: (who, m) => outline(engine, directory, who, decodeURIComponent(m[1] ?? "")),
    },
    {
      method: "GET",
      path: /^\/v0\/topics\/([^/]+)$/,
      run: (who, m) => topic(engine, directory, who, decodeURIComponent(m[1] ?? "")),
    },
    {
      method: "GET",
      path: /^\/v0\/documents$/,
      run: (who, _m, req) => document(engine, directory, who, req.query),
    },
    {
      method: "POST",
      path: /^\/v0\/search$/,
      run: async (who, _m, req) => engine.retrieval.search(parseAs<SearchQuery>("SearchQuery", await req.json()), who),
    },
    {
      method: "POST",
      path: /^\/v0\/answers$/,
      run: async (who, _m, req) => engine.retrieval.answer(parseAs<AnswerQuery>("AnswerQuery", await req.json()), who),
    },
    { method: "GET", path: /^\/v0\/inbox$/, run: (who) => inboxOf(engine, who) },
    {
      method: "POST",
      path: /^\/v0\/todos\/([^/]+)\/resolve$/,
      run: async (who, m, req) => {
        const id = decodeURIComponent(m[1] ?? "");
        const { todo, refused } = await resolveTodo(
          engine,
          who,
          id,
          parseAs<ResolveTodo>("ResolveTodo", await req.json()),
        );
        if (refused) throw new HttpError(400, "bad_request", refused);
        if (!todo) throw notFound("todo");
        return todo;
      },
    },
    {
      method: "GET",
      path: /^\/v0\/spaces\/([^/]+)\/overview$/,
      run: async (who, m) => {
        const space = await readableSpace(engine, directory, who, decodeURIComponent(m[1] ?? ""));
        if (!(await maintains(engine, who, space.id))) throw notFound("space");
        return overviewOf(engine, who, space);
      },
    },
    {
      method: "POST",
      path: /^\/v0\/sources\/([^/]+)\/sync$/,
      run: async (who, m) => {
        const report = await syncNow(engine, who, decodeURIComponent(m[1] ?? ""));
        if (!report) throw notFound("source");
        return report;
      },
    },
  ];

  return async (incoming: IncomingMessage, res: ServerResponse): Promise<void> => {
    let path = incoming.url ?? "/";
    try {
      // Parsed inside the try: a listener that throws would take the process down with it.
      const url = URL.parse(path, "http://localhost");
      if (!url) throw new HttpError(400, "bad_request", `the request target ${path} is not a valid URL`);
      path = url.pathname;
      if (url.pathname === "/v0/health") return send(res, 200, { ok: true });
      const route = routes.find((r) => r.method === incoming.method && r.path.test(url.pathname));
      if (!route) throw notFound(`route ${incoming.method} ${url.pathname}`);
      const who = principalOf(incoming, directory);
      const m = url.pathname.match(route.path) as RegExpMatchArray;
      send(res, 200, await route.run(who, m, { query: url.searchParams, json: () => readJson(incoming) }));
    } catch (error) {
      const e =
        error instanceof HttpError
          ? error
          : error instanceof ContractError || error instanceof SyntaxError
            ? new HttpError(400, "bad_request", error.message)
            : error instanceof RangeError
              ? new HttpError(404, "not_found", error.message)
              : undefined;
      if (!e) log.error("request failed", { method: incoming.method, path, error });
      const body: ApiError = { error: { code: e?.code ?? "internal", message: e?.message ?? "internal error" } };
      send(res, e?.status ?? 500, body);
    }
  };
}

/** Serve the API on localhost. Port 0 picks a free one; the server's address() says which. */
export async function serveApi(engine: Engine, directory: Directory, port: number): Promise<Server> {
  const server = createServer(apiHandler(engine, directory));
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  log.info("listening", { port: (server.address() as AddressInfo).port });
  return server;
}

interface Request {
  query: URLSearchParams;
  json(): Promise<unknown>;
}

function principalOf(req: IncomingMessage, directory: Directory): Principal {
  const tenant = req.headers["x-inspiration-tenant"];
  const member = req.headers["x-inspiration-member"];
  if (typeof tenant !== "string" || typeof member !== "string") {
    throw new HttpError(
      401,
      "unauthenticated",
      "name the tenant and member in x-inspiration-tenant and x-inspiration-member",
    );
  }
  const who = parseAs<Principal>("Principal", { id: member, kind: "member", tenant_id: tenant });
  if (!directory.tenant(tenant)) throw new HttpError(401, "unauthenticated", `unknown tenant ${tenant}`);
  return who;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(400, "bad_request", `body over ${MAX_BODY} bytes`);
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/** The spaces of the member's tenant that access control lets them read. */
async function spaces(engine: Engine, directory: Directory, who: Principal): Promise<SpaceList> {
  const readable = new Set((await engine.authz.scopeFilter(who, "read")).space_ids);
  return {
    tenant: directory.tenant(who.tenant_id) as Tenant,
    spaces: directory.spaces(who.tenant_id).filter((s) => readable.has(s.id)),
  };
}

async function readableSpace(engine: Engine, directory: Directory, who: Principal, spaceId: string): Promise<Space> {
  const space = directory.spaces(who.tenant_id).find((s) => s.id === spaceId);
  if (!space || !(await engine.authz.scopeFilter(who, "read")).space_ids.includes(spaceId)) throw notFound("space");
  return space;
}

/** The Documents tree of a space, with only the documents the member may open. */
async function tree(engine: Engine, directory: Directory, who: Principal, spaceId: string): Promise<DocumentTree> {
  await readableSpace(engine, directory, who, spaceId);
  const { sources, documents } = await engine.sync.documents(who.tenant_id, spaceId);
  const decisions = await engine.authz.checkMany(
    who,
    "read",
    documents.map((d) => ({ type: "document", id: `${d.entry.source_id}:${d.entry.external_id}` })),
  );
  return {
    space_id: spaceId,
    sources: documentTree(
      sources,
      documents.filter((_, i) => decisions[i]?.allow),
    ),
  };
}

/** The live topics of a space the member may read. */
async function outline(engine: Engine, directory: Directory, who: Principal, spaceId: string): Promise<TopicList> {
  await readableSpace(engine, directory, who, spaceId);
  const topics = (await engine.store.topics(who.tenant_id, spaceId)).filter((n) => n.status !== "retired");
  return { space_id: spaceId, topics };
}

/**
 * A topic's statements and its subtopics', as the member may read them, with every value the
 * facts they fill have elsewhere, so a fact shows what holds and what stands against it.
 */
async function topic(engine: Engine, directory: Directory, who: Principal, key: string): Promise<TopicView> {
  const all = (await engine.store.topics(who.tenant_id)).filter((n) => n.status !== "retired");
  const node = all.find((n) => n.key === key);
  if (!node) throw notFound("topic");
  await readableSpace(engine, directory, who, node.space_id);
  const keys = [key];
  for (let i = 0; i < keys.length; i++) keys.push(...all.filter((n) => n.parent_key === keys[i]).map((n) => n.key));
  const placed = (await Promise.all(keys.map((k) => engine.store.placementsIn(who.tenant_id, k)))).flat();
  const claims = await engine.store.getClaims(placed.map((p) => p.claim_id));
  const slots = [...new Set(claims.flatMap((c) => slotOf(c) ?? []))].sort();
  const elsewhere: string[] = [];
  for (const slot of slots) {
    for (const v of (await engine.store.slot(who.tenant_id, slot))?.variants ?? []) elsewhere.push(...v.claim_ids);
  }
  const { statements, held } = await engine.retrieval.statementsOf(
    [...new Set([...claims.map((c) => c.id), ...elsewhere])],
    who,
  );
  const labelOf = await factLabels(engine, who.tenant_id);
  const parent = all.find((n) => n.key === node.parent_key);
  return {
    topic: node,
    ...(parent && { parent }),
    subtopics: all.filter((n) => n.parent_key === key),
    statements,
    held,
    facts: slots.map((slot_key) => {
      const label = labelOf(slot_key);
      return { slot_key, ...(label && { label }) };
    }),
  };
}

/** A document's latest version by its source item, or the version a citation names. */
async function lookUp(engine: Engine, query: URLSearchParams): Promise<ListedDocument | undefined> {
  const versionId = query.get("version");
  if (versionId) {
    const version = await engine.store.getSourceVersion(versionId);
    return version && !version.deleted ? { version, entry: entryOf(version) } : undefined;
  }
  const sourceId = query.get("source");
  const externalId = query.get("item");
  if (!sourceId || !externalId)
    throw new HttpError(400, "bad_request", "name the document by source and item, or version");
  return engine.sync.document(sourceId, externalId);
}

/** One version of a document, its blocks and the marks on them. */
async function document(
  engine: Engine,
  directory: Directory,
  who: Principal,
  query: URLSearchParams,
): Promise<DocumentView> {
  const listed = await lookUp(engine, query);
  const source = listed && (await engine.sync.getSource(listed.version.source_id));
  if (!listed || !source || source.tenant_id !== who.tenant_id) throw notFound("document");
  const { source_id, external_id } = listed.entry;
  const [decision] = await engine.authz.checkMany(who, "read", [
    { type: "document", id: `${source_id}:${external_id}` },
  ]);
  if (!decision?.allow) throw notFound("document");
  await readableSpace(engine, directory, who, source.space_id);
  // Where the engine keeps the stored copy is its own business, not the reader's.
  const {
    version: { blob: _blob, ...version },
    entry,
  } = listed;
  return {
    document: entry,
    source_name: source.name,
    space_id: source.space_id,
    path: foldersOf(version),
    version,
    blocks: await engine.store.blocksOf(version.id),
    annotations: await engine.retrieval.annotations(version.id, who),
  };
}
