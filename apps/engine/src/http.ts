/**
 * The engine's HTTP API, version 0: the queries the business layer's web app makes on behalf
 * of a member, and the commands its tenancy service sends. Bodies are the contract types of
 * libs/contracts/schema/api.yaml, tenancy.yaml and retrieval.yaml, validated on the way in.
 * Routes only translate: each reads through the components' own methods, and every read is
 * checked against the member's permissions there or here, before anything is returned.
 *
 *     GET  /v0/me                                     Me, the member's roles and whether they administer the tenant
 *     GET  /v0/spaces                                 SpaceList, the spaces the member may read
 *     GET  /v0/spaces?manage=true                     SpaceList, the spaces the member may administer
 *     GET  /v0/spaces/:space/documents                DocumentTree
 *     GET  /v0/spaces/:space/topics                   TopicList, the space's knowledge outline
 *     GET  /v0/topics/:topic                          TopicView
 *     GET  /v0/documents?source=<id>&item=<external>  DocumentView, the latest version
 *     GET  /v0/documents?version=<id>                 DocumentView, the version a citation names
 *     POST /v0/search    SearchQuery                  SearchResult
 *     POST /v0/answers   AnswerQuery                  GroundedAnswer, compact unless depth is standard
 *     GET  /v0/inbox                                  Inbox, the member's open todos
 *     POST /v0/todos/:todo/resolve  ResolveTodo       Todo, closed
 *     POST /v0/inbox/decide         DecideTodos       Decided, what the assistant decided and left
 *     POST /v0/decisions/:decision/undo               InboxTodo, open again
 *     GET  /v0/inbox/decided                          DecidedWeek, this week's decisions
 *     GET  /v0/delegation                             Delegation, the member's standing Decide for me
 *     PUT  /v0/delegation           PutDelegation     Delegation
 *     GET  /v0/spaces/:space/overview                 SpaceOverview, for the space's maintainers
 *     POST /v0/sources/:source/sync                   SyncReport, the source synced now
 *     PUT  /v0/spaces/:space/files/:path  the file's bytes  FileWritten, the file in the space's uploads
 *     POST /v0/mcp       one JSON-RPC message          its answer, or 202 for a notification (agent-api)
 *
 * Space administration (space-admin.ts), on access control's directory:
 *
 *     POST  /v0/spaces                  CreateSpace       SpaceWritten, once per Idempotency-Key
 *     PUT   /v0/spaces/:space/owners    PutSpaceOwners    SpaceWritten
 *     PATCH /v0/spaces/:space           PatchSpace        SpaceWritten
 *     GET   /v0/spaces/:space/audience                    SpaceAudience
 *     PUT   /v0/spaces/:space/audience  PutSpaceAudience  SpaceAudience
 *
 * Provisioning (provisioning.ts), for the business layer's tenancy service:
 *
 *     PUT /v0/tenants/:tenant                  PutTenant  TenantWritten
 *     PUT /v0/tenants/:tenant/members/:member  PutMember  MemberWritten
 *     GET /v0/tenants/:tenant/members                     DirectoryMemberList
 *
 * Resolving a todo, letting the assistant decide or undoing its decision, the delegation,
 * syncing a source and uploading a file are the knowledge writes. The assistant decides only
 * the member's own todos (another's named answers 404), at most 20 named at once (else 400),
 * and writes its reasons in the token's locale; an undo of a decision already undone or no
 * longer the one that closed its todo answers 409 (decisions.ts). An upload
 * (uploads.ts) needs editor or above on the space (else 403); its body is the file's bytes,
 * at most 50 MiB (else 413), of a type the engine reads by the name's extension (else 415).
 * It answers once the document is stored and reads it in the background. The Documents tree,
 * a document's latest version and the upload's answer say how far reading has come (reading.ts):
 * an entry's reading is waiting, reading, paused or failed, with a note for the last two, and
 * left out once read; the tree counts its documents by state. Only a todo's assignee may
 * resolve it (a todo of anyone else's answers 404), with a resolution it offers (else 400).
 * Only a member who may administer a space and read it reads its overview or syncs its sources
 * (spaces.ts). Both answer once the engine has read everything they caused, so the next read
 * sees the change. The directory's writes answer with a consistency_token. The engine reads at
 * least as fresh as its own latest write, so a read after the answer sees the change whether
 * or not it sends the token back in x-inspiration-consistency; the header is accepted now for
 * when several engine processes pass it on to SpiceDB.
 *
 * Identity: a request carries a principal token, "Authorization: Bearer <JWT>", which the
 * business layer signs and access control verifies (TokenVerifier). The token's scopes bound
 * what the route may do: knowledge.read for every read, knowledge.propose for a member's writes,
 * provision.directory for provisioning, which only a service of the tenant may do. A member's
 * tenant must be active and the member an active member of it, as the directory has them, or
 * the request answers 401 whatever the token says. An agent's token (kind agent) acts for the
 * member it names, as long as that member is active, within the token's spaces and only to
 * read, and reaches only the MCP endpoint (anything else answers 403): the agent API's server
 * with search, ask and read, which read as the routes above do. The endpoint keeps no session
 * and opens no stream, so GET and DELETE on it answer 405. For development only (the demo and its
 * snapshot), Identity.devHeaders lets a request name its tenant and member in the
 * x-inspiration-tenant and x-inspiration-member headers instead, trusted as given with a
 * member's scopes, and the language the engine writes for them in x-inspiration-locale, as a
 * token's locale; the API listens on localhost only. Errors are ApiError bodies: 400 for a
 * body or header that is not valid, 401 without a valid token, 403 for a token whose scopes do
 * not cover the route or an admin write the member may not make, 404 for anything unknown or
 * not readable (the two look the same, so a reader never learns what exists), 409 for a
 * directory command that an earlier one supersedes, 405 for a stream asked of the MCP endpoint,
 * 413 and 415 for an upload too large or of a type the engine does not read.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ConflictError, TokenError, type TokenVerifier } from "@inspiration/access-control";
import { McpServer } from "@inspiration/agent-api";
import {
  type AnswerQuery,
  type ApiError,
  allows,
  ContractError,
  type DocumentTree,
  type DocumentView,
  type Me,
  type Principal,
  parseAs,
  type ResolveTodo,
  type Scope,
  type SearchQuery,
  type SpaceEntry,
  slotOf,
  type TopicList,
  type TopicView,
} from "@inspiration/contracts";
import { logger } from "@inspiration/kernel";
import { documentTree, entryOf, foldersOf, type ListedDocument } from "@inspiration/source-sync";
import { decidedWeek, decideTodos, putDelegation, undoDecision } from "./decisions.ts";
import type { Engine } from "./engine.ts";
import { badRequest, HttpError, notFound } from "./http-errors.ts";
import { members, putMember, putTenant } from "./provisioning.ts";
import { countsOf, readingOf } from "./reading.ts";
import { audienceOf, createSpace, patchSpace, putAudience, putOwners, spaceList } from "./space-admin.ts";
import { maintains, overviewOf, syncNow } from "./spaces.ts";
import { factLabels, inboxOf, resolveTodo } from "./todos.ts";
import { putFile } from "./uploads.ts";

const log = logger("engine.http");

/** How requests say whom they act for: principal tokens, or the development headers, or both. */
export interface Identity {
  readonly tokens?: TokenVerifier;
  readonly devHeaders?: boolean;
}

