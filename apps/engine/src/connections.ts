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

const running = new WeakMap<Engine, Map<string, Promise<Source>>>();
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
  let tasks = running.get(engine);
  if (!tasks) {
    tasks = new Map();
    running.set(engine, tasks);
  }
  const pending = tasks.get(id);
  if (pending) return pending;
  const begin = (async () => {
    const started: Source = { ...source, sync: { state: "running", started_at: new Date().toISOString() } };
    await engine.sync.addSource(started);
    void finishSync(engine, started)
      .catch(() => logger("engine.connections").warn("could not persist sync result", { source: id }))
      .finally(() => tasks.delete(id));
    return started;
  })();
  tasks.set(id, begin);
  return begin.catch((error: unknown) => {
    tasks.delete(id);
    throw error;
  });
}

async function finishSync(engine: Engine, source: Source): Promise<void> {
  try {
    const report = await engine.sync.sync(source.id, { via: "manual" });
    await engine.sync.addSource({
      ...source,
      sync: {
        state: report.outcomes.failed ? "failed" : "succeeded",
        started_at: source.sync?.started_at ?? source.created_at,
        finished_at: new Date().toISOString(),
        report,
      },
    });
    engine.settleLater();
  } catch (error) {
    await engine.sync.addSource({
      ...source,
      sync: {
        state: "failed",
        started_at: source.sync?.started_at ?? source.created_at,
        finished_at: new Date().toISOString(),
        note: error instanceof Error ? error.message : "connection failed; retry sync",
      },
    });
  }
}

/** Interrupted imports never pretend to have finished; a retry reconciles their stored items. */
export async function recoverConnections(engine: Engine): Promise<void> {
  for (const source of await engine.sync.listSources()) {
    if (source.sync?.state === "running")
      await engine.sync.addSource({
        ...source,
        sync: {
          ...source.sync,
          state: "failed",
          finished_at: new Date().toISOString(),
          note: "Sync was interrupted by a restart. Retry to continue.",
        },
      });
  }
}
