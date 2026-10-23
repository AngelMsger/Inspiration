import {
  type Claim,
  type ClaimsUpdated,
  type EventEnvelope,
  type EventHandler,
  type KnowledgeStore,
  kindOf,
  newEvent,
  payloadOf,
  type ReviewDue,
  type SourceVersion,
  type Staleness,
} from "@inspiration/contracts";
import { defineTable, type Records, type RecordTx } from "@inspiration/eventbus";
import { logger } from "@inspiration/kernel";
import {
  addDays,
  type Clock,
  DEFAULT_INTERVALS,
  dayOf,
  type ReviewIntervals,
  reviewInterval,
  staleness,
} from "./rules.ts";

const log = logger("freshness");

export const COMPONENT = "freshness";

/** What freshness keeps of a current claim. */
export interface ClaimNote {
  knowledge_class: string;
  /** For a plan, the day it names. */
  plan_on?: string;
}

/** Freshness's record of one current document. */
export interface DocumentState {
  tenant_id: string;
  /** "<source id>:<external id>" */
  document: string;
  source_version_id: string;
  space_id: string;
  title: string;
  authority: number;
  /** Archived or retired: never due. */
  archived: boolean;
  /** The document has its own date (front matter date): a record of that day, never due by age. */
  dated: boolean;
  /** When the current version was fetched; a version older than this one that arrives late changes nothing. */
  fetched_at: string;
  /** The day the current version last changed in its source. */
  changed_on: string;
  /** Current claims by ID. */
  claims: Record<string, ClaimNote>;
  /** The class whose review interval applies, and the interval. */
  review_class?: string;
  interval_days?: number;
  /** While a document it repeats has changed and it has not: that document, and since when. */
  behind?: { document: string; title: string; since: string };
  /** Plan claims whose day has come. */
  lapsed: string[];
  /** The day of the ttl review already published for this version and interval. */
  ttl_published?: string;
  /** The day freshness first saw the document, in any version. */
  first_seen: string;
}

/** One direction of two documents that repeat each other. */
export interface Copy {
  tenant_id: string;
  document: string;
  other: string;
  /** Share of the two texts in sentences both contain, as normalization measured it. */
  similarity: number;
}

/** A review that falls due on a day. */
export interface Due {
  tenant_id: string;
  document: string;
  kind: "ttl" | "assumption";
  day: string;
  /** For an assumption, the plan claims that name the day. */
  claim_ids: string[];
}

const key = (...parts: string[]) => parts.join("\x1f");

export const DOCUMENTS = defineTable<DocumentState>("freshness.documents", {
  key: (d) => key(d.tenant_id, d.document),
  columns: { tenant_id: (d) => d.tenant_id, source_version_id: (d) => d.source_version_id },
});

export const COPIES = defineTable<Copy>("freshness.copies", {
  key: (c) => key(c.tenant_id, c.document, c.other),
  columns: { tenant_id: (c) => c.tenant_id, document: (c) => c.document },
});

export const DUE = defineTable<Due>("freshness.due", {
  key: (d) => (d.kind === "ttl" ? key(d.tenant_id, d.document, d.kind) : key(d.tenant_id, d.document, d.kind, d.day)),
  columns: { tenant_id: (d) => d.tenant_id, document: (d) => d.document, day: (d) => d.day },
});

const RETIRED = new Set(["archived", "retired"]);
const LIVE_STATUSES = new Set(["active", "verified", "disputed"]);

export interface FreshnessOptions {
  store: KnowledgeStore;
  records: Records;
  /** A tenant's review intervals by knowledge class; the business layer will provide them. */
  intervals?: (tenantId: string) => ReviewIntervals;
  clock?: () => Date;
}

export const documentOf = (v: Pick<SourceVersion, "source_id" | "external_id">) => `${v.source_id}:${v.external_id}`;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What a document's staleness, or that of one of its claims, is computed from. */
export function clockOf(state: DocumentState, claimId?: string): Clock {
  return {
    changed_on: state.changed_on,
    ...(state.interval_days !== undefined && !state.dated && { interval_days: state.interval_days }),
    behind: state.behind !== undefined,
    lapsed: claimId ? state.lapsed.includes(claimId) : state.lapsed.length > 0,
  };
}

/**
 * Freshness: keeps a review clock for every current document, schedules the days plans
 * name, notices copies an edit left behind, and publishes review.due when a review falls
 * due. See the package doc comment for the rules.
 */
export class Freshness {
  readonly store: KnowledgeStore;
  readonly records: Records;
  readonly clock: () => Date;
  readonly intervals: (tenantId: string) => ReviewIntervals;
  readonly totals = { events: 0, reviews: 0 };
  /** Handlers and ticks of one tenant run one at a time: they read and rewrite the same records. */
  readonly #running = new Map<string, Promise<unknown>>();

