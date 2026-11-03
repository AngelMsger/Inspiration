// The routes of the HTTP API for maintaining a space: what is waiting in it and how its
// documents stand, and syncing one of its sources now. Only a member who may administer the
// space (its maintainer, or the tenant's super admin) gets an answer; anyone else gets 404, as
// for anything they may not read.

import type {
  GovernanceLevel,
  Principal,
  Space,
  SpaceChange,
  SpaceOverview,
  SyncReport,
  TodoKind,
} from "@inspiration/contracts";
import type { Engine } from "./engine.ts";
import { factLabels } from "./todos.ts";

const LEVELS: GovernanceLevel[] = ["governed", "reference", "search_only"];
const CHANGES = 10;

/** Whether the member may administer the space. */
export async function maintains(engine: Engine, who: Principal, spaceId: string): Promise<boolean> {
  return (await engine.authz.check(who, "admin", { type: "space", id: spaceId })).allow;
}

/** The overview of a space its maintainer reads. */
export async function overviewOf(engine: Engine, who: Principal, space: Space): Promise<SpaceOverview> {
  const open = (await engine.inbox.items(who.tenant_id, { open: true })).filter((i) => i.todo.space_id === space.id);
  const counts = new Map<TodoKind, number>();
  for (const { todo } of open) counts.set(todo.kind, (counts.get(todo.kind) ?? 0) + 1);
  const conflicts = open.flatMap(({ todo }) => (todo.kind === "conflict" && todo.slot_key ? [todo.slot_key] : []));
  const labelOf = await factLabels(engine, who.tenant_id);
  const disputed = (await engine.governance.verdicts(who.tenant_id, conflicts))
    .filter((v) => v.disputed)
    .map((v) => {
      const label = labelOf(v.slot_key);
      return { slot_key: v.slot_key, ...(label && { label }) };
    });

  const { documents } = await engine.sync.documents(who.tenant_id, space.id);
  const decisions = await engine.authz.checkMany(
    who,
    "read",
    documents.map((d) => ({ type: "document", id: `${d.entry.source_id}:${d.entry.external_id}` })),
  );
  const readable = documents.filter((_, i) => decisions[i]?.allow);
  const changes = readable
    .sort((a, b) => b.entry.fetched_at.localeCompare(a.entry.fetched_at) || a.entry.title.localeCompare(b.entry.title))
    .slice(0, CHANGES)
    .map((d): SpaceChange => ({ document: d.entry, kind: d.version.previous_version_id ? "updated" : "created" }));
  return {
    space,
    work: [...counts].sort(([a, x], [b, y]) => y - x || a.localeCompare(b)).map(([kind, count]) => ({ kind, count })),
    unassigned: open.filter(({ todo }) => !todo.assignee_id).length,
    disputed,
    documents: readable.length,
    levels: LEVELS.map((level) => ({
      level,
      documents: readable.filter((d) => d.entry.governance_level === level).length,
    })),
    changes,
  };
}

/**
 * Sync a source of a space the member maintains now, and read everything the sync changed
 * before answering, so the next read sees it. Undefined for a source they may not administer.
 */
export async function syncNow(engine: Engine, who: Principal, sourceId: string): Promise<SyncReport | undefined> {
  const source = await engine.sync.getSource(sourceId);
  if (!source || source.tenant_id !== who.tenant_id || !(await maintains(engine, who, source.space_id))) {
    return undefined;
  }
  const report = await engine.sync.sync(sourceId, { via: "reconcile" });
  await engine.settle();
  return report;
}
