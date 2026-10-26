import { createHash } from "node:crypto";
import {
  type ChatMessage,
  type Claim,
  type ClaimEvidence,
  contentHash,
  type EventEnvelope,
  type EventHandler,
  GatewayException,
  type GovernanceLevel,
  type KnowledgeStore,
  levelOf,
  type ModelGateway,
  maxLabel,
  type Placement,
  payloadOf,
  type SensitivityLabel,
  type SourceBlock,
  type SourceVersion,
  slotOf,
  type TaxonomyNode,
} from "@inspiration/contracts";
import { defineTable, type Records } from "@inspiration/eventbus";
import { languageOf, logger } from "@inspiration/kernel";
import { PromptRegistry } from "@inspiration/model-gateway";
import { type Anchor, CLUSTER_DEFAULTS, type ClusterOptions, cluster, dot, type Level, type Topic } from "./cluster.ts";
import { cleanHeading } from "./headings.ts";
import {
  NAME_PROMPT_VERSION,
  NAME_SCHEMA,
  NAME_TASK,
  NAMES_PER_CALL,
  type NamedTopic,
  type NameInput,
  type NameOutput,
  type TopicInput,
} from "./protocol.ts";

const log = logger("page-compiler");

export const COMPONENT = "page-compiler";

/** Characters of a section's text that go into its embedding. */
export const EMBED_CHARS = 1000;
/** Texts per embedding call. */
const EMBED_BATCH = 64;
/** IDs per store read. */
const READ_BATCH = 500;

const PROMPTS_DIR = new URL("../prompts/", import.meta.url).pathname;
const RETIRED = new Set(["archived", "retired"]);
const LIVE_STATUSES = new Set(["active", "verified", "disputed"]);

/** The blocks under one heading path of a document, and the current claims they state. */
export interface Section {
  key: string;
  tenant_id: string;
  space_id: string;
  /** source_id:external_id */
  document: string;
  source_version_id: string;
  title: string;
  heading_path: string[];
  level: GovernanceLevel;
  /** Its document is archived or retired: its claims are history, and are not placed. */
  archived?: true;
  sensitivity: SensitivityLabel;
  language?: string;
  /** Current claims, in reading order, with their slots. */
  claims: { id: string; slot?: string }[];
  /** Sections of current governed documents only: what the embedding was made from, and the embedding. */
  text_hash?: string;
  vector?: string;
  /** Its leaf topic, and how close it is to it. */
  topic?: string;
  score?: number;
}

/** A topic as clustering left it: where it sits, and the centroid the next run starts from. */
export interface TopicState {
  tenant_id: string;
  key: string;
  space_id: string;
  level: Level;
  parent?: string;
  /** It holds sections itself: a subtopic, or a topic without subtopics. */
  leaf: boolean;
  centroid: string;
  retired?: true;
}

/** The topic a fact slot's claims go to in a space: the one most of its statements are in. */
export interface SlotTopic {
  tenant_id: string;
  space_id: string;
  slot_key: string;
  topic: string;
}

/**
 * Store writes an update decided on, kept with the sections they follow from until the store
 * has them. The knowledge store and these records commit separately; counts are absolute,
 * so writing them again is the same as writing them once.
 */
export interface PendingWrite {
  tenant_id: string;
  document: string;
  /** Statement counts of the topics that change, by key. */
  counts: Record<string, number>;
  place: Placement[];
  unplace: string[];
}

const key = (...parts: string[]) => parts.join("\x1f");

export const SECTIONS = defineTable<Section>("page_compiler.sections", {
  key: (s) => s.key,
  columns: { tenant_id: (s) => s.tenant_id, document: (s) => s.document },
});

export const TOPICS = defineTable<TopicState>("page_compiler.topics", {
  key: (t) => key(t.tenant_id, t.key),
  columns: { tenant_id: (t) => t.tenant_id, space_id: (t) => t.space_id, leaf: (t) => t.leaf },
  types: { leaf: "boolean" },
});

export const SLOTS = defineTable<SlotTopic>("page_compiler.slots", {
  key: (s) => key(s.tenant_id, s.space_id, s.slot_key),
  columns: { tenant_id: (s) => s.tenant_id },
});

export const PENDING = defineTable<PendingWrite>("page_compiler.pending", {
  key: (p) => key(p.tenant_id, p.document),
  columns: { tenant_id: (p) => p.tenant_id },
});

export const documentOf = (v: Pick<SourceVersion, "source_id" | "external_id">) => `${v.source_id}:${v.external_id}`;

