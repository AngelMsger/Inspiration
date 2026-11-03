/**
 * Topic owners, as the business layer would assign them; the engine only keeps them. Every
 * topic without an owner gets the member who owns most of its governed statements' documents:
 * a document's owner is its author in the source (front matter `owner`), mapped through the
 * corpus directory. An area gets the member who owns most below it. Then the inbox routes its
 * open todos again.
 */

import type { SourceVersion, TaxonomyNode } from "@inspiration/contracts";
import type { Corpus } from "./corpus.ts";
import type { Engine } from "./engine.ts";

export interface TopicOwners {
  /** Live topics. */
  topics: number;
  /** Topics this run gave an owner. */
  assigned: number;
  /** Each owner and how many topics they own after the run. */
  owners: Map<string, number>;
  /** Open todos the inbox moved to their new owners. */
  rerouted: number;
}

export async function assignOwners(engine: Engine, corpus: Corpus): Promise<TopicOwners> {
  const tenantId = corpus.tenantId;
  const nodes = (await engine.store.topics(tenantId)).filter((n) => n.status !== "retired");
  const documents = await engine.topics.documentsIn(tenantId);
  const versions = new Map<string, SourceVersion | undefined>();
  const ownerOf = async (versionId: string) => {
    if (!versions.has(versionId)) versions.set(versionId, await engine.store.getSourceVersion(versionId));
    const v = versions.get(versionId);
    const author = v?.metadata?.author_external_id;
    return v && author ? corpus.memberOf(v.source_id, author) : undefined;
  };

  // Statements by owner in each topic, a topic's own and those below it.
  const votes = new Map<string, Map<string, number>>();
  const children = new Map<string, TaxonomyNode[]>();
  for (const n of nodes) {
    if (n.parent_key) children.set(n.parent_key, [...(children.get(n.parent_key) ?? []), n]);
  }
  const tally = async (n: TaxonomyNode): Promise<Map<string, number>> => {
    const out = new Map<string, number>();
    for (const d of documents.get(n.key) ?? []) {
      const owner = await ownerOf(d.source_version_id);
      if (owner) out.set(owner, (out.get(owner) ?? 0) + d.statements);
    }
    for (const c of children.get(n.key) ?? []) {
      for (const [owner, count] of await tally(c)) out.set(owner, (out.get(owner) ?? 0) + count);
    }
    votes.set(n.key, out);
    return out;
  };
  for (const n of nodes) if (!n.parent_key) await tally(n);

  let assigned = 0;
  const owners = new Map<string, number>();
  for (const n of nodes) {
    let owner = n.owner_id;
    if (!owner) {
      owner = [...(votes.get(n.key) ?? [])].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))[0]?.[0];
      if (owner) {
        await engine.topics.setOwner(tenantId, n.key, owner);
        assigned++;
      }
    }
    if (owner) owners.set(owner, (owners.get(owner) ?? 0) + 1);
  }
  const { moved } = await engine.inbox.reroute(tenantId);
  return { topics: nodes.length, assigned, owners, rerouted: moved };
}