  constructor(options: FreshnessOptions) {
    this.store = options.store;
    this.records = options.records;
    this.clock = options.clock ?? (() => new Date());
    this.intervals = options.intervals ?? (() => DEFAULT_INTERVALS);
  }

  readonly onBlocksChanged: EventHandler = async (event: EventEnvelope) => {
    await this.blocksChanged(event);
  };

  readonly onClaimsUpdated: EventHandler = async (event: EventEnvelope) => {
    await this.claimsUpdated(event);
  };

  handlers(): Record<string, EventHandler> {
    return { "blocks.changed": this.onBlocksChanged, "claims.updated": this.onClaimsUpdated };
  }

  /**
   * A new version restarts its document's clock. Every document that repeated the old
   * version, shares less of the new one, and is no more authoritative is left behind: it
   * gets an evidence_changed review. Returns the reviews published.
   */
  async blocksChanged(event: EventEnvelope): Promise<ReviewDue[]> {
    return this.#serial(event.tenant_id, () => this.#blocksChanged(event));
  }

  async #blocksChanged(event: EventEnvelope): Promise<ReviewDue[]> {
    const change = payloadOf(event, "blocks.changed");
    const version = await this.store.getSourceVersion(change.source_version_id);
    if (!version) throw new RangeError(`unknown source version ${change.source_version_id}`);
    const tenantId = event.tenant_id;
    const document = documentOf(version);
    const reviews: ReviewDue[] = [];
    await this.records.transaction(async (tx) => {
      if (!(await tx.firstDelivery(COMPONENT, event.id))) return;
      const before = await tx.get(DOCUMENTS, key(tenantId, document));
      if (before && before.fetched_at > version.fetched_at) return;
      const copies = await tx.find(COPIES, { tenant_id: tenantId, document });
      if (change.deleted) {
        await this.#forget(tx, tenantId, document, copies);
        return;
      }
      const state = this.#stateOf(version, before);
      await tx.put(DOCUMENTS, [state]);
      await this.#schedule(tx, state);

      const now = this.clock();
      const duplicates = new Map((change.duplicates ?? []).map((d) => [documentOf(d), d.similarity]));
      const edited = change.previous_version_id !== undefined;
      for (const c of copies) {
        const similarity = duplicates.get(c.other) ?? 0;
        if (!duplicates.has(c.other))
          await tx.delete(COPIES, [key(tenantId, c.document, c.other), key(tenantId, c.other, c.document)]);
        if (!edited || similarity >= c.similarity) continue;
        const other = await tx.get(DOCUMENTS, key(tenantId, c.other));
        if (!other || other.archived || other.authority > state.authority) continue;
        other.behind = { document, title: state.title, since: dayOf(now) };
        await tx.put(DOCUMENTS, [other]);
        const review: ReviewDue = {
          unit_ids: [other.source_version_id],
          kind: "evidence_changed",
          due_at: now.toISOString(),
          space_id: other.space_id,
          reason: `${other.title} repeats ${state.title}, which changed on ${dayOf(now)}; it has not changed since.`,
          cause_ids: [version.id],
          dedupe_key: `${COMPONENT}:evidence_changed:${other.document}`,
        };
        await tx.publish(this.#event(tenantId, other.document, review, event));
        reviews.push(review);
      }
      const rows = [...duplicates].flatMap(([other, similarity]): Copy[] => [
        { tenant_id: tenantId, document, other, similarity },
        { tenant_id: tenantId, document: other, other: document, similarity },
      ]);
      if (rows.length) await tx.put(COPIES, rows);
    });
    this.#count(reviews);
    return reviews;
  }

  /** Keep the classes and plan days of a document's current claims, and set its review interval from them. */
  async claimsUpdated(event: EventEnvelope): Promise<void> {
    return this.#serial(event.tenant_id, () => this.#claimsUpdated(event));
  }

