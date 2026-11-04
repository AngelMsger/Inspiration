import {
  type Claim,
  type ClaimsUpdated,
  type ConflictCase,
  canonicalJson,
  contentHash,
  type EventEnvelope,
  type EventHandler,
  type KnowledgeStore,
  levelOf,
  newEvent,
  type Priority,
  type ProducerInfo,
  payloadOf,
  type SlotStanding,
  type SlotValueStanding,
  type SlotVerdict,
  type SlotVerdicts,
  type SourceVersion,
  type Span,
  slotOf,
  stableId,
  type TodoRequested,
  valueKeyOf,
} from "@inspiration/contracts";
import { defineTable, type RecordReader, type Records, type RecordTx } from "@inspiration/eventbus";
import { logger } from "@inspiration/kernel";
import {
  asOf,
  type CaseDraft,
  decide,
  governedIn,
  groupsOf,
  type Member,
  nextChangeDay,
  type SlotDecision,
  type ValueGroup,
  withMember,
} from "./slots.ts";

const log = logger("governance");

export const COMPONENT = "governance";

export const MEMBERS = defineTable<Member>("governance.members", {
  key: (m) => m.claim_id,
  columns: { tenant_id: (m) => m.tenant_id, slot: (m) => m.slot, value: (m) => m.value },
});

export const VALUE_GROUPS = defineTable<ValueGroup>("governance.value_groups", {
  key: (g) => groupKey(g.tenant_id, g.slot, g.value),
  columns: { tenant_id: (g) => g.tenant_id, slot: (g) => g.slot },
});

/** Conflict cases, one per slot and competing value; batch_key is the slot. */
export const CONFLICTS = defineTable<ConflictCase>("governance.conflicts", {
  key: (c) => c.id,
  columns: { tenant_id: (c) => c.tenant_id, slot: (c) => c.batch_key, status: (c) => c.status },
});

/** What governance last asked a person to decide for a slot, and the notes it left. */
export interface SlotState {
  tenant_id: string;
  slot: string;
  /** A hash of the decision in the last todo request; "" after the conflict went away. */
  requested: string;
  /** The last todo request, while the slot asks for one: withdrawn when it stops asking. */
  asked?: TodoRequested;
  /** The notes as last published, while their values are only stated by reference documents. */
  notes?: Note[];
}

/**
 * A note, and what it says that its owner should hear again when it changes: both values,
 * the reference document and the date it states, and the statements it points to.
 */
export interface Note {
  request: TodoRequested;
  said: string;
}

export const SLOTS = defineTable<SlotState>("governance.slots", {
  key: (s) => slotKey(s.tenant_id, s.slot),
  columns: { tenant_id: (s) => s.tenant_id },
});

/** The next day a slot's decision can change without new claims. */
export interface Recheck {
  tenant_id: string;
  slot: string;
  day: string;
}

export const RECHECKS = defineTable<Recheck>("governance.rechecks", {
  key: (r) => slotKey(r.tenant_id, r.slot),
  columns: { tenant_id: (r) => r.tenant_id, day: (r) => r.day },
});

/** The group keeps what it needs to stand as of any day: its day counts, its best by day and its sources. */
const countedByDay = (g: ValueGroup) =>
  g.governed_from !== undefined && g.best_from !== undefined && g.sources !== undefined && g.newest !== undefined;

/**
 * A slot's value groups. A group stored before governed statements were counted by the day
 * they take effect (governed_from), before its best was kept by day (best_from), before its
 * members were kept by source (sources) or dated (newest), or before governance levels, is
 * counted again from its members: its earliest day cannot say when each of them takes
 * effect, nor its count how many sources it has. Returns the groups counted again too, for
 * the caller to store.
 */
async function storedGroups(
  reader: RecordReader,
  tenantId: string,
  slot: string,
  membersOf: (value: string) => Promise<Member[]>,
): Promise<{ groups: ValueGroup[]; recounted: ValueGroup[] }> {
  const recounted: ValueGroup[] = [];
  const groups: ValueGroup[] = [];
  for (const stored of await reader.find(VALUE_GROUPS, { tenant_id: tenantId, slot })) {
    if (countedByDay(stored)) {
      groups.push(stored);
      continue;
    }
    const [group] = groupsOf(await membersOf(stored.value));
    if (!group) continue;
    groups.push(group);
    recounted.push(group);
  }
  return { groups, recounted };
}

