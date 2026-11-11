import type { Engine } from "./engine.ts";

/** Newly imported topics belong to their space owner until a more specific owner is assigned. */
export async function organizeKnowledge(engine: Engine, tenant: string): Promise<void> {
  await engine.settle();
  await engine.topics.recluster(tenant);
  const spaces = new Map((await engine.directory.spaces(tenant)).map((s) => [s.id, s]));
  for (const topic of await engine.store.topics(tenant)) {
    const owner = spaces.get(topic.space_id)?.owner_ids[0];
    if (topic.status !== "retired" && !topic.owner_id && owner) await engine.topics.setOwner(tenant, topic.key, owner);
  }
  await engine.inbox.reroute(tenant);
  await engine.tick(tenant);
}
