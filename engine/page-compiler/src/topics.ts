import { fileURLToPath } from "node:url";
import {
  type EventEnvelope,
  type EventHandler,
  type KnowledgeStore,
  type ModelGateway,
  type Placement,
  payloadOf,
  type SourceVersion,
  type TaxonomyNode,
} from "@inspiration/contracts";
import type { Records } from "@inspiration/eventbus";
import { PromptRegistry } from "@inspiration/model-gateway";
import { CLUSTER_DEFAULTS, type ClusterOptions, dot } from "./cluster.ts";
import { type ReclusterReport, reclusterTenant } from "./recluster.ts";
import {
  batched,
  bump,
  canonical,
  clustered,
  dequantize,
  documentOf,
  entry,
  fixed,
  flushPending,
  makePlacement,
  PENDING,
  type PendingWrite,
  quantize,
  recordKey,
  SECTIONS,
  type Section,
  SLOTS,
  score,
  type Target,
  TOPICS,
  writePending,
} from "./records.ts";
import { type BuiltSection, embedSections, sectionsOf } from "./sections.ts";

export type { ReclusterReport } from "./recluster.ts";
export {
  COMPONENT,
  dequantize,
  documentOf,
  PENDING,
  type PendingWrite,
  quantize,
  SECTIONS,
  type Section,
  SLOTS,
  type SlotTopic,
  TOPICS,
  type TopicState,
} from "./records.ts";
export { EMBED_CHARS } from "./sections.ts";

const PROMPTS_DIR = fileURLToPath(new URL("../prompts/", import.meta.url));

export interface TopicsOptions {
  store: KnowledgeStore;
  records: Records;
  models: ModelGateway;
  /** Defaults to the prompts shipped in this package. */
  prompts?: PromptRegistry;
  clock?: () => Date;
  cluster?: Partial<ClusterOptions>;
}

/** A document with sections in a topic. */
export interface TopicDocument {
  /** source_id:external_id */
  document: string;
  source_version_id: string;
  title: string;
  sections: number;
  statements: number;
}

interface LeafCentroid {
  key: string;
  centroid: Float32Array;
}

function selectFreshSections(built: readonly BuiltSection[], oldByKey: ReadonlyMap<string, Section>): BuiltSection[] {
  return built.filter((b) => {
    const before = oldByKey.get(b.section.key);
    if (!clustered(b.section)) return false;
    if (before?.vector && before.text_hash === b.section.text_hash) {
      b.section.vector = before.vector;
      if (before.topic) b.section.topic = before.topic;
      if (before.score !== undefined) b.section.score = before.score;
      return false;
    }
    return true;
  });
}

function assignNearestLeaf(
  section: Section,
  vector: Float32Array,
  previous: string | undefined,
  leaves: readonly LeafCentroid[],
  options: ClusterOptions,
): void {
  section.vector = quantize(vector);
  // It stays in its topic while close enough to it, as in a re-clustering; else the nearest.
  const home = leaves.find((l) => l.key === previous);
  let best = home && dot(vector, home.centroid) >= options.keep ? home : undefined;
  let bestSim = best ? dot(vector, best.centroid) : options.join;
  if (!best) {
    for (const l of leaves) {
      const sim = dot(vector, l.centroid);
      if (sim >= bestSim) [best, bestSim] = [l, sim];
    }
  }
  if (best) {
    section.topic = best.key;
    section.score = score(bestSim);
  }
}

function desiredDocumentPlacements(
  sections: readonly Section[],
  slotTopics: ReadonlyMap<string, string>,
): Map<string, Target> {
  const desired = new Map<string, Target>();
  for (const s of sections) {
    if (s.archived) continue;
    for (const c of s.claims) {
      const bySlot = c.slot ? slotTopics.get(c.slot) : undefined;
      if (bySlot) desired.set(c.id, { topic: bySlot });
      else if (s.topic && clustered(s)) {
        desired.set(c.id, { topic: s.topic, ...(s.score !== undefined && { score: s.score }) });
      }
    }
  }
  return desired;
}

function diffDocumentPlacements(
  tenantId: string,
  spaceId: string,
  ids: readonly string[],
  before: ReadonlySet<string>,
  now: ReadonlySet<string>,
  placed: ReadonlyMap<string, Placement>,
  desired: ReadonlyMap<string, Target>,
  at: string,
): { place: Placement[]; unplace: string[]; delta: Map<string, number> } {
  const place: Placement[] = [];
  const unplace: string[] = [];
  const delta = new Map<string, number>();
  for (const id of ids) {
    const p = placed.get(id);
    let after: string | undefined;
    if (fixed(p)) after = now.has(id) ? p?.taxonomy_key : undefined;
    else {
      const target = now.has(id) ? desired.get(id) : undefined;
      after = target?.topic;
      if (target && p?.taxonomy_key !== target.topic) place.push(makePlacement(tenantId, spaceId, id, target, at));
      if (!target && p) unplace.push(id);
    }
    const was = before.has(id) ? p?.taxonomy_key : undefined;
    if (was !== after) {
      bump(delta, was, -1);
      bump(delta, after);
    }
  }
  return { place, unplace, delta };
}