function groupKey(tenantId: string, slot: string, value: string): string {
  return `${tenantId}\x1f${slot}\x1f${value}`;
}

function slotKey(tenantId: string, slot: string): string {
  return `${tenantId}\x1f${slot}`;
}

const PRIORITY: readonly Priority[] = ["low", "normal", "high", "urgent"];
/**
 * Letters and digits a passage needs before two documents stating it are a copy rather than
 * two sources that happen to word a short rule alike.
 */
export const MIN_COPY = 40;
const RETIRED = new Set(["archived", "retired"]);
const LIVE_STATUSES = new Set(["active", "verified", "disputed"]);

export interface GovernanceOptions {
  store: KnowledgeStore;
  records: Records;
  clock?: () => Date;
}

/** What one claims.updated changed. */
export interface GovernanceResult {
  /** Slots whose values were compared again. */
  slots: string[];
  /** Todo requests published, one per slot whose decision changed. */
  requests: TodoRequested[];
  /** Notes requested, one per value only reference documents state, when what it says changed. */
  notes: TodoRequested[];
  /** Conflict requests and notes withdrawn because the reason for them went away. */
  withdrawn: TodoRequested[];
}

/** The slot of a current claim with a value, as the member governance keeps for it. */
function memberOf(
  claim: Claim,
  version: SourceVersion | undefined,
  passages: readonly string[] = [],
): Member | undefined {
  const slot = slotOf(claim);
  const value = valueKeyOf(claim);
  if (!slot || value === undefined || !LIVE_STATUSES.has(claim.status)) return undefined;
  const effective = version?.metadata?.extra?.effective_from;
  const documentFrom = typeof effective === "string" ? effective.slice(0, 10) : undefined;
  const start = claim.valid_time.start?.slice(0, 10);
  const member: Member = {
    claim_id: claim.id,
    tenant_id: claim.tenant_id,
    space_id: claim.space_id,
    slot,
    value,
    statement: claim.statement,
    claim_type: claim.claim_type,
    authority: claim.authority,
    weight: claim.weight,
    archived: RETIRED.has(version?.approval_state ?? ""),
    ...(version && levelOf(version) !== "governed" && { reference: true as const }),
    source_version_id: version?.id ?? "",
    document: version?.title ?? version?.external_id ?? "",
  };
  if (version) Object.assign(member, sourceKeysOf(version, passages));
  // Either way the claim counts only from its start. A start equal to the document's
  // effective date is the document's, not a change it states.
  const from = start ?? documentFrom;
  if (from) member.live_from = from;
  if (start && start !== documentFrom) member.stated_from = start;
  if (documentFrom) member.document_from = documentFrom;
  if (version) member.modified = modifiedOf(version);
  return member;
}

/** The day a source version's document was last changed, as its source reports it; "" when it does not. */
function modifiedOf(version: SourceVersion): string {
  return version.version.modified_at?.slice(0, 10) ?? "";
}

/** What makes a member's document a source, and another's statement a copy of it. */
function sourceKeysOf(
  version: SourceVersion,
  passages: readonly string[],
): Required<Pick<Member, "document_key" | "copy_keys">> {
  // A translation shares its original's key, and an original has its own.
  const original = version.metadata?.translation_of ?? version;
  return {
    document_key: `${version.source_id}:${version.external_id}`,
    copy_keys: [`t:${original.source_id}:${original.external_id}`, ...passages.map((p) => `p:${p}`)],
  };
}

/** "hotel_cap_per_night (tier-1 city)" */
function slotLabel(slot: string): string {
  const [predicate, ...qualifiers] = slot.split("|");
  return qualifiers.length ? `${predicate} (${qualifiers.join(", ")})` : (predicate as string);
}

function statements(g: ValueGroup): string {
  const n = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;
  return `${n(g.count, "statement")} in ${n(g.versions.length, "document")}, the most authoritative ${g.best.document}`;
}

/** The todo request for a slot's open cases. */
/**
 * The space whose owner answers for a slot: the proposed value's, or, when only a reference
 * document's change holds it, that of the governed value it changed.
 */
function ownerSpace(proposed: ValueGroup, others: Iterable<ValueGroup>): string {
  if (governedIn(proposed) > 0) return proposed.best.space_id;
  return [...others].find((g) => governedIn(g) > 0)?.best.space_id ?? proposed.best.space_id;
}

