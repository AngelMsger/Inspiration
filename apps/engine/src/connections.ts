/** Local connection management. Only space maintainers may import; secrets stay in the environment. */
import { connectionUrl, feishuLink } from "@inspiration/connectors";
import {
  type ConnectionList,
  type CreateConnection,
  type Principal,
  parseAs,
  type Source,
  stableId,
} from "@inspiration/contracts";
import { logger } from "@inspiration/kernel";
import type { Engine } from "./engine.ts";
import { badRequest, notFound } from "./http-errors.ts";
import { maintains } from "./spaces.ts";

const enabled = () => process.env.INSPIRATION_LOCAL_CONNECTIONS === "1";

export async function connectionSecret(name: string): Promise<string> {
  if (!enabled()) throw new RangeError("local connections are not enabled");
  if (name === "local:confluence" && process.env.INSPIRATION_CONFLUENCE_TOKEN)
    return process.env.INSPIRATION_CONFLUENCE_TOKEN;
  if (name === "local:feishu" && process.env.INSPIRATION_FEISHU_APP_ID && process.env.INSPIRATION_FEISHU_APP_SECRET) {
    return JSON.stringify({
      app_id: process.env.INSPIRATION_FEISHU_APP_ID,
      app_secret: process.env.INSPIRATION_FEISHU_APP_SECRET,
    });
  }
  throw new RangeError("configure the connection credentials in .env and restart the local service");
}

export async function connections(engine: Engine, who: Principal, space: string): Promise<ConnectionList> {
  if (!(await maintains(engine, who, space))) throw notFound("space");
  return {
    sources: (await engine.sync.listSources(who.tenant_id)).filter(
      (s) => s.space_id === space && ["confluence", "feishu.docx"].includes(s.type),
    ),
    configured: {
      confluence: enabled() && !!process.env.INSPIRATION_CONFLUENCE_URL && !!process.env.INSPIRATION_CONFLUENCE_TOKEN,
      feishu: enabled() && !!process.env.INSPIRATION_FEISHU_APP_ID && !!process.env.INSPIRATION_FEISHU_APP_SECRET,
    },
  };
}

export async function connectSource(engine: Engine, who: Principal, space: string, input: unknown): Promise<Source> {
  const list = await connections(engine, who, space);
  const request = parseAs<CreateConnection>("CreateConnection", input);
  if (!list.configured[request.type === "confluence" ? "confluence" : "feishu"])
    throw badRequest("configure this connection in .env and restart the local service");
  const name = request.name.trim();
  if (!name) throw badRequest("give the connection a name");
  const targets = request.targets.map((s) => s.trim());
  let base: string | undefined;
  try {
    if (request.type === "confluence") {
      if (targets.length !== 1 || !/^[a-zA-Z0-9_~-]+$/.test(targets[0] ?? ""))
        throw new RangeError("choose one Confluence space key");
      base = connectionUrl(process.env.INSPIRATION_CONFLUENCE_URL ?? "").href;
    } else for (const target of targets) feishuLink(target);
  } catch (error) {
    throw badRequest(error instanceof Error ? error.message : "invalid connection target");
  }
  const source: Source = {
    id: stableId("source", who.tenant_id, space, request.type, ...[...targets].sort()),
    tenant_id: who.tenant_id,
    space_id: space,
    type: request.type,
    name,
    scope: {
      kind: request.type === "confluence" ? "confluence.space" : "feishu.documents",
      ids: targets,
      ...(base && { options: { base_url: base } }),
    },
    credentials_ref: request.type === "confluence" ? "local:confluence" : "local:feishu",
    owner_id: who.id,
    governance_level: request.governance_level,
    default_sensitivity: "internal",
    status: "active",
    created_at: new Date().toISOString(),
  };
  const existing = await engine.sync.getSource(source.id);
  if (existing) throw badRequest("this source is already connected; use Sync now on its connection");
  await engine.authz.registerSource(source.id, space);
  await engine.sync.addSource(source);
  return source;
}

/** Return immediately, persist the result, and allow polling through the connection list. */
export async function startSync(engine: Engine, who: Principal, id: string): Promise<Source> {
  const source = await engine.sync.getSource(id);
  if (!source || source.tenant_id !== who.tenant_id || !(await maintains(engine, who, source.space_id)))
    throw notFound("source");
  if (!enabled() || !["confluence", "feishu.docx"].includes(source.type))
    throw badRequest("this source is not a local connection");
  const task = await engine.sync.startSync(id, { via: "manual" });
  void task.finished
    .catch(() => logger("engine.connections").warn("sync failed", { source: id }))
    .finally(() => engine.settleLater());
  return task.source;
}