/** The tenant's topic nodes whose statement counts the delta changes, counted again up the tree. */
async function recountedNodes(
  store: KnowledgeStore,
  tenantId: string,
  delta: ReadonlyMap<string, number>,
): Promise<TaxonomyNode[]> {
  const nodes = new Map((await store.topics(tenantId)).map((n) => [n.key, n]));
  const counts = new Map<string, number>();
  for (const [k, by] of delta) {
    for (let n = nodes.get(k); n; n = n.parent_key === undefined ? undefined : nodes.get(n.parent_key)) {
      counts.set(n.key, (counts.get(n.key) ?? n.statement_count ?? 0) + by);
    }
  }
  return [...counts]
    .filter(([k, count]) => nodes.get(k)?.statement_count !== count)
    .map(([k, count]) => ({ ...(nodes.get(k) as TaxonomyNode), statement_count: Math.max(0, count) }));
}

export class Topics {
  readonly store: KnowledgeStore;
  readonly records: Records;
  readonly models: ModelGateway;
  readonly prompts: PromptRegistry;
  readonly clock: () => Date;
  readonly options: ClusterOptions;
  /** Totals since the process started, for run reports. */
  readonly totals = { updates: 0, embedded: 0, embed_calls: 0 };
  readonly #running = new Map<string, Promise<unknown>>();

  constructor(options: TopicsOptions) {
    this.store = options.store;
    this.records = options.records;
    this.models = options.models;
    this.clock = options.clock ?? (() => new Date());
    this.options = { ...CLUSTER_DEFAULTS, ...options.cluster };
    if (options.prompts) {
      this.prompts = options.prompts;
    } else {
      this.prompts = new PromptRegistry();
      this.prompts.loadDir(PROMPTS_DIR);
    }
  }

  readonly onClaimsUpdated: EventHandler = async (event: EventEnvelope) => {
    const update = payloadOf(event, "claims.updated");
    // Merged and human claims belong to no one document; pages place them.
    if (!update.source_version_id) return;
    const version = await this.store.getSourceVersion(update.source_version_id);
    if (!version) throw new RangeError(`unknown source version ${update.source_version_id}`);
    await this.update(version);
  };

  handlers(): Record<string, EventHandler> {
    return { "claims.updated": this.onClaimsUpdated };
  }

  /**
   * Bring a document's sections and their statements' placements up to date with its latest
   * version: a new or changed section of a governed document joins the nearest topic, at
   * `join` similarity or more, or stays unfiled until the next re-clustering; a statement
   * with a slot goes where its slot's statements are. Placements of statements the document
   * no longer states are removed, unless confirmed. Doing it again changes nothing.
   */
  async update(version: SourceVersion): Promise<void> {
    await this.#serial(version.tenant_id, () => this.#update(version));
  }

