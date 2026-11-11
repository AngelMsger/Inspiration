/** Read only passages the answer retriever has already authorized, then answer with their current standing. */
import { type AnswerQuery, type GroundedAnswer, levelOf, type Principal } from "@inspiration/contracts";
import type { Engine } from "./engine.ts";

export async function answerWithReading(engine: Engine, query: AnswerQuery, who: Principal): Promise<GroundedAnswer> {
  const retrieval = query.depth === "standard" ? engine.retrieval : engine.compact;
  if (engine.discoverFacts) {
    const hits = await retrieval.sources(query, who);
    const citations = hits.flatMap((h) => h.citations ?? []).slice(0, 12);
    const spans = await engine.store.getSpans(citations.map((c) => c.span_id));
    const byVersion = new Map<string, Set<string>>();
    for (const span of spans) {
      if (!span.block_id) continue;
      const blocks = byVersion.get(span.source_version_id) ?? new Set<string>();
      blocks.add(span.block_id);
      byVersion.set(span.source_version_id, blocks);
    }
    for (const [id, blocks] of byVersion) {
      const version = await engine.store.getSourceVersion(id);
      if (version && version.tenant_id === who.tenant_id && levelOf(version) === "reference") {
        await engine.extraction.extractOnUse(id, [...blocks]);
      }
    }
    if (byVersion.size) await engine.settle();
  }
  return retrieval.answer(query, who);
}

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