/** The scopes the development headers stand for: a member's. */
const DEV_SCOPES: readonly Scope[] = ["knowledge.propose", "knowledge.read"];

const MAX_BODY = 64 * 1024;

interface Route {
  method: string;
  path: RegExp;
  /** The scope the route needs; knowledge.read when not given. */
  scope?: Scope;
  /** Whether an agent may take it: only the MCP endpoint. */
  agents?: boolean;
  /** Its answer, or undefined for 202 and no body. */
  run: (who: Principal, m: RegExpMatchArray, req: Request) => Promise<unknown>;
}

const param = (m: RegExpMatchArray, i = 1) => decodeURIComponent(m[i] ?? "");

/** The routes, in the order they are matched. */
function routesOf(engine: Engine): Route[] {
  const mcp = mcpOf(engine);
  const noStream = async (): Promise<never> => {
    throw new HttpError(405, "bad_request", "the MCP endpoint takes one message per POST and opens no stream");
  };
  return [
    {
      method: "POST",
      path: /^\/v0\/mcp$/,
      agents: true,
      run: async (who, _m, req) => mcp.handle(await req.json(), who),
    },
    { method: "GET", path: /^\/v0\/mcp$/, agents: true, run: noStream },
    { method: "DELETE", path: /^\/v0\/mcp$/, agents: true, run: noStream },
    { method: "GET", path: /^\/v0\/me$/, run: (who) => me(engine, who) },
    {
      method: "GET",
      path: /^\/v0\/spaces$/,
      run: (who, _m, req) => spaceList(engine, who, req.query.get("manage") === "true"),
    },
    {
      method: "POST",
      path: /^\/v0\/spaces$/,
      scope: "knowledge.propose",
      run: async (who, _m, req) => createSpace(engine, who, await req.json(), req.header("idempotency-key")),
    },
    {
      method: "PATCH",
      path: /^\/v0\/spaces\/([^/]+)$/,
      scope: "knowledge.propose",
      run: async (who, m, req) => patchSpace(engine, who, param(m), await req.json()),
    },
    {
      method: "PUT",
      path: /^\/v0\/spaces\/([^/]+)\/owners$/,
      scope: "knowledge.propose",
      run: async (who, m, req) => putOwners(engine, who, param(m), await req.json()),
    },
    { method: "GET", path: /^\/v0\/spaces\/([^/]+)\/audience$/, run: (who, m) => audienceOf(engine, who, param(m)) },
    {
      method: "PUT",
      path: /^\/v0\/spaces\/([^/]+)\/audience$/,
      scope: "knowledge.propose",
      run: async (who, m, req) => putAudience(engine, who, param(m), await req.json()),
    },
    { method: "GET", path: /^\/v0\/spaces\/([^/]+)\/documents$/, run: (who, m) => tree(engine, who, param(m)) },
    { method: "GET", path: /^\/v0\/spaces\/([^/]+)\/topics$/, run: (who, m) => outline(engine, who, param(m)) },
    { method: "GET", path: /^\/v0\/topics\/([^/]+)$/, run: (who, m) => topic(engine, who, param(m)) },
    { method: "GET", path: /^\/v0\/documents$/, run: (who, _m, req) => document(engine, who, req.query) },
    {
      method: "POST",
      path: /^\/v0\/search$/,
      run: async (who, _m, req) => engine.retrieval.search(parseAs<SearchQuery>("SearchQuery", await req.json()), who),
    },
    {
      method: "POST",
      path: /^\/v0\/answers$/,
      run: async (who, _m, req) => {
        const query = parseAs<AnswerQuery>("AnswerQuery", await req.json());
        return (query.depth === "standard" ? engine.retrieval : engine.compact).answer(query, who);
      },
    },
    { method: "GET", path: /^\/v0\/inbox$/, run: (who) => inboxOf(engine, who) },
    {
      method: "POST",
      path: /^\/v0\/todos\/([^/]+)\/resolve$/,
      scope: "knowledge.propose",
      run: async (who, m, req) => {
        const resolve = parseAs<ResolveTodo>("ResolveTodo", await req.json());
        const { todo, refused } = await resolveTodo(engine, who, param(m), resolve);
        if (refused) throw badRequest(refused);
        if (!todo) throw notFound("todo");
        return todo;
      },
    },
    {
      method: "POST",
      path: /^\/v0\/inbox\/decide$/,
      scope: "knowledge.propose",
      run: async (who, _m, req) => decideTodos(engine, who, await req.json()),
    },
    {
      method: "POST",
      path: /^\/v0\/decisions\/([^/]+)\/undo$/,
      scope: "knowledge.propose",
      run: (who, m) => undoDecision(engine, who, param(m)),
    },
    { method: "GET", path: /^\/v0\/inbox\/decided$/, run: (who) => decidedWeek(engine, who) },
    { method: "GET", path: /^\/v0\/delegation$/, run: (who) => engine.assistant.delegation(who.tenant_id, who.id) },
    {
      method: "PUT",
      path: /^\/v0\/delegation$/,
      scope: "knowledge.propose",
      run: async (who, _m, req) => putDelegation(engine, who, await req.json()),
    },
    {
      method: "GET",
      path: /^\/v0\/spaces\/([^/]+)\/overview$/,
      run: async (who, m) => {
        const space = await readableSpace(engine, who, param(m));
        if (!(await maintains(engine, who, space.id))) throw notFound("space");
        return overviewOf(engine, who, space);
      },
    },
    {
      method: "POST",
      path: /^\/v0\/sources\/([^/]+)\/sync$/,
      scope: "knowledge.propose",
      run: async (who, m) => {
        const report = await syncNow(engine, who, param(m));
        if (!report) throw notFound("source");
        return report;
      },
    },
    {
      method: "PUT",
      path: /^\/v0\/spaces\/([^/]+)\/files\/(.+)$/,
      scope: "knowledge.propose",
      run: async (who, m, req) => putFile(engine, who, await readableSpace(engine, who, param(m)), m[2] as string, req),
    },
    {
      method: "PUT",
      path: /^\/v0\/tenants\/([^/]+)$/,
      scope: "provision.directory",
      run: async (who, m, req) => putTenant(engine, who, param(m), await req.json()),
    },
    {
      method: "PUT",
      path: /^\/v0\/tenants\/([^/]+)\/members\/([^/]+)$/,
      scope: "provision.directory",
      run: async (who, m, req) => putMember(engine, who, param(m), param(m, 2), await req.json()),
    },
    {
      method: "GET",
      path: /^\/v0\/tenants\/([^/]+)\/members$/,
      scope: "provision.directory",
      run: (who, m) => members(engine, who, param(m)),
    },
  ];
}

