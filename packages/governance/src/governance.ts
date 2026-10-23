import {
  type Claim,
  type ClaimsUpdated,
  type ConflictCase,
  contentHash,
  type EventEnvelope,
  type EventHandler,
  type KnowledgeStore,
  newEvent,
  type Priority,
  type ProducerInfo,
  payloadOf,
  type SourceVersion,
  slotOf,
  stableId,
  type TodoRequested,
  valueKeyOf,
} from "@inspiration/contracts";
import { defineTable, type Records, type RecordTx } from "@inspiration/eventbus";
import { logger } from "@inspiration/kernel";
import {
  type CaseDraft,
  decide,
  groupsOf,
  type Member,
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

/** What governance last asked a person to decide for a slot. */
export interface SlotState {
  tenant_id: string;
  slot: string;
  /** A hash of the decision in the last todo request; "" after the conflict went away. */
  requested: string;
}

export const SLOTS = defineTable<SlotState>("governance.slots", {
  key: (s) => slotKey(s.tenant_id, s.slot),
  columns: { tenant_id: (s) => s.tenant_id },
});

function groupKey(tenantId: string, slot: string, value: string): string {
  return `${tenantId}\x1f${slot}\x1f${value}`;
}

function slotKey(tenantId: string, slot: string): string {
  return `${tenantId}\x1f${slot}`;
}

const PRIORITY: readonly Priority[] = ["low", "normal", "high", "urgent"];
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
}

/** The slot of a current claim with a value, as the member governance keeps for it. */
function memberOf(claim: Claim, version: SourceVersion | undefined): Member | undefined {
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
    source_version_id: version?.id ?? "",
    document: version?.title ?? version?.external_id ?? "",
  };
  // A start equal to the document's effective date is the document's, not a change it states.
  if (start && start !== documentFrom) member.stated_from = start;
  if (documentFrom) member.document_from = documentFrom;
  return member;
}

/** "hotel_cap_per_night (一线城市)" */
function slotLabel(slot: string): string {
  const [predicate, ...qualifiers] = slot.split("|");
  return qualifiers.length ? `${predicate} (${qualifiers.join(", ")})` : (predicate as string);
}

function statements(g: ValueGroup): string {
  const n = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;
  return `${n(g.count, "statement")} in ${n(g.versions.length, "document")}, the most authoritative ${g.best.document}`;
}

/** The todo request for a slot's open cases. */
function todoOf(decision: SlotDecision, open: readonly CaseDraft[], groups: Map<string, ValueGroup>): TodoRequested {
  const { proposed } = decision;
  const contenders = open.map((c) => groups.get(c.value) as ValueGroup);
  const why = decision.change
    ? `changed on ${decision.change.stated_from} in ${decision.change.document}`
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
    space_id: proposed.best.space_id,
    title: `${slotLabel(proposed.slot)}: ${[proposed, ...contenders].map((g) => g.value).join(" or ")}`,
    detail,
    priority,
    unit_ids: [proposed.best.claim_id, ...contenders.map((g) => g.best.claim_id)],
    dedupe_key: `${COMPONENT}:conflict:${proposed.slot}`,
    batch_key: `${COMPONENT}:conflict:${predicate}`,
  };
}

/**
 * Governance: keeps every current claim with a slot and a value in its slot's value groups,
 * decides which value each slot should hold, records a conflict case against every other
 * value, and asks for one todo per slot whose decision needs a person. See the package doc
 * comment for the rules.
 */
export class Governance {
  readonly store: KnowledgeStore;
  readonly records: Records;
  readonly clock: () => Date;
  readonly totals = { events: 0, slots: 0, requests: 0 };
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
    const before = this.#running.get(event.tenant_id) ?? Promise.resolve();
    const run = before.catch(() => undefined).then(() => this.#apply(event));
    this.#running.set(event.tenant_id, run);
    try {
      return await run;
    } finally {
      if (this.#running.get(event.tenant_id) === run) this.#running.delete(event.tenant_id);
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
    const groups = await this.records.find(VALUE_GROUPS, { tenant_id: tenantId, slot });
    const decision = decide(groups, this.#today());
    return decision ? { groups, decision } : { groups };
  }

  /** A tenant's conflict cases, optionally only those with a status. */
  async conflicts(tenantId: string, status?: ConflictCase["status"]): Promise<ConflictCase[]> {
    return this.records.find(CONFLICTS, status ? { tenant_id: tenantId, status } : { tenant_id: tenantId });
  }

  #today(): string {
    return this.clock().toISOString().slice(0, 10);
  }

  async #apply(event: EventEnvelope): Promise<GovernanceResult> {
    const result: GovernanceResult = { slots: [], requests: [] };
    if (event.producer === COMPONENT) return result;
    const update: ClaimsUpdated = payloadOf(event, "claims.updated");
    const reread = [...update.added, ...update.updated];
    const claims: Claim[] = [];
    for (let i = 0; i < reread.length; i += 500) claims.push(...(await this.store.getClaims(reread.slice(i, i + 500))));
    const versions = await this.#versionsOf(claims, update.source_version_id);
    const members = claims.flatMap((c) => memberOf(c, versions.get(c.id)) ?? []);
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

      // A group that lost a member is counted again; one that only gained is extended.
      const lost = new Set(removed.map(keyOf));
      const slots = new Set([...removed, ...fresh].map((m) => m.slot));
      for (const key of new Set([...lost, ...fresh.map(keyOf)])) {
        const [, slot, value] = key.split("\x1f") as [string, string, string];
        let group: ValueGroup | undefined;
        if (lost.has(key)) {
          [group] = groupsOf(await tx.find(MEMBERS, { tenant_id: event.tenant_id, slot, value }));
        } else {
          group = await tx.get(VALUE_GROUPS, key);
          for (const m of fresh) if (m.slot === slot && m.value === value) group = withMember(group, m);
        }
        if (group) await tx.put(VALUE_GROUPS, [group]);
        else await tx.delete(VALUE_GROUPS, [key]);
      }

      for (const slot of [...slots].sort()) {
        const request = await this.#decide(tx, event, slot);
        result.slots.push(slot);
        if (request) result.requests.push(request);
      }
    });
    this.totals.events++;
    this.totals.slots += result.slots.length;
    this.totals.requests += result.requests.length;
    if (result.requests.length) log.debug("requested todos", { event: event.id, requests: result.requests.length });
    return result;
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

  /** Decide a slot again, write its cases, and return a todo request when the decision changed. */
  async #decide(tx: RecordTx, event: EventEnvelope, slot: string): Promise<TodoRequested | undefined> {
    const tenantId = event.tenant_id;
    const groups = await tx.find(VALUE_GROUPS, { tenant_id: tenantId, slot });
    const decision = decide(groups, this.#today());
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

    const open = (decision?.cases ?? []).filter((c) => c.status === "open");
    const state = await tx.get(SLOTS, slotKey(tenantId, slot));
    const fingerprint =
      decision && open.length
        ? contentHash(
            JSON.stringify([decision.proposed.value, open.map((c) => [c.value, c.classification, c.priority])]),
          )
        : "";
    if ((state?.requested ?? "") === fingerprint) return undefined;
    await tx.put(SLOTS, [{ tenant_id: tenantId, slot, requested: fingerprint }]);
    if (!decision || !open.length) return undefined;
    const request = todoOf(decision, open, new Map(groups.map((g) => [g.value, g])));
    await tx.publish(
      newEvent("todo.requested", request, {
        tenantId,
        producer: COMPONENT,
        subject: slot,
        causation: event,
        occurredAt: this.clock(),
      }),
    );
    return request;
  }
}