function todoOf(decision: SlotDecision, open: readonly CaseDraft[], groups: Map<string, ValueGroup>): TodoRequested {
  const { proposed } = decision;
  const contenders = open.map((c) => groups.get(c.value) as ValueGroup);
  const why = decision.change
    ? `changed on ${decision.change.stated_from} in ${decision.change.document}${decision.change.reference ? ", a reference document" : ""}`
    : "the most authoritative source";
  const detail = [
    `- **${proposed.value}**, proposed (${why}): ${statements(proposed)}.`,
    ...open.map(
      (c) =>
        `- ${c.value}, ${c.classification.replace(/_/g, " ")}: ${statements(groups.get(c.value) as ValueGroup)}. ${c.rationale}`,
    ),
  ].join("\n");
  const priority = open.reduce<Priority>(
    (p, c) => (PRIORITY.indexOf(c.priority) > PRIORITY.indexOf(p) ? c.priority : p),
    "low",
  );
  const predicate = proposed.slot.split("|")[0] as string;
  return {
    kind: "conflict",
    space_id: ownerSpace(proposed, contenders),
    title: `${slotLabel(proposed.slot)}: ${[proposed, ...contenders].map((g) => g.value).join(" or ")}`,
    detail,
    priority,
    unit_ids: [proposed.best.claim_id, ...contenders.map((g) => g.best.claim_id)],
    dedupe_key: `${COMPONENT}:conflict:${proposed.slot}`,
    batch_key: `${COMPONENT}:conflict:${predicate}`,
    slot_key: proposed.slot,
  };
}

/** The request that withdraws an earlier one. */
function withdrawal(request: TodoRequested): TodoRequested {
  return { ...request, withdrawn: true };
}

/** The note for a value only reference documents state: what they say, and the governed value that holds. */
function noteOf(proposed: ValueGroup, other: ValueGroup, draft: CaseDraft, space: string): Note {
  const since = other.best.stated_from ?? other.best.document_from;
  const request: TodoRequested = {
    kind: "note",
    space_id: space,
    title: `${slotLabel(proposed.slot)}: ${other.value} in ${other.best.document}, ${proposed.value} holds`,
    detail: [
      `- **${proposed.value}** holds: ${statements(proposed)}.`,
      `- ${other.value}${since ? ` (from ${since})` : ""}: ${statements(other)}. ${draft.rationale}`,
    ].join("\n"),
    priority: "low",
    unit_ids: [proposed.best.claim_id, other.best.claim_id],
    dedupe_key: `${COMPONENT}:note:${proposed.slot}:${other.value}`,
    batch_key: `${COMPONENT}:note:${proposed.slot}`,
    slot_key: proposed.slot,
  };
  return { request, said: contentHash(JSON.stringify([request.title, since ?? "", request.unit_ids])) };
}

/**
 * Governance: keeps every current claim with a slot and a value in its slot's value groups,
 * decides which value each slot should hold, records a conflict case against every other
 * value, and asks for one todo per slot whose decision needs a person. See the package doc
 * comment for the rules.
 */
export class Governance implements SlotVerdicts {
  readonly store: KnowledgeStore;
  readonly records: Records;
  readonly clock: () => Date;
  readonly totals = { events: 0, slots: 0, requests: 0, notes: 0, withdrawn: 0 };
  /** Updates of one tenant run one at a time: value groups are counted incrementally. */
  readonly #running = new Map<string, Promise<unknown>>();

  constructor(options: GovernanceOptions) {
    this.store = options.store;
    this.records = options.records;
    this.clock = options.clock ?? (() => new Date());
  }

  get producer(): ProducerInfo {
    return { component: COMPONENT, name: "deterministic_tier", version: "1" };
  }

  /** Bring the slots of the claims an update added or closed up to date. Delivering it again changes nothing. */
  async apply(event: EventEnvelope): Promise<GovernanceResult> {
    return this.#serial(event.tenant_id, () => this.#apply(event));
  }