/** The request listener: route, act on behalf of the principal, answer with JSON. */
export function apiHandler(engine: Engine, identity: Identity) {
  if (!identity.tokens && !identity.devHeaders) throw new RangeError("the API needs principal tokens or dev headers");
  const routes = routesOf(engine);
  return async (incoming: IncomingMessage, res: ServerResponse): Promise<void> => {
    let path = incoming.url ?? "/";
    try {
      // Parsed inside the try: a listener that throws would take the process down with it.
      const url = URL.parse(path, "http://localhost");
      if (!url) throw badRequest(`the request target ${path} is not a valid URL`);
      path = url.pathname;
      if (url.pathname === "/v0/health") return send(res, 200, { ok: true });
      const route = routes.find((r) => r.method === incoming.method && r.path.test(url.pathname));
      if (!route) throw notFound(`route ${incoming.method} ${url.pathname}`);
      const who = await principalOf(incoming, identity);
      const scope = route.scope ?? "knowledge.read";
      if (!who.scopes?.includes(scope)) throw new HttpError(403, "forbidden", `the token does not grant ${scope}`);
      if (who.kind === "agent" && !route.agents) {
        throw new HttpError(403, "forbidden", "an agent reaches the engine through /v0/mcp only");
      }
      if (who.kind === "member" || who.kind === "agent") await admit(engine, who);
      const m = url.pathname.match(route.path) as RegExpMatchArray;
      const header = (name: string) => {
        const value = incoming.headers[name];
        return typeof value === "string" ? value : undefined;
      };
      const req: Request = {
        query: url.searchParams,
        header,
        json: async () => JSON.parse((await readBody(incoming, MAX_BODY, badRequest)).toString("utf8")),
        bytes: (limit) => readBody(incoming, limit, (message) => new HttpError(413, "too_large", message)),
      };
      const body = await route.run(who, m, req);
      if (body === undefined) return void res.writeHead(202, { "cache-control": "no-store" }).end();
      send(res, 200, body);
    } catch (error) {
      const e = httpErrorOf(error);
      if (!e) log.error("request failed", { method: incoming.method, path, error });
      const body: ApiError = { error: { code: e?.code ?? "internal", message: e?.message ?? "internal error" } };
      send(res, e?.status ?? 500, body);
    }
  };
}

