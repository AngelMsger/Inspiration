import type { Engine } from "./engine.ts";

/** Newly imported topics belong to their space owner until a more specific owner is assigned. */
export async function organizeKnowledge(engine: Engine, tenant: string): Promise<void> {
  await engine.settle();
  // Reconcile completed reading as well as events: model failures can exhaust event retries.
  // A newer version whose parsing or extraction failed must not erase the previous topics.
  const read = new Set(
    (await engine.extraction.documents(tenant))
      .filter((mark) => !mark.reading && !mark.paused)
      .map((mark) => mark.source_version_id),
  );
  for (const source of await engine.sync.listSources(tenant)) {
    for (const item of await engine.sync.items(source.id)) {
      if (!read.has(item.source_version_id)) continue;
      const version = await engine.store.getSourceVersion(item.source_version_id);
      if (version) await engine.topics.update(version);
    }
  }
  await engine.topics.recluster(tenant);
  const spaces = new Map((await engine.directory.spaces(tenant)).map((s) => [s.id, s]));
  for (const topic of await engine.store.topics(tenant)) {
    const owner = spaces.get(topic.space_id)?.owner_ids[0];
    if (topic.status !== "retired" && !topic.owner_id && owner) await engine.topics.setOwner(tenant, topic.key, owner);
  }
  await engine.inbox.reroute(tenant);
  await engine.tick(tenant);
}