/** A unit vector as int8, scaled to its largest component, in base64. */
export function quantize(v: Float32Array): string {
  let max = 0;
  for (const x of v) max = Math.max(max, Math.abs(x));
  const q = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) q[i] = Math.round(((v[i] as number) / (max || 1)) * 127);
  return Buffer.from(q.buffer).toString("base64");
}

export function dequantize(text: string): Float32Array {
  const bytes = Buffer.from(text, "base64");
  const v = Float32Array.from(new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length));
  return normalized(v);
}

function normalized(v: Float32Array): Float32Array {
  const norm = Math.hypot(...v) || 1;
  for (let i = 0; i < v.length; i++) v[i] = (v[i] as number) / norm;
  return v;
}

/** Sections whose statements are clustered: those of current governed documents. */
const clustered = (s: Section) => s.level === "governed" && !s.archived;

/** Placements clustering never moves: confirmed ones, and those a page or a person made. */
const fixed = (p: Placement | undefined) => p !== undefined && (p.confirmed || p.placed_by !== "clustering");

const score = (x: number) => Math.max(0, Math.min(1, Math.round(x * 1000) / 1000));

async function batched<T>(ids: readonly string[], read: (ids: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += READ_BATCH) out.push(...(await read(ids.slice(i, i + READ_BATCH))));
  return out;
}

/** JSON with every object's keys sorted, so two records compare by content. */
const canonical = (value: unknown) =>
  JSON.stringify(value, (_k, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );

/** The map's value for the key, made and stored first when there is none. */
function entry<K, V>(map: Map<K, V>, k: K, make: () => V): V {
  let v = map.get(k);
  if (v === undefined) {
    v = make();
    map.set(k, v);
  }
  return v;
}

function bump(counts: Map<string, number>, k: string | undefined, by = 1): void {
  if (k !== undefined) counts.set(k, (counts.get(k) ?? 0) + by);
}

const byCount = (counts: ReadonlyMap<string, number>) =>
  [...counts].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0));

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

/** What one re-clustering of a tenant did. */
export interface ReclusterReport {
  tenant_id: string;
  /** Governed sections clustered, and their statements. */
  sections: number;
  statements: number;
  topics: {
    live: number;
    by_level: Record<"1" | "2" | "3", number>;
    created: number;
    retired: number;
    confirmed: number;
  };
  /** Current statements with a topic, by their document's level. */
  placed: Record<GovernanceLevel, number>;
  /** Statements of current governed documents without a topic (unfiled). */
  unfiled: number;
  /**
   * Statements clustering had placed before the run: those now in another topic or none,
   * and those the change budget kept where they were.
   */
  churn: { before: number; moved: number; deferred: number };
  /**
   * Statements per leaf topic, and per topic (subtopics included) with its distinct fact
   * slots and its distinct statements (a slot counted once).
   */
  sizes: { leaves: number[]; topics: number[]; topic_slots: number[]; topic_distinct: number[] };
  /** Topics named, and the model calls that named them. */
  named: number;
  model_calls: number;
}

interface Built {
  section: Section;
  /** For clustered sections: the deepest heading, and the text the embedding is made from. */
  heading?: string;
  text?: string;
}

interface Target {
  topic: string;
  score?: number;
}