/** What an error answers, undefined for one nothing expected: a 500. */
function httpErrorOf(error: unknown): HttpError | undefined {
  if (error instanceof HttpError) return error;
  if (error instanceof ContractError || error instanceof SyntaxError) return badRequest(error.message);
  if (error instanceof ConflictError) return new HttpError(409, "conflict", error.message);
  if (error instanceof RangeError) return new HttpError(404, "not_found", error.message);
  return undefined;
}

/** Serve the API on localhost. Port 0 picks a free one; the server's address() says which. */
export async function serveApi(engine: Engine, port: number, identity: Identity): Promise<Server> {
  const server = createServer(apiHandler(engine, identity));
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  log.info("listening", { port: (server.address() as AddressInfo).port });
  return server;
}

interface Request {
  query: URLSearchParams;
  /** A header sent once, by its lower-case name. */
  header(name: string): string | undefined;
  json(): Promise<unknown>;
  /** The body, or HttpError 413 once it passes limit bytes. */
  bytes(limit: number): Promise<Buffer>;
}

async function principalOf(req: IncomingMessage, identity: Identity): Promise<Principal> {
  return (await fromToken(req, identity)) ?? fromDevHeaders(req, identity);
}

/**
 * A member acts only while their tenant is active and they are an active member of it, and an
 * agent only while the member it acts for is.
 */