  /**
   * Decide again every slot of the tenant in which a dated change has taken effect since it
   * was last decided. The engine calls it once a day; calling it again changes nothing.
   */
  async recheck(tenantId: string): Promise<GovernanceResult> {
    return this.#serial(tenantId, () => this.#recheck(tenantId));
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

  readonly onClaimsUpdated: EventHandler = async (event: EventEnvelope) => {
    await this.apply(event);
  };

  handlers(): Record<string, EventHandler> {
    return { "claims.updated": this.onClaimsUpdated };
  }

  /** The value groups of a slot and the decision over them. */
  async slot(tenantId: string, slot: string): Promise<{ groups: ValueGroup[]; decision?: SlotDecision }> {
    const { groups } = await storedGroups(this.records, tenantId, slot, (value) =>
      this.#members(this.records, tenantId, slot, value),
    );
    const decision = decide(groups, this.#today());
    return decision ? { groups, decision } : { groups };
  }

  /**
   * Where every current value of each slot stands today: the value decide() proposes holds,
   * a supersession makes another outdated, an open contradiction disputed, and anything else
   * (a plan, a value only reference documents state) differs. A slot with one value holds it.
   */
  async verdicts(tenantId: string, slots: readonly string[]): Promise<SlotVerdict[]> {
    const today = this.#today();
    const out: SlotVerdict[] = [];
    for (const slot of [...new Set(slots)].sort()) {
      const { groups: stored } = await storedGroups(this.records, tenantId, slot, (value) =>
        this.#members(this.records, tenantId, slot, value),
      );
      const groups = asOf(stored, today).filter((g) => g.count > 0);
      if (!groups.length) continue;
      const decision = decide(groups, today);
      const held = decision?.proposed ?? (groups[0] as ValueGroup);
      const cases = new Map((decision?.cases ?? []).map((c) => [c.value, c]));
      const standingOf = (c: CaseDraft | undefined): SlotStanding =>
        c?.classification === "supersession"
          ? "outdated"
          : c?.classification === "contradiction" && c.status === "open"
            ? "disputed"
            : "differs";
      const others = groups
        .filter((g) => g.value !== held.value)
        .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : 1));
      out.push({
        tenant_id: tenantId,
        slot_key: slot,
        held_value: held.value,
        disputed: [...cases.values()].some((c) => c.classification === "contradiction" && c.status === "open"),
        values: [
          { value: held.value, standing: "holds", claim_ids: [held.best.claim_id] },
          ...others.map((g): SlotValueStanding => {
            const c = cases.get(g.value);
            return {
              value: g.value,
              standing: standingOf(c),
              claim_ids: [g.best.claim_id],
              ...(c && { rationale: c.rationale }),
            };
          }),
        ],
        decided_on: today,
      });
    }
    return out;
  }

  /** A tenant's conflict cases, optionally only those with a status. */
  async conflicts(tenantId: string, status?: ConflictCase["status"]): Promise<ConflictCase[]> {
    return this.records.find(CONFLICTS, status ? { tenant_id: tenantId, status } : { tenant_id: tenantId });
  }