/** What naming a topic takes, and the sensitivity and language of the call it goes in. */
type NameRequest = Omit<TopicInput, "ref"> & { sensitivity: SensitivityLabel; language: string };

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
    return this.#serial(tenantId, () => this.#recluster(tenantId));
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

  // ------------------------------------------------------------ incremental update

  async #update(version: SourceVersion): Promise<void> {
    // Whichever version's event comes, the document is read as it is now, so a late or
    // repeated delivery changes nothing.
    const latest = (await this.store.latestSourceVersion(version.source_id, version.external_id)) ?? version;
    const tenantId = latest.tenant_id;
    await this.#flush(tenantId);
    const old = await this.records.find(SECTIONS, { tenant_id: tenantId, document: documentOf(latest) });
    const oldByKey = new Map(old.map((s) => [s.key, s]));
    const built = await this.#sectionsOf(latest);

    const fresh = built.filter((b) => {
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
    if (fresh.length) {
      const vectors = await this.#embed(tenantId, latest.sensitivity, fresh);
      const leaves = (await this.records.find(TOPICS, { tenant_id: tenantId, space_id: latest.space_id, leaf: true }))
        .filter((t) => !t.retired)
        .map((t) => ({ key: t.key, centroid: dequantize(t.centroid) }));
      fresh.forEach((b, i) => {
        const v = vectors[i] as Float32Array;
        b.section.vector = quantize(v);
        // It stays in its topic while close enough to it, as in a re-clustering; else the nearest.
        const previous = oldByKey.get(b.section.key)?.topic;
        const home = leaves.find((l) => l.key === previous);
        let best = home && dot(v, home.centroid) >= this.options.keep ? home : undefined;
        let bestSim = best ? dot(v, best.centroid) : this.options.join;
        if (!best) {
          for (const l of leaves) {
            const sim = dot(v, l.centroid);
            if (sim >= bestSim) [best, bestSim] = [l, sim];
          }
        }
        if (best) {
          b.section.topic = best.key;
          b.section.score = score(bestSim);
        }
      });
    }

    const sections = built.map((b) => b.section);
    const slotKeys = [...new Set(sections.flatMap((s) => s.claims.flatMap((c) => (c.slot ? [c.slot] : []))))];
    const slotTopics = new Map(
      (
        await this.records.getMany(
          SLOTS,
          slotKeys.map((k) => key(tenantId, latest.space_id, k)),
        )
      ).map((s) => [s.slot_key, s.topic]),
    );
    const desired = new Map<string, Target>();
    for (const s of sections) {
      if (s.archived) continue;
      for (const c of s.claims) {
        const bySlot = c.slot ? slotTopics.get(c.slot) : undefined;
        if (bySlot) desired.set(c.id, { topic: bySlot });
        else if (s.topic && clustered(s))
          desired.set(c.id, { topic: s.topic, ...(s.score !== undefined && { score: s.score }) });
      }
    }

    const now = new Set(sections.flatMap((s) => s.claims.map((c) => c.id)));
    const before = new Set(old.flatMap((s) => s.claims.map((c) => c.id)));
    const ids = [...new Set([...before, ...now])];
    const placed = new Map((await batched(ids, (x) => this.store.placementsOf(x))).map((p) => [p.claim_id, p]));
    const place: Placement[] = [];
    const unplace: string[] = [];
    const delta = new Map<string, number>();
    const at = this.clock().toISOString();
    for (const id of ids) {
      const p = placed.get(id);
      let after: string | undefined;
      if (fixed(p)) after = now.has(id) ? p?.taxonomy_key : undefined;
      else {
        const target = now.has(id) ? desired.get(id) : undefined;
        after = target?.topic;
        if (target && p?.taxonomy_key !== target.topic)
          place.push(this.#placement(tenantId, latest.space_id, id, target, at));
        if (!target && p) unplace.push(id);
      }
      const was = before.has(id) ? p?.taxonomy_key : undefined;
      if (was !== after) {
        bump(delta, was, -1);
        bump(delta, after);
      }
    }

    // The counts above are the old sections' contributions taken away and the new ones added,
    // so the new sections and the store writes commit together, before the store has them.
    const nodes = delta.size ? await this.#recounted(tenantId, delta) : [];
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
    if (pending) await this.#write(pending);
    this.totals.updates++;
  }

  /**
   * Finish the store writes of updates that failed after their sections committed. It runs
   * before anything else reads or changes the tenant's counts, so absolute counts stay right.
   */
  async #flush(tenantId: string): Promise<void> {
    for (const p of await this.records.find(PENDING, { tenant_id: tenantId })) await this.#write(p);
  }

  async #write(p: PendingWrite): Promise<void> {
    const counts = Object.entries(p.counts);
    const nodes = counts.length ? new Map((await this.store.topics(p.tenant_id)).map((n) => [n.key, n])) : new Map();
    const writes = counts.flatMap(([k, count]) => {
      const n = nodes.get(k);
      return n && n.statement_count !== count ? [{ ...n, statement_count: count }] : [];
    });
    await this.store.transaction(async (tx) => {
      if (writes.length) await tx.putTopics(writes);
      if (p.unplace.length) await tx.unplace(p.unplace);
      if (p.place.length) await tx.place(p.place);
    });
    await this.records.transaction((tx) => tx.delete(PENDING, [PENDING.key(p)]));
  }

  /** The tenant's topic nodes whose statement counts the delta changes, counted again up the tree. */
  async #recounted(tenantId: string, delta: ReadonlyMap<string, number>): Promise<TaxonomyNode[]> {
    const nodes = new Map((await this.store.topics(tenantId)).map((n) => [n.key, n]));
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

  #placement(tenantId: string, spaceId: string, claimId: string, target: Target, at: string): Placement {
    return {
      tenant_id: tenantId,
      claim_id: claimId,
      space_id: spaceId,
      taxonomy_key: target.topic,
      placed_by: "clustering",
      confirmed: false,
      placed_at: at,
      ...(target.score !== undefined && { score: target.score }),
    };
  }

  /**
   * A version's sections: its blocks grouped by heading path, each with the current claims
   * that rest on its spans (a claim citing several sections belongs to the first). Search-only
   * and deleted versions have none, and neither has a section without current claims.
   */
  async #sectionsOf(version: SourceVersion): Promise<Built[]> {
    const level = levelOf(version);
    if (version.deleted || level === "search_only") return [];
    const title = version.title ?? version.external_id;
    // Headings are read as the paths of the blocks under them; a table is read as its rows.
    const blocks = (await this.store.blocksOf(version.id))
      .filter((b) => b.kind !== "heading" && b.kind !== "table" && b.span_ids.length)
      .sort((a, b) => a.ordinal - b.ordinal);
    if (!blocks.length) return [];
    const spanIds = blocks.flatMap((b) => b.span_ids);
    const claims = (await batched(await this.store.claimsCiting(spanIds), (ids) => this.store.getClaims(ids))).filter(
      (c) => c.superseded_at === undefined && LIVE_STATUSES.has(c.status),
    );
    if (!claims.length) return [];
    const evidence: ClaimEvidence[] = await batched(
      claims.map((c) => c.id),
      (ids) => this.store.evidenceOf(ids),
    );

    const groups = new Map<string, { path: string[]; blocks: SourceBlock[] }>();
    const rank = new Map<string, number>();
    const groupOf = new Map<string, string>();
    for (const b of blocks) {
      const path = b.heading_path?.length ? b.heading_path : [title];
      const k = JSON.stringify(path);
      entry(groups, k, () => ({ path, blocks: [] as SourceBlock[] })).blocks.push(b);
      for (const s of b.span_ids) {
        rank.set(s, rank.size);
        groupOf.set(s, k);
      }
    }
    const first = new Map<string, number>();
    for (const e of evidence) {
      const r = rank.get(e.span_id);
      if (e.role === "supports" && r !== undefined && r < (first.get(e.claim_id) ?? Number.POSITIVE_INFINITY)) {
        first.set(e.claim_id, r);
      }
    }
    const byGroup = new Map<string, Claim[]>();
    const inOrder = claims
      .filter((c) => first.has(c.id))
      .sort((a, b) => (first.get(a.id) as number) - (first.get(b.id) as number));
    const spanAt = [...rank.keys()];
    for (const c of inOrder) {
      const g = groupOf.get(spanAt[first.get(c.id) as number] as string) as string;
      byGroup.set(g, [...(byGroup.get(g) ?? []), c]);
    }

    const archived = RETIRED.has(version.approval_state);
    const cluster = level === "governed" && !archived;
    const texts = cluster ? new Map((await this.store.getSpans(spanIds)).map((s) => [s.id, s.text])) : undefined;
    const document = documentOf(version);
    const out: Built[] = [];
    for (const [k, g] of groups) {
      const stated = byGroup.get(k);
      if (!stated?.length) continue;
      const section: Section = {
        key: `s-${createHash("sha256")
          .update(key(version.tenant_id, document, ...g.path))
          .digest("hex")
          .slice(0, 24)}`,
        tenant_id: version.tenant_id,
        space_id: version.space_id,
        document,
        source_version_id: version.id,
        title,
        heading_path: g.path,
        level,
        sensitivity: version.sensitivity,
        claims: stated.map((c) => {
          const slot = slotOf(c);
          return slot ? { id: c.id, slot } : { id: c.id };
        }),
      };
      if (archived) section.archived = true;
      if (version.language) section.language = version.language;
      if (!texts) {
        out.push({ section });
        continue;
      }
      const heading = cleanHeading(g.path.at(-1) as string);
      const body = g.blocks.flatMap((b) => b.span_ids.map((id) => texts.get(id) ?? "")).join("\n");
      const text = `${g.path.map(cleanHeading).join(" / ")}\n${body}`.slice(0, EMBED_CHARS);
      section.text_hash = contentHash(`${heading}\x1f${text}`);
      out.push({ section, heading, text });
    }
    return out;
  }

  /**
   * One vector per section: its heading's embedding plus its text's, normalized, so sections
   * under the same heading stay together even when their passages differ.
   */
  async #embed(tenantId: string, sensitivity: SensitivityLabel, built: readonly Built[]): Promise<Float32Array[]> {
    const texts = built.flatMap((b) => [b.heading as string, b.text as string]);
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      const batch = texts.slice(i, i + EMBED_BATCH) as [string, ...string[]];
      const result = await this.models.embed({
        texts: batch,
        input_type: "document",
        sensitivity,
        budget_key: `tenant:${tenantId}/${COMPONENT}`,
        tenant_id: tenantId,
      });
      vectors.push(...result.vectors);
      this.totals.embed_calls++;
    }
    this.totals.embedded += built.length;
    return built.map((_, i) => {
      const heading = vectors[2 * i] as number[];
      const text = vectors[2 * i + 1] as number[];
      return normalized(Float32Array.from(heading, (x, j) => x + (text[j] as number)));
    });
  }

  // ------------------------------------------------------------ re-clustering

  async #recluster(tenantId: string): Promise<ReclusterReport> {
    await this.#flush(tenantId);
    const sections = await this.records.find(SECTIONS, { tenant_id: tenantId });
    const states = await this.records.find(TOPICS, { tenant_id: tenantId });
    const nodes = new Map((await this.store.topics(tenantId)).map((n) => [n.key, n]));
    const claimIds = [...new Set(sections.flatMap((s) => s.claims.map((c) => c.id)))];
    const placed = new Map(
      (await batched(claimIds, (ids) => this.store.placementsOf(ids))).map((p) => [p.claim_id, p]),
    );
    const reserved = [...nodes.keys(), ...states.map((t) => t.key)];
    const report = emptyReport(tenantId);

    const live: Topic[] = [];
    const retired: string[] = [];
    const spaceOf = new Map<string, string>();
    const topicOf = new Map<string, { topic: string; score: number } | undefined>();
    const desired = new Map<string, Target>();
    const slotRows: SlotTopic[] = [];
    for (const space of [...new Set(sections.map((s) => s.space_id))].sort()) {
      const inSpace = sections.filter((s) => s.space_id === space);
      const units = inSpace
        .filter((s) => clustered(s) && s.vector)
        .map((s) => ({
          key: s.key,
          vector: dequantize(s.vector as string),
          statements: s.claims.length,
          document: s.document,
          ...(s.topic && { previous: s.topic }),
        }));
      const spaceStates = states.filter((t) => t.space_id === space);
      // Topics an owner confirmed or that hold a confirmed placement are kept, and so are the
      // topics above them.
      const kept = new Set(spaceStates.filter((t) => isConfirmed(nodes.get(t.key))).map((t) => t.key));
      for (const p of placed.values()) if (fixed(p) && p.space_id === space) kept.add(p.taxonomy_key);
      const parentOf = new Map(spaceStates.map((t) => [t.key, t.parent]));
      for (const k of [...kept]) for (let p = parentOf.get(k); p; p = parentOf.get(p)) kept.add(p);
      const anchors: Anchor[] = spaceStates
        .filter((t) => !t.retired)
        .map((t) => ({
          key: t.key,
          level: t.level,
          ...(t.parent && { parent: t.parent }),
          centroid: dequantize(t.centroid),
          ...(kept.has(t.key) && { confirmed: true }),
        }));
      const result = cluster(space, units, anchors, this.options, reserved);
      reserved.push(...result.topics.map((t) => t.key));
      live.push(...result.topics);
      retired.push(...result.retired);
      for (const t of result.topics) spaceOf.set(t.key, space);
      report.sections += units.length;
      report.statements += units.reduce((n, u) => n + u.statements, 0);
      report.churn.deferred += result.deferred;

      // Each statement goes with its section, and a slot's statements to the topic most of them are in.
      const centroids = new Map(result.topics.map((t) => [t.key, t.centroid]));
      const vectors = new Map(units.map((u) => [u.key, u.vector]));
      const votes = new Map<string, Map<string, number>>();
      for (const s of inSpace.filter(clustered)) {
        const at = result.placed.get(s.key);
        topicOf.set(s.key, at);
        for (const c of s.claims) {
          const p = placed.get(c.id);
          const topic = fixed(p) ? p?.taxonomy_key : at?.topic;
          if (!fixed(p) && at) desired.set(c.id, at);
          if (c.slot && topic) {
            bump(
              entry(votes, c.slot, () => new Map<string, number>()),
              topic,
            );
          }
        }
      }
      const slotTopic = new Map([...votes].map(([slot, v]) => [slot, (byCount(v)[0] as [string, number])[0]]));
      for (const [slot, topic] of slotTopic)
        slotRows.push({ tenant_id: tenantId, space_id: space, slot_key: slot, topic });
      for (const s of inSpace) {
        if (s.archived) continue;
        const vector = vectors.get(s.key);
        for (const c of s.claims) {
          const topic = c.slot ? slotTopic.get(c.slot) : undefined;
          if (!topic || fixed(placed.get(c.id)) || desired.get(c.id)?.topic === topic) continue;
          const centroid = centroids.get(topic);
          desired.set(c.id, { topic, ...(vector && centroid && { score: score(dot(vector, centroid)) }) });
        }
      }
    }

    // Name the new topics from the bottom up, so a topic with topics below it is named after them.
    const created = live.filter((t) => t.created);
    const sectionByKey = new Map(sections.map((s) => [s.key, s]));
    const statementOf = await this.#statements(created, sectionByKey);
    const names = new Map<string, NamedTopic>();
    const titleOf = (k: string) => names.get(k)?.title ?? nodes.get(k)?.title;
    const naming = { named: 0, calls: 0 };
    for (const level of [3, 2, 1]) {
      const inputs = created
        .filter((t) => t.level === level)
        .map((t) => ({
          topic: t,
          input: this.#nameInput(t, sectionByKey, statementOf, (k) => titleOf(k), live),
        }));
      for (const [k, named] of await this.#name(tenantId, inputs, naming)) names.set(k, named);
    }
    report.named = naming.named;
    report.model_calls = naming.calls;

    // Statement counts, from where every current statement ends up.
    const own = new Map<string, number>();
    const unitSlots = new Map<string, Set<string>>();
    const loose = new Map<string, number>();
    for (const s of sections) {
      for (const c of s.claims) {
        const p = placed.get(c.id);
        const topic = fixed(p) ? p?.taxonomy_key : desired.get(c.id)?.topic;
        if (topic) {
          bump(own, topic);
          report.placed[s.level]++;
          if (c.slot) entry(unitSlots, topic, () => new Set<string>()).add(c.slot);
          else bump(loose, topic);
        } else if (clustered(s)) report.unfiled++;
      }
    }
    const parentOf = new Map<string, string | undefined>([...nodes.values()].map((n) => [n.key, n.parent_key]));
    for (const t of live) parentOf.set(t.key, t.parent);
    const total = new Map<string, number>();
    const looseBelow = new Map<string, number>();
    const slotsBelow = new Map<string, Set<string>>();
    for (const [k, n] of own) {
      for (let at: string | undefined = k; at; at = parentOf.get(at)) {
        bump(total, at, n);
        bump(looseBelow, at, loose.get(k) ?? 0);
        const set = entry(slotsBelow, at, () => new Set<string>());
        for (const slot of unitSlots.get(k) ?? []) set.add(slot);
      }
    }

    // Nodes: live topics, retired ones, and stale proposals clustering no longer knows.
    const liveKeys = new Set(live.map((t) => t.key));
    const ordinals = new Map<string, number>();
    for (const n of nodes.values()) {
      const parent = n.parent_key ?? "";
      ordinals.set(parent, Math.max(ordinals.get(parent) ?? -1, n.ordinal));
    }
    const nextOrdinal = (parent: string | undefined) => {
      const n = (ordinals.get(parent ?? "") ?? -1) + 1;
      ordinals.set(parent ?? "", n);
      return n;
    };
    const writes: TaxonomyNode[] = [];
    const byWeight = (a: Topic, b: Topic) => b.statements - a.statements || (a.key < b.key ? -1 : 1);
    for (const t of [...live].sort((a, b) => a.level - b.level || byWeight(a, b))) {
      const before = nodes.get(t.key);
      const named = names.get(t.key);
      const { parent_key: _parent, ...rest } = before ?? ({} as Partial<TaxonomyNode>);
      const next: TaxonomyNode = {
        ...rest,
        key: t.key,
        tenant_id: tenantId,
        space_id: spaceOf.get(t.key) as string,
        title: before?.title ?? named?.title ?? t.key,
        ordinal: before?.ordinal ?? nextOrdinal(t.parent),
        statement_count: total.get(t.key) ?? 0,
        ...(t.parent && { parent_key: t.parent }),
        ...(!before && { status: "proposed" as const }),
        ...(!before && named?.summary && { summary: named.summary }),
      };
      if (!before || canonical(next) !== canonical(before)) writes.push(next);
    }
    const retiring = new Set(retired);
    for (const n of nodes.values()) {
      if (!liveKeys.has(n.key) && n.status !== "retired" && !isConfirmed(n)) retiring.add(n.key);
    }
    for (const k of retiring) {
      const before = nodes.get(k);
      if (before && (before.status !== "retired" || before.statement_count !== 0)) {
        writes.push({ ...before, status: "retired", statement_count: 0 });
      }
    }

    // Placements that change.
    const place: Placement[] = [];
    const unplace: string[] = [];
    const at = this.clock().toISOString();
    for (const s of sections) {
      for (const c of s.claims) {
        const p = placed.get(c.id);
        if (fixed(p)) continue;
        const target = desired.get(c.id);
        if (p && clustered(s)) {
          report.churn.before++;
          if (p.taxonomy_key !== target?.topic) report.churn.moved++;
        }
        if (target && p?.taxonomy_key !== target.topic)
          place.push(this.#placement(tenantId, s.space_id, c.id, target, at));
        if (!target && p) unplace.push(c.id);
      }
    }

    await this.store.transaction(async (tx) => {
      if (writes.length) await tx.putTopics(writes);
      for (let i = 0; i < unplace.length; i += READ_BATCH) await tx.unplace(unplace.slice(i, i + READ_BATCH));
      for (let i = 0; i < place.length; i += READ_BATCH) await tx.place(place.slice(i, i + READ_BATCH));
    });

    const sectionWrites = sections.flatMap((s) => {
      if (!clustered(s) || !topicOf.has(s.key)) return [];
      const to = topicOf.get(s.key);
      if (to?.topic === s.topic && to?.score === s.score) return [];
      const { topic: _topic, score: _score, ...rest } = s;
      return [to ? { ...rest, topic: to.topic, score: to.score } : rest];
    });
    const stateWrites: TopicState[] = live.map((t) => ({
      tenant_id: tenantId,
      key: t.key,
      space_id: spaceOf.get(t.key) as string,
      level: t.level,
      ...(t.parent && { parent: t.parent }),
      leaf: t.leaf,
      centroid: quantize(t.centroid),
    }));
    for (const s of states) {
      if (!s.retired && !liveKeys.has(s.key)) stateWrites.push({ ...s, leaf: false, retired: true });
    }
    const slotKeys = new Set(slotRows.map((r) => SLOTS.key(r)));
    const staleSlots = (await this.records.find(SLOTS, { tenant_id: tenantId }))
      .map((r) => SLOTS.key(r))
      .filter((k) => !slotKeys.has(k));
    await this.records.transaction(async (tx) => {
      if (sectionWrites.length) await tx.put(SECTIONS, sectionWrites);
      if (stateWrites.length) await tx.put(TOPICS, stateWrites);
      if (staleSlots.length) await tx.delete(SLOTS, staleSlots);
      if (slotRows.length) await tx.put(SLOTS, slotRows);
    });

    for (const t of live) {
      report.topics.by_level[String(t.level) as "1" | "2" | "3"]++;
      if (t.leaf) report.sizes.leaves.push(total.get(t.key) ?? 0);
      if (t.level === 2) {
        report.sizes.topics.push(total.get(t.key) ?? 0);
        report.sizes.topic_slots.push(slotsBelow.get(t.key)?.size ?? 0);
        report.sizes.topic_distinct.push((slotsBelow.get(t.key)?.size ?? 0) + (looseBelow.get(t.key) ?? 0));
      }
      if (isConfirmed(nodes.get(t.key))) report.topics.confirmed++;
    }
    report.topics.live = live.length;
    report.topics.created = created.length;
    report.topics.retired = [...retiring].filter((k) => nodes.get(k)?.status !== "retired").length;
    log.debug("re-clustered", {
      tenant: tenantId,
      topics: report.topics.live,
      created: report.topics.created,
      moved: report.churn.moved,
    });
    return report;
  }

  /** A few statements of each new topic, from its largest sections, for naming it. */
  async #statements(topics: readonly Topic[], sections: ReadonlyMap<string, Section>): Promise<Map<string, string>> {
    const ids = topics.flatMap((t) =>
      t.units
        .map((k) => sections.get(k) as Section)
        .sort((a, b) => b.claims.length - a.claims.length || (a.key < b.key ? -1 : 1))
        .slice(0, 5)
        .flatMap((s) => (s.claims[0] ? [s.claims[0].id] : [])),
    );
    const claims = await batched([...new Set(ids)], (x) => this.store.getClaims(x));
    return new Map(claims.map((c) => [c.id, c.statement]));
  }

  #nameInput(
    topic: Topic,
    sections: ReadonlyMap<string, Section>,
    statements: ReadonlyMap<string, string>,
    titleOf: (key: string) => string | undefined,
    live: readonly Topic[],
  ): NameRequest {
    const below = topic.units.map((k) => sections.get(k) as Section);
    const headings = new Map<string, number>();
    const documents = new Map<string, number>();
    const languages = new Map<string, number>();
    for (const s of below) {
      bump(headings, s.heading_path.at(-1) ?? s.title);
      bump(documents, s.title);
      bump(languages, s.language);
    }
    const largest = [...below].sort((a, b) => b.claims.length - a.claims.length || (a.key < b.key ? -1 : 1));
    const children = live.filter((t) => t.parent === topic.key).sort((a, b) => b.statements - a.statements);
    return {
      level: topic.level,
      headings: byCount(headings)
        .slice(0, 10)
        .map(([text, n]) => ({ text, sections: n })),
      documents: byCount(documents)
        .slice(0, 5)
        .map(([title]) => title),
      statements: largest.slice(0, 5).flatMap((s) => {
        const text = s.claims[0] && statements.get(s.claims[0].id);
        return text ? [text.slice(0, 200)] : [];
      }),
      ...(children.length > 0 && {
        topics: children.flatMap((t) => {
          const title = titleOf(t.key);
          return title ? [title] : [];
        }),
      }),
      sensitivity: maxLabel("public", ...below.map((s) => s.sensitivity)),
      // Until documents carry a language tag, the language their headings and titles look to be in.
      language: byCount(languages)[0]?.[0] ?? languageOf([...headings.keys(), ...documents.keys()].join("\n")),
    };
  }

  /**
   * Titles and summaries for new topics, NAMES_PER_CALL per call, each call carrying the
   * highest sensitivity of the sections it shows. A topic the model leaves out, or a call
   * that stays invalid, gets its commonest heading as its title.
   */
  async #name(
    tenantId: string,
    inputs: { topic: Topic; input: NameRequest }[],
    counts: { named: number; calls: number },
  ): Promise<Map<string, NamedTopic>> {
    const out = new Map<string, NamedTopic>();
    const groups = new Map<string, typeof inputs>();
    for (const i of inputs) {
      const k = `${i.input.sensitivity}\x1f${i.input.language}`;
      groups.set(k, [...(groups.get(k) ?? []), i]);
    }
    for (const group of groups.values()) {
      for (let start = 0; start < group.length; start += NAMES_PER_CALL) {
        const batch = group.slice(start, start + NAMES_PER_CALL);
        const first = batch[0] as (typeof batch)[number];
        const refs = new Map(batch.map((b, i) => [`t${i + 1}`, b]));
        const request: NameInput = {
          language: first.input.language,
          topics: [...refs].map(([ref, b]) => {
            const { sensitivity: _s, language: _l, ...input } = b.input;
            return { ref, ...input };
          }),
        };
        let answer: NameOutput | undefined;
        try {
          const completion = await this.models.complete({
            task: NAME_TASK,
            prompt_version: NAME_PROMPT_VERSION,
            messages: this.prompts.render(NAME_TASK, NAME_PROMPT_VERSION, { input: JSON.stringify(request) }) as [
              ChatMessage,
              ...ChatMessage[],
            ],
            response_schema: NAME_SCHEMA,
            tier: "flash",
            sensitivity: first.input.sensitivity,
            budget_key: `tenant:${tenantId}/${COMPONENT}`,
            tenant_id: tenantId,
            temperature: 0,
          });
          answer = completion.json as NameOutput;
        } catch (e) {
          if (!(e instanceof GatewayException && e.code === "invalid_output")) throw e;
          log.warn("no valid names for topics", { tenant: tenantId, error: e.message });
        }
        counts.calls++;
        for (const named of answer?.topics ?? []) {
          const b = refs.get(named.ref);
          const title = named.title.trim();
          if (!b || !title || out.has(b.topic.key)) continue;
          out.set(b.topic.key, {
            ref: named.ref,
            title,
            ...(named.summary?.trim() && { summary: named.summary.trim() }),
          });
          counts.named++;
        }
        for (const [ref, b] of refs) {
          if (out.has(b.topic.key)) continue;
          const title = b.input.headings[0]?.text ?? b.input.documents[0] ?? b.topic.key;
          out.set(b.topic.key, { ref, title: title.slice(0, 40) });
        }
      }
    }
    return out;
  }
}

/** A node without a status predates statuses and counts as confirmed. */
const isConfirmed = (n: TaxonomyNode | undefined) =>
  n !== undefined && (n.status === undefined || n.status === "confirmed");

function emptyReport(tenantId: string): ReclusterReport {
  return {
    tenant_id: tenantId,
    sections: 0,
    statements: 0,
    topics: { live: 0, by_level: { "1": 0, "2": 0, "3": 0 }, created: 0, retired: 0, confirmed: 0 },
    placed: { governed: 0, reference: 0, search_only: 0 },
    unfiled: 0,
    churn: { before: 0, moved: 0, deferred: 0 },
    sizes: { leaves: [], topics: [], topic_slots: [], topic_distinct: [] },
    named: 0,
    model_calls: 0,
  };
}