async function admit(engine: Engine, who: Principal): Promise<void> {
  const tenant = await engine.directory.tenant(who.tenant_id);
  if (!tenant || (tenant.status ?? "active") !== "active") {
    throw new HttpError(401, "unauthenticated", `tenant ${who.tenant_id} is not active`);
  }
  const memberId = (who.kind === "agent" && who.on_behalf_of) || who.id;
  const member = await engine.directory.member(who.tenant_id, memberId);
  if (member?.status !== "active") throw new HttpError(401, "unauthenticated", `${memberId} is not an active member`);
}

/** The agent API's MCP server, reading as the HTTP API does. */
function mcpOf(engine: Engine): McpServer {
  return new McpServer({
    version: "0",
    library: {
      search: (query, who) => engine.retrieval.search(query, who),
      answer: (query, who) => (query.depth === "standard" ? engine.retrieval : engine.compact).answer(query, who),
      document: (version, who) => document(engine, who, new URLSearchParams({ version })),
    },
    refusal: (error) => httpErrorOf(error)?.message,
  });
}

async function fromToken(req: IncomingMessage, identity: Identity): Promise<Principal | undefined> {
  const header = req.headers.authorization;
  if (header === undefined) return undefined;
  const bearer = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(header)?.[1];
  if (!identity.tokens || !bearer) {
    throw new HttpError(401, "unauthenticated", "send a principal token as a Bearer token");
  }
  try {
    return await identity.tokens.verify(bearer);
  } catch (error) {
    if (!(error instanceof TokenError)) throw error;
    log.info("token refused", { reason: error.message });
    throw new HttpError(401, "unauthenticated", "the principal token is not valid");
  }
}

function fromDevHeaders(req: IncomingMessage, identity: Identity): Principal {
  const tenant = req.headers["x-inspiration-tenant"];
  const member = req.headers["x-inspiration-member"];
  if (!identity.devHeaders || typeof tenant !== "string" || typeof member !== "string") {
    throw new HttpError(
      401,
      "unauthenticated",
      identity.devHeaders
        ? "send a principal token, or name the tenant and member in x-inspiration-tenant and x-inspiration-member"
        : "send a principal token as a Bearer token",
    );
  }
  const locale = req.headers["x-inspiration-locale"];
  return parseAs<Principal>("Principal", {
    id: member,
    kind: "member",
    tenant_id: tenant,
    scopes: [...DEV_SCOPES],
    ...(typeof locale === "string" && { locale }),
  });
}