  /**
   * Cluster the sections of the tenant's current governed documents again, space by space,
   * starting from the topics of the last run, and place every statement: in its section's
   * topic, or with a slot in the topic most of the slot's statements are in. Statements of
   * reference documents are placed only through their slot. New topics are named by the
   * model; topics left without statements are retired. Confirmed topics and placements stay.
   */
  async recluster(tenantId: string): Promise<ReclusterReport> {
    return this.#serial(tenantId, () =>
      reclusterTenant(
        {
          store: this.store,
          records: this.records,
          models: this.models,
          prompts: this.prompts,
          clock: this.clock,
          options: this.options,
        },
        tenantId,
      ),
    );
  }

  /**
   * Make a member the owner of a topic, or no one's with undefined. The owner answers for
   * the topic's statements and gets its reviews; re-clustering keeps it. People and the
   * business layer assign owners.
   */
  async setOwner(tenantId: string, topicKey: string, ownerId: string | undefined): Promise<TaxonomyNode> {
    return this.#serial(tenantId, async () => {
      const node = (await this.store.topics(tenantId)).find((n) => n.key === topicKey);
      if (!node) throw new RangeError(`unknown topic ${topicKey}`);
      const { owner_id: _owner, ...rest } = node;
      const next: TaxonomyNode = ownerId === undefined ? rest : { ...rest, owner_id: ownerId };
      if (next.owner_id !== node.owner_id) await this.store.transaction((tx) => tx.putTopics([next]));
      return next;
    });
  }

  /**
   * The documents whose governed sections each topic holds, by leaf topic, with how many
   * of their sections and statements are there, the most first.
   */
  async documentsIn(tenantId: string): Promise<Map<string, TopicDocument[]>> {
    const out = new Map<string, Map<string, TopicDocument>>();
    for (const s of await this.records.find(SECTIONS, { tenant_id: tenantId })) {
      if (!s.topic || !clustered(s)) continue;
      const d = entry(
        entry(out, s.topic, () => new Map<string, TopicDocument>()),
        s.document,
        () => ({
          document: s.document,
          source_version_id: s.source_version_id,
          title: s.title,
          sections: 0,
          statements: 0,
        }),
      );
      d.sections++;
      d.statements += s.claims.length;
    }
    return new Map(
      [...out].map(([k, docs]) => [
        k,
        [...docs.values()].sort((a, b) => b.statements - a.statements || (a.document < b.document ? -1 : 1)),
      ]),
    );
  }

  async #serial<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    const before = this.#running.get(tenantId) ?? Promise.resolve();
    const run = before.catch(() => undefined).then(fn);
    this.#running.set(tenantId, run);
    try {
      return await run;
    } finally {
      if (this.#running.get(tenantId) === run) this.#running.delete(tenantId);
    }
  }

  async #update(version: SourceVersion): Promise<void> {
    // Whichever version's event comes, the document is read as it is now, so a late or
    // repeated delivery changes nothing.
    const latest = (await this.store.latestSourceVersion(version.source_id, version.external_id)) ?? version;
    const tenantId = latest.tenant_id;
    await flushPending(this.store, this.records, tenantId);
    const old = await this.records.find(SECTIONS, { tenant_id: tenantId, document: documentOf(latest) });
    const oldByKey = new Map(old.map((s) => [s.key, s]));
    const built = await sectionsOf(this.store, latest);

    const fresh = selectFreshSections(built, oldByKey);
    if (fresh.length) {
      const vectors = await embedSections(
        this.models,
        tenantId,
        latest.space_id,
        latest.sensitivity,
        fresh,
        this.totals,
      );
      const leaves = (await this.records.find(TOPICS, { tenant_id: tenantId, space_id: latest.space_id, leaf: true }))
        .filter((t) => !t.retired)
        .map((t) => ({ key: t.key, centroid: dequantize(t.centroid) }));
      fresh.forEach((b, i) => {
        assignNearestLeaf(
          b.section,
          vectors[i] as Float32Array,
          oldByKey.get(b.section.key)?.topic,
          leaves,
          this.options,
        );
      });
    }

    const sections = built.map((b) => b.section);
    const slotKeys = [...new Set(sections.flatMap((s) => s.claims.flatMap((c) => (c.slot ? [c.slot] : []))))];
    const slotTopics = new Map(
      (
        await this.records.getMany(
          SLOTS,
          slotKeys.map((k) => recordKey(tenantId, latest.space_id, k)),
        )
      ).map((s) => [s.slot_key, s.topic]),
    );
    const desired = desiredDocumentPlacements(sections, slotTopics);

    const now = new Set(sections.flatMap((s) => s.claims.map((c) => c.id)));
    const before = new Set(old.flatMap((s) => s.claims.map((c) => c.id)));
    const ids = [...new Set([...before, ...now])];
    const placed = new Map((await batched(ids, (x) => this.store.placementsOf(x))).map((p) => [p.claim_id, p]));
    const { place, unplace, delta } = diffDocumentPlacements(
      tenantId,
      latest.space_id,
      ids,
      before,
      now,
      placed,
      desired,
      this.clock().toISOString(),
    );

    // The counts above are the old sections' contributions taken away and the new ones added,
    // so the new sections and the store writes commit together, before the store has them.
    const nodes = delta.size ? await recountedNodes(this.store, tenantId, delta) : [];
    const pending: PendingWrite | undefined =
      place.length || unplace.length || nodes.length
        ? {
            tenant_id: tenantId,
            document: documentOf(latest),
            counts: Object.fromEntries(nodes.map((n) => [n.key, n.statement_count ?? 0])),
            place,
            unplace,
          }
        : undefined;
    const keys = new Set(sections.map((s) => s.key));
    const gone = old.filter((s) => !keys.has(s.key)).map((s) => s.key);
    const changed = sections.filter((s) => canonical(s) !== canonical(oldByKey.get(s.key) ?? {}));
    if (changed.length || gone.length || pending) {
      await this.records.transaction(async (tx) => {
        if (gone.length) await tx.delete(SECTIONS, gone);
        if (changed.length) await tx.put(SECTIONS, changed);
        if (pending) await tx.put(PENDING, [pending]);
      });
    }
    if (pending) await writePending(this.store, this.records, pending);
    this.totals.updates++;
  }
}