  #today(): string {
    return this.clock().toISOString().slice(0, 10);
  }

  async #apply(event: EventEnvelope): Promise<GovernanceResult> {
    const result: GovernanceResult = { slots: [], requests: [], notes: [], withdrawn: [] };
    if (event.producer === COMPONENT) return result;
    const update: ClaimsUpdated = payloadOf(event, "claims.updated");
    const reread = [...update.added, ...update.updated];
    const claims: Claim[] = [];
    for (let i = 0; i < reread.length; i += 500) claims.push(...(await this.store.getClaims(reread.slice(i, i + 500))));
    const versions = await this.#versionsOf(claims, update.source_version_id);
    const passages = await this.#passagesOf(claims, versions);
    const members = claims.flatMap((c) => memberOf(c, versions.get(c.id), passages.get(c.id)) ?? []);
    const closing = [...update.superseded, ...update.updated];

    await this.records.transaction(async (tx) => {
      if (!(await tx.firstDelivery(COMPONENT, event.id))) return;
      const keyOf = (m: Member) => groupKey(m.tenant_id, m.slot, m.value);
      const removed = closing.length ? await tx.getMany(MEMBERS, closing) : [];
      if (removed.length)
        await tx.delete(
          MEMBERS,
          removed.map((m) => m.claim_id),
        );
      const ids = members.map((m) => m.claim_id);
      const known = new Set((await tx.getMany(MEMBERS, ids)).map((m) => m.claim_id));
      const fresh = members.filter((m) => !known.has(m.claim_id));
      if (fresh.length) await tx.put(MEMBERS, fresh);

      // A group that lost a member is counted again, and so is one stored without its day
      // counts; one that only gained is extended.
      const lost = new Set(removed.map(keyOf));
      const slots = new Set([...removed, ...fresh].map((m) => m.slot));
      for (const key of new Set([...lost, ...fresh.map(keyOf)])) {
        const [, slot, value] = key.split("\x1f") as [string, string, string];
        let group = lost.has(key) ? undefined : await tx.get(VALUE_GROUPS, key);
        if (lost.has(key) || (group && !countedByDay(group))) {
          [group] = groupsOf(await this.#members(tx, event.tenant_id, slot, value, tx));
        } else {
          for (const m of fresh) if (m.slot === slot && m.value === value) group = withMember(group, m);
        }
        if (group) await tx.put(VALUE_GROUPS, [group]);
        else await tx.delete(VALUE_GROUPS, [key]);
      }

      for (const slot of [...slots].sort()) {
        const { request, notes, withdrawn } = await this.#decide(tx, event.tenant_id, slot, event);
        result.slots.push(slot);
        if (request) result.requests.push(request);
        result.notes.push(...notes);
        result.withdrawn.push(...withdrawn);
      }
    });
    this.totals.events++;
    this.#count(result);
    if (result.requests.length || result.notes.length || result.withdrawn.length) {
      log.debug("requested todos", {
        event: event.id,
        requests: result.requests.length,
        notes: result.notes.length,
        withdrawn: result.withdrawn.length,
      });
    }
    return result;
  }

  async #recheck(tenantId: string): Promise<GovernanceResult> {
    const result: GovernanceResult = { slots: [], requests: [], notes: [], withdrawn: [] };
    const today = this.#today();
    for (;;) {
      const due = (await this.records.find(RECHECKS, { tenant_id: tenantId }, { orderBy: "day", limit: 200 })).filter(
        (r) => r.day <= today,
      );
      if (!due.length) break;
      await this.records.transaction(async (tx) => {
        for (const r of due) {
          const { request, notes, withdrawn } = await this.#decide(tx, tenantId, r.slot);
          result.slots.push(r.slot);
          if (request) result.requests.push(request);
          result.notes.push(...notes);
          result.withdrawn.push(...withdrawn);
        }
      });
    }
    this.#count(result);
    if (result.slots.length) log.debug("rechecked slots", { tenant: tenantId, slots: result.slots.length });
    return result;
  }

  #count(result: GovernanceResult): void {
    this.totals.slots += result.slots.length;
    this.totals.requests += result.requests.length;
    this.totals.notes += result.notes.length;
    this.totals.withdrawn += result.withdrawn.length;
  }

  /**
   * What each claim with a slot is a copy of, as hashes of letters and digits, each when long
   * enough to be copied rather than written alike (MIN_COPY): its supporting spans, the blocks
   * they sit in, and its document's whole text. A short rule copied with its paragraph, or a
   * short document reposted whole, still shares a key with the original.
   */
  async #passagesOf(
    claims: readonly Claim[],
    versions: ReadonlyMap<string, SourceVersion>,
  ): Promise<Map<string, string[]>> {
    const ids = claims.filter((c) => slotOf(c) && valueKeyOf(c) !== undefined).map((c) => c.id);
    const evidence = ids.length ? (await this.store.evidenceOf(ids)).filter((e) => e.role === "supports") : [];
    const spans = new Map(
      (await this.store.getSpans([...new Set(evidence.map((e) => e.span_id))])).map((s) => [s.id, s]),
    );
    const letters = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    const key = (texts: Iterable<string>, ordered = false) => {
      const all = [...texts].map(letters);
      const parts = ordered ? all : [...new Set(all)].sort();
      return parts.join("").length >= MIN_COPY ? contentHash(parts.join("\x1f")) : undefined;
    };
    // Block IDs are stable across versions, so a claim's version has the blocks it cites, unless
    // the version no longer states it.
    const documents = new Map<string, { blocks: Map<string, string>; key?: string }>();
    for (const id of new Set(ids.flatMap((c) => versions.get(c)?.id ?? []))) {
      const blocks = (await this.store.blocksOf(id)).sort((a, b) => a.ordinal - b.ordinal);
      const whole = key(
        blocks.map((b) => b.text),
        true,
      );
      documents.set(id, { blocks: new Map(blocks.map((b) => [b.id, b.text])), ...(whole && { key: whole }) });
    }
    const cited = new Map<string, Span[]>();
    for (const e of evidence) {
      const span = spans.get(e.span_id);
      if (span) cited.set(e.claim_id, [...(cited.get(e.claim_id) ?? []), span]);
    }
    const out = new Map<string, string[]>();
    for (const [id, cites] of cited) {
      const document = documents.get(versions.get(id)?.id ?? "");
      const blocks = cites.flatMap((s) => document?.blocks.get(s.block_id ?? "") ?? []);
      const keys = [key(cites.map((s) => s.text)), key(blocks), document?.key];
      const found = [...new Set(keys.filter((k) => k !== undefined))];
      if (found.length) out.set(id, found);
    }
    return out;
  }

  /**
   * The members that state a value. Members stored before they kept their document and copy
   * keys would each count as a source of its own, and those stored before they kept their
   * document's date would lose to any dated copy, so they get both from their claims and
   * source versions, stored with them when a transaction is given.
   */
  async #members(
    reader: RecordReader,
    tenantId: string,
    slot: string,
    value: string,
    tx?: RecordTx,
  ): Promise<Member[]> {
    const members = await reader.find(MEMBERS, { tenant_id: tenantId, slot, value });
    const old = members.filter(
      (m) => (m.document_key === undefined || m.modified === undefined) && m.source_version_id,
    );
    if (!old.length) return members;
    const versions = new Map<string, SourceVersion>();
    for (const m of old) {
      const version = await this.store.getSourceVersion(m.source_version_id);
      if (version) versions.set(m.claim_id, version);
    }
    const unkeyed = old.filter((m) => m.document_key === undefined);
    const claims = unkeyed.length ? await this.store.getClaims(unkeyed.map((m) => m.claim_id)) : [];
    const passages = await this.#passagesOf(claims, versions);
    const filled = new Map<string, Member>();
    for (const m of old) {
      const version = versions.get(m.claim_id);
      if (!version) continue;
      filled.set(m.claim_id, {
        ...m,
        ...(m.document_key === undefined && sourceKeysOf(version, passages.get(m.claim_id) ?? [])),
        modified: m.modified ?? modifiedOf(version),
      });
    }
    if (tx && filled.size) await tx.put(MEMBERS, [...filled.values()]);
    return members.map((m) => filled.get(m.claim_id) ?? m);
  }

  /** The source version of every claim: the update's, else the version its evidence comes from. */
  async #versionsOf(claims: readonly Claim[], versionId: string | undefined): Promise<Map<string, SourceVersion>> {
    const out = new Map<string, SourceVersion>();
    const byId = new Map<string, SourceVersion | undefined>();
    const load = async (id: string) => {
      if (!byId.has(id)) byId.set(id, await this.store.getSourceVersion(id));
      return byId.get(id);
    };
    const rest = versionId ? [] : claims.map((c) => c.id);
    const evidence = rest.length ? await this.store.evidenceOf(rest) : [];
    const versionOf = new Map(evidence.map((e) => [e.claim_id, e.source_version_id]));
    for (const c of claims) {
      const id = versionId ?? versionOf.get(c.id);
      const version = id ? await load(id) : undefined;
      if (version) out.set(c.id, version);
    }
    return out;
  }

  /**
   * Decide a slot again, write its cases, and return a todo request when the decision
   * changed, a note for each value only reference documents state when what it says changed,
   * and a withdrawal for a request or a note whose reason went away.
   */
  async #decide(
    tx: RecordTx,
    tenantId: string,
    slot: string,
    cause?: EventEnvelope,
  ): Promise<{ request?: TodoRequested; notes: TodoRequested[]; withdrawn: TodoRequested[] }> {
    const today = this.#today();
    const { groups: stored, recounted } = await storedGroups(tx, tenantId, slot, (value) =>
      this.#members(tx, tenantId, slot, value, tx),
    );
    if (recounted.length) await tx.put(VALUE_GROUPS, recounted);
    const decision = decide(stored, today);
    const recheck = await tx.get(RECHECKS, slotKey(tenantId, slot));
    const next = decision ? nextChangeDay(stored, today) : undefined;
    // Cases, notes and todos name what each value rests on today.
    const groups = asOf(stored, today);
    if (next && next !== recheck?.day) await tx.put(RECHECKS, [{ tenant_id: tenantId, slot, day: next }]);
    else if (!next && recheck) await tx.delete(RECHECKS, [slotKey(tenantId, slot)]);
    const existing = new Map((await tx.find(CONFLICTS, { tenant_id: tenantId, slot })).map((c) => [c.id, c]));
    const now = this.clock().toISOString();
    const cases: ConflictCase[] = [];
    for (const draft of decision?.cases ?? []) {
      const proposed = decision?.proposed as ValueGroup;
      const other = groups.find((g) => g.value === draft.value) as ValueGroup;
      const id = stableId("conflict", tenantId, slot, draft.value);
      const next: ConflictCase = {
        id,
        tenant_id: tenantId,
        claim_ids: [proposed.best.claim_id, other.best.claim_id],
        classification: draft.classification,
        tier: "deterministic",
        status: draft.status,
        proposed_winner_id: proposed.best.claim_id,
        rationale: draft.rationale,
        confidence: draft.confidence,
        batch_key: slot,
        detected_at: existing.get(id)?.detected_at ?? now,
        producer: this.producer,
      };
      cases.push(next);
    }
    const kept = new Set(cases.map((c) => c.id));
    // A value nobody states any more, or the one now proposed, has no case left to decide.
    const settled = [...existing.values()]
      .filter((c) => !kept.has(c.id) && (c.status === "open" || c.status === "auto_resolved"))
      .map((c): ConflictCase => ({ ...c, status: "auto_resolved", rationale: "No longer in conflict." }));
    const changed = [...cases, ...settled].filter((c) => {
      const before = existing.get(c.id);
      return !before || JSON.stringify({ ...before, detected_at: "" }) !== JSON.stringify({ ...c, detected_at: "" });
    });
    if (changed.length) await tx.put(CONFLICTS, changed);
    const event = (request: TodoRequested) =>
      newEvent("todo.requested", request, {
        tenantId,
        producer: COMPONENT,
        subject: slot,
        ...(cause && { causation: cause }),
        occurredAt: this.clock(),
      });
    const state = await tx.get(SLOTS, slotKey(tenantId, slot));
    const withdrawn: TodoRequested[] = [];

    // A note is published again only when what it says changed (Note.said), not whenever
    // another document states the governed value.
    const owner = decision && ownerSpace(decision.proposed, groups);
    const notes = (decision?.cases ?? [])
      .filter((d) => d.note)
      .map((d) =>
        noteOf(
          decision?.proposed as ValueGroup,
          groups.find((g) => g.value === d.value) as ValueGroup,
          d,
          owner as string,
        ),
      );
    const last = new Map((state?.notes ?? []).map((n) => [n.request.dedupe_key, n]));
    const fresh = notes.filter((n) => last.get(n.request.dedupe_key)?.said !== n.said);
    const live = new Set(notes.map((n) => n.request.dedupe_key));
    withdrawn.push(
      ...[...last.values()].filter((n) => !live.has(n.request.dedupe_key)).map((n) => withdrawal(n.request)),
    );

    // Only a slot that governed documents state has an owner to ask, even when a reference
    // document's change holds it.
    const open = (decision?.cases ?? []).filter((c) => c.status === "open");
    const asks = decision !== undefined && open.length > 0 && groups.some((g) => governedIn(g) > 0);
    const fingerprint =
      decision && asks
        ? contentHash(
            JSON.stringify([decision.proposed.value, open.map((c) => [c.value, c.classification, c.priority])]),
          )
        : "";
    const request =
      decision && asks && (state?.requested ?? "") !== fingerprint
        ? todoOf(decision, open, new Map(groups.map((g) => [g.value, g])))
        : undefined;
    if (!asks && state?.asked) withdrawn.push(withdrawal(state.asked));

    const asked = request ?? (asks ? state?.asked : undefined);
    const published = notes.map((n) => (fresh.includes(n) ? n : (last.get(n.request.dedupe_key) as Note)));
    const updated: SlotState = {
      tenant_id: tenantId,
      slot,
      requested: fingerprint,
      ...(asked && { asked }),
      ...(published.length > 0 && { notes: published }),
    };
    if (canonicalJson(updated) !== canonicalJson(state ?? { tenant_id: tenantId, slot, requested: "" })) {
      await tx.put(SLOTS, [updated]);
    }
    const said = fresh.map((n) => n.request);
    const out = [...said, ...withdrawn, ...(request ? [request] : [])];
    if (out.length) await tx.publish(...out.map(event));
    return { ...(request && { request }), notes: said, withdrawn };
  }
}