/** The body, refused as soon as its declared or counted size passes limit. */
async function readBody(req: IncomingMessage, limit: number, tooLarge: (message: string) => HttpError) {
  const message = `body over ${limit} bytes`;
  if (Number(req.headers["content-length"]) > limit) throw tooLarge(message);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw tooLarge(message);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readableSpace(engine: Engine, who: Principal, spaceId: string): Promise<SpaceEntry> {
  const space = await engine.directory.space(spaceId);
  const readable = (await engine.authz.scopeFilter(who, "read")).space_ids.includes(spaceId);
  if (!space || space.tenant_id !== who.tenant_id || !readable) throw notFound("space");
  return space;
}

/** The member's roles as the directory has them, whether they administer the tenant, and their locale. */
async function me(engine: Engine, who: Principal): Promise<Me> {
  const member = await engine.directory.member(who.tenant_id, who.id);
  const admin = await engine.authz.check(who, "admin", { type: "tenant", id: who.tenant_id });
  return {
    tenant_id: who.tenant_id,
    member_id: who.id,
    roles: member?.roles ?? [],
    admin: admin.allow,
    ...(who.locale && { locale: who.locale }),
  };
}

/** The Documents tree of a space, with only the documents the member may open. */
async function tree(engine: Engine, who: Principal, spaceId: string): Promise<DocumentTree> {
  await readableSpace(engine, who, spaceId);
  const { sources, documents } = await engine.sync.documents(who.tenant_id, spaceId);
  const decisions = await engine.authz.checkMany(
    who,
    "read",
    documents.map((d) => ({ type: "document", id: `${d.entry.source_id}:${d.entry.external_id}` })),
  );
  const readable = documents.filter((_, i) => decisions[i]?.allow);
  const readings = await readingOf(
    engine,
    who.tenant_id,
    readable.map((d) => d.version),
  );
  const entries = readable.map((d, i) => {
    const reading = readings[i];
    return reading ? { ...d, entry: { ...d.entry, reading } } : d;
  });
  return { space_id: spaceId, sources: documentTree(sources, entries), reading: countsOf(readings) };
}

/** The live topics of a space the member may read. */
async function outline(engine: Engine, who: Principal, spaceId: string): Promise<TopicList> {
  await readableSpace(engine, who, spaceId);
  const topics = (await engine.store.topics(who.tenant_id, spaceId)).filter((n) => n.status !== "retired");
  return { space_id: spaceId, topics };
}

/**
 * A topic's statements and its subtopics', as the member may read them, with every value the
 * facts they fill have elsewhere, so a fact shows what holds and what stands against it.
 */
async function topic(engine: Engine, who: Principal, key: string): Promise<TopicView> {
  const all = (await engine.store.topics(who.tenant_id)).filter((n) => n.status !== "retired");
  const node = all.find((n) => n.key === key);
  if (!node) throw notFound("topic");
  await readableSpace(engine, who, node.space_id);
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
  if (!sourceId || !externalId) throw badRequest("name the document by source and item, or version");
  return engine.sync.document(sourceId, externalId);
}

/** One version of a document, its blocks and the marks on them. */
async function document(engine: Engine, who: Principal, query: URLSearchParams): Promise<DocumentView> {
  const listed = await lookUp(engine, query);
  const source = listed && (await engine.sync.getSource(listed.version.source_id));
  if (!listed || !source || source.tenant_id !== who.tenant_id) throw notFound("document");
  const { source_id, external_id } = listed.entry;
  const [decision] = await engine.authz.checkMany(who, "read", [
    { type: "document", id: `${source_id}:${external_id}` },
  ]);
  if (!decision?.allow) throw notFound("document");
  // The check reads the latest version's label; a citation may name an older one.
  if (!allows(await engine.authz.clearance(who), listed.version.sensitivity)) throw notFound("document");
  await readableSpace(engine, who, source.space_id);
  // Where the engine keeps the stored copy is its own business, not the reader's.
  const {
    version: { blob: _blob, ...version },
    entry,
  } = listed;
  // Reading is told for the latest version only; a citation may name an older one.
  const latest = query.get("version") ? await engine.sync.document(source_id, external_id) : listed;
  const [reading] = latest?.version.id === version.id ? await readingOf(engine, who.tenant_id, [listed.version]) : [];
  return {
    document: { ...entry, ...(reading && { reading }) },
    source_name: source.name,
    space_id: source.space_id,
    path: foldersOf(version),
    version,
    blocks: await engine.store.blocksOf(version.id),
    annotations: await engine.retrieval.annotations(version.id, who),
  };
}