  async #claimsUpdated(event: EventEnvelope): Promise<void> {
    if (event.producer === COMPONENT) return;
    const update: ClaimsUpdated = payloadOf(event, "claims.updated");
    // Merged and human claims belong to no one document; they get their clocks with collaboration.
    if (!update.source_version_id) return;
    const version = await this.store.getSourceVersion(update.source_version_id);
    if (!version) throw new RangeError(`unknown source version ${update.source_version_id}`);
    const ids = [...update.added, ...update.updated];
    const claims: Claim[] = [];
    for (let i = 0; i < ids.length; i += 500) claims.push(...(await this.store.getClaims(ids.slice(i, i + 500))));
    const tenantId = event.tenant_id;
    await this.records.transaction(async (tx) => {
      if (!(await tx.firstDelivery(COMPONENT, event.id))) return;
      const before = await tx.get(DOCUMENTS, key(tenantId, documentOf(version)));
      const state = before && before.fetched_at > version.fetched_at ? before : this.#stateOf(version, before);
      for (const id of [...update.superseded, ...update.updated]) delete state.claims[id];
      for (const c of claims) {
        if (!LIVE_STATUSES.has(c.status)) continue;
        const note: ClaimNote = { knowledge_class: c.knowledge_class };
        if (c.claim_type === "plan" && c.valid_time.start) note.plan_on = dayOf(c.valid_time.start);
        state.claims[c.id] = note;
      }
      state.lapsed = state.lapsed.filter((id) => id in state.claims);
      this.#setInterval(state);
      await tx.put(DOCUMENTS, [state]);
      await this.#schedule(tx, state);
    });
    this.totals.events++;
  }

  /**
   * Publish review.due for every review of the tenant that has fallen due by now, each once.
   * The engine calls it once a day; calling it again publishes nothing new.
   */
  async tick(tenantId: string): Promise<ReviewDue[]> {
    return this.#serial(tenantId, () => this.#tick(tenantId));
  }

  async #tick(tenantId: string): Promise<ReviewDue[]> {
    const today = dayOf(this.clock());
    const reviews: ReviewDue[] = [];
    for (;;) {
      const due = (await this.records.find(DUE, { tenant_id: tenantId }, { orderBy: "day", limit: 200 })).filter(
        (d) => d.day <= today,
      );
      if (!due.length) break;
      await this.records.transaction(async (tx) => {
        await tx.delete(
          DUE,
          due.map((d) => DUE.key(d)),
        );
        for (const d of due) {
          const state = await tx.get(DOCUMENTS, key(tenantId, d.document));
          if (!state || state.archived) continue;
          const review = this.#reviewOf(state, d);
          if (!review) continue;
          if (d.kind === "assumption") state.lapsed = [...new Set([...state.lapsed, ...review.unit_ids])];
          else state.ttl_published = d.day;
          await tx.put(DOCUMENTS, [state]);
          await tx.publish(this.#event(tenantId, d.document, review));
          reviews.push(review);
        }
      });
    }
    this.#count(reviews);
    if (reviews.length) log.debug("reviews due", { tenant: tenantId, reviews: reviews.length });
    return reviews;
  }

  /** Staleness of source versions and claims as of now; units freshness does not know are left out. */
  async staleness(tenantId: string, unitIds: readonly string[]): Promise<Staleness[]> {
    const now = this.clock();
    const claimIds = unitIds.filter((id) => kindOf(id) === "claim");
    const evidence = claimIds.length ? await this.store.evidenceOf(claimIds) : [];
    const versionOf = new Map<string, string>();
    for (const e of evidence)
      if (e.role === "supports" && !versionOf.has(e.claim_id)) versionOf.set(e.claim_id, e.source_version_id);
    const documents = new Map<string, DocumentState | undefined>();
    const stateOfVersion = async (versionId: string) => {
      if (!documents.has(versionId)) {
        const version = await this.store.getSourceVersion(versionId);
        documents.set(versionId, version && (await this.records.get(DOCUMENTS, key(tenantId, documentOf(version)))));
      }
      return documents.get(versionId);
    };
    const out: Staleness[] = [];
    for (const id of unitIds) {
      const kind = kindOf(id);
      const versionId = kind === "source_version" ? id : kind === "claim" ? versionOf.get(id) : undefined;
      const state = versionId ? await stateOfVersion(versionId) : undefined;
      if (!state || (kind === "claim" ? !(id in state.claims) : state.source_version_id !== id)) continue;
      out.push(staleness(id, clockOf(state, kind === "claim" ? id : undefined), now));
    }
    return out;
  }

  /** Every current document of the tenant. */
  async documents(tenantId: string): Promise<DocumentState[]> {
    return this.records.find(DOCUMENTS, { tenant_id: tenantId });
  }

  /** The tenant's scheduled reviews that tick has not published yet, by day; some may be due already. */
  async upcoming(tenantId: string): Promise<Due[]> {
    return this.records.find(DUE, { tenant_id: tenantId }, { orderBy: "day" });
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

  #stateOf(version: SourceVersion, before: DocumentState | undefined): DocumentState {
    if (before?.source_version_id === version.id) return { ...before, claims: { ...before.claims } };
    const now = this.clock().toISOString();
    const modified = version.metadata?.modified_at ?? version.fetched_at;
    const state: DocumentState = {
      tenant_id: version.tenant_id,
      document: documentOf(version),
      source_version_id: version.id,
      space_id: version.space_id,
      title: version.title ?? version.external_id,
      authority: version.authority,
      archived: RETIRED.has(version.approval_state),
      dated: version.metadata?.extra?.date !== undefined,
      fetched_at: version.fetched_at,
      changed_on: dayOf(modified < now ? modified : now),
      claims: { ...before?.claims },
      lapsed: before?.lapsed ?? [],
      first_seen: before?.first_seen ?? dayOf(now),
    };
    this.#setInterval(state);
    return state;
  }

  #setInterval(state: DocumentState): void {
    const classes = new Set(
      Object.values(state.claims)
        .filter((c) => c.plan_on === undefined)
        .map((c) => c.knowledge_class),
    );
    const interval = reviewInterval(classes, this.intervals(state.tenant_id));
    delete state.review_class;
    delete state.interval_days;
    if (interval) {
      state.review_class = interval.knowledge_class;
      state.interval_days = interval.days;
    }
  }

  /**
   * Bring a document's due reviews in line with its state: one ttl review at the end of its
   * interval, and one assumption review per day its plans name. Plan days that had passed
   * when freshness learned of them are not scheduled; ones that pass later wait for tick. A
   * dated record gets neither: later records say what became of its plans.
   */
  async #schedule(tx: RecordTx, state: DocumentState): Promise<void> {
    const today = dayOf(this.clock());
    const existing = await tx.find(DUE, { tenant_id: state.tenant_id, document: state.document });
    const want: Due[] = [];
    const base = { tenant_id: state.tenant_id, document: state.document };
    const reviewOn = state.interval_days ? addDays(state.changed_on, state.interval_days) : undefined;
    if (reviewOn && !state.archived && !state.dated && reviewOn !== state.ttl_published)
      want.push({ ...base, kind: "ttl", day: reviewOn, claim_ids: [] });
    const plans = new Map<string, string[]>();
    for (const d of existing)
      if (d.kind === "assumption" && d.day <= today)
        plans.set(
          d.day,
          d.claim_ids.filter((id) => id in state.claims),
        );
    for (const [id, note] of Object.entries(state.claims)) {
      if (!note.plan_on || note.plan_on <= today) continue;
      plans.set(note.plan_on, [...(plans.get(note.plan_on) ?? []), id]);
    }
    if (!state.archived && !state.dated)
      for (const [day, ids] of plans)
        if (ids.length) want.push({ ...base, kind: "assumption", day, claim_ids: ids.sort() });
    const wanted = new Map(want.map((d) => [DUE.key(d), d]));
    const stale = existing.filter((d) => !wanted.has(DUE.key(d))).map((d) => DUE.key(d));
    if (stale.length) await tx.delete(DUE, stale);
    const before = new Map(existing.map((d) => [DUE.key(d), JSON.stringify(d)]));
    const changed = want.filter((d) => before.get(DUE.key(d)) !== JSON.stringify(d));
    if (changed.length) await tx.put(DUE, changed);
  }

  async #forget(tx: RecordTx, tenantId: string, document: string, copies: readonly Copy[]): Promise<void> {
    await tx.delete(DOCUMENTS, [key(tenantId, document)]);
    const due = await tx.find(DUE, { tenant_id: tenantId, document });
    if (due.length)
      await tx.delete(
        DUE,
        due.map((d) => DUE.key(d)),
      );
    if (copies.length)
      await tx.delete(
        COPIES,
        copies.flatMap((c) => [key(tenantId, c.document, c.other), key(tenantId, c.other, c.document)]),
      );
  }

  #reviewOf(state: DocumentState, d: Due): ReviewDue | undefined {
    const base = { due_at: `${d.day}T00:00:00Z`, space_id: state.space_id };
    if (d.kind === "ttl") {
      if (state.dated || !state.interval_days) return undefined;
      return {
        ...base,
        unit_ids: [state.source_version_id],
        kind: "ttl",
        reason: `${state.title} last changed on ${state.changed_on}; documents with ${state.review_class} claims are reviewed every ${state.interval_days} days.`,
        dedupe_key: `${COMPONENT}:ttl:${state.document}`,
        ...(d.day <= state.first_seen && { backlog: true }),
      };
    }
    const [first, ...rest] = d.claim_ids.filter((id) => id in state.claims);
    if (!first) return undefined;
    const ids: [string, ...string[]] = [first, ...rest];
    return {
      ...base,
      unit_ids: ids,
      kind: "assumption",
      reason: `${state.title} planned ${plural(ids.length, "thing")} for ${d.day}; check whether ${ids.length === 1 ? "it" : "they"} happened.`,
      dedupe_key: `${COMPONENT}:assumption:${state.document}`,
    };
  }

  #event(tenantId: string, document: string, review: ReviewDue, cause?: EventEnvelope): EventEnvelope {
    return newEvent("review.due", review, {
      tenantId,
      producer: COMPONENT,
      subject: document,
      ...(cause && { causation: cause }),
      occurredAt: this.clock(),
    });
  }

  #count(reviews: readonly ReviewDue[]): void {
    this.totals.reviews += reviews.length;
  }
}
