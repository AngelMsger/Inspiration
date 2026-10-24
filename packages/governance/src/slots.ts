/**
 * Fact slots and their values, and the deterministic tier of conflict detection: the pure
 * part of governance.
 *
 * A slot is a predicate with its qualifiers ("hotel_cap_per_night|一线城市"); every current
 * claim with a slot and a value is a member of the slot's group for that value. A group
 * keeps counts and representatives, so a slot with a thousand statements is still a
 * handful of rows: its most authoritative member, and the best member for each day on which
 * a statement says the value changed.
 *
 * Which value a slot should hold, from its groups:
 * - A group is in force when some member is neither archived nor a plan, and no such member
 *   only takes effect after today.
 * - A slot that governed documents state is decided among their values: a value only
 *   reference documents state is a note against it, settled without a person, and a change
 *   a reference document states moves nothing.
 * - The leader is the in-force group whose best member is the most authoritative.
 * - A change beats the leader when it took effect after the leader's own date, the later of
 *   its document's effective date and any change it states, and no later than today: a
 *   notice that the cap is 650 from October outranks the policy that says 600 from January
 *   until the policy is revised.
 * Every other group becomes a case against the proposed value: superseded (only archived
 * documents state it, or it predates the change), plan versus fact (only plans state it, or
 * it takes effect later), or a contradiction.
 */

import type { ConflictClass, ConflictStatus, Priority } from "@inspiration/contracts";

/** A current claim in a slot. */
export interface Member {
  claim_id: string;
  tenant_id: string;
  space_id: string;
  slot: string;
  /** The claim's normalized value. */
  value: string;
  statement: string;
  claim_type: string;
  authority: number;
  weight: number;
  /**
   * The day from which it can count as the slot's current value: when the claim takes effect,
   * by its own words or by its document's date. Absent when it holds from the start.
   */
  live_from?: string;
  /** The day the statement says it takes effect, when that is not just its document's date. */
  stated_from?: string;
  /** The effective date of its document (front matter effective_from). */
  document_from?: string;
  /** Its source version is archived or retired. */
  archived: boolean;
  /** Its source version is a reference document, not a governed one. */
  reference?: true;
  source_version_id: string;
  /** The document's title. */
  document: string;
}

/** The members of one slot that state one value, as counts and representatives. */
export interface ValueGroup {
  tenant_id: string;
  slot: string;
  value: string;
  count: number;
  /** Members that are neither archived nor plans. */
  live: number;
  /** Live members from governed documents. */
  governed: number;
  archived: number;
  plans: number;
  /** Source versions that state the value, in the order they were seen. */
  versions: string[];
  /** Live members first, then the highest authority and weight. */
  best: Member;
  /** The best live member for each day a change takes effect, oldest first; at most MAX_CHANGES. */
  changes: Member[];
  /** The earliest day a live member takes effect; "" when one is in effect from the start. */
  earliest_live_from?: string;
}

export interface CaseDraft {
  /** The group the case is about; the proposed value is the other side. */
  value: string;
  classification: ConflictClass;
  status: ConflictStatus;
  priority: Priority;
  confidence: number;
  rationale: string;
}

export interface SlotDecision {
  proposed: ValueGroup;
  /** Why the proposed value holds: "changed" by a dated statement, or the "authority" of its source. */
  basis: "changed" | "authority";
  /** The change that made it hold, for basis "changed". */
  change?: Member;
  cases: CaseDraft[];
}

/** Authority from which a source counts as governed (approved policies are 0.9). */
export const GOVERNED = 0.8;

/** Change days a group remembers; older ones matter only if every newer one is still ahead. */
export const MAX_CHANGES = 32;

const isLive = (m: Member) => !m.archived && m.claim_type !== "plan";
const isGoverned = (m: Member) => isLive(m) && !m.reference;

/** True when a ranks above b as the representative of a group. */
function outranks(a: Member, b: Member): boolean {
  if (isLive(a) !== isLive(b)) return isLive(a);
  if (isGoverned(a) !== isGoverned(b)) return isGoverned(a);
  if (a.authority !== b.authority) return a.authority > b.authority;
  if (a.weight !== b.weight) return a.weight > b.weight;
  return a.claim_id < b.claim_id;
}

/** The group with one more member. */
export function withMember(group: ValueGroup | undefined, m: Member): ValueGroup {
  const g: ValueGroup = group
    ? { ...group, versions: [...group.versions] }
    : {
        tenant_id: m.tenant_id,
        slot: m.slot,
        value: m.value,
        count: 0,
        live: 0,
        governed: 0,
        archived: 0,
        plans: 0,
        versions: [],
        best: m,
        changes: [],
      };
  g.count++;
  if (m.archived) g.archived++;
  if (m.claim_type === "plan") g.plans++;
  if (!g.versions.includes(m.source_version_id)) g.versions.push(m.source_version_id);
  if (group === undefined || outranks(m, g.best)) g.best = m;
  if (isLive(m)) {
    g.live++;
    if (isGoverned(m)) g.governed = (g.governed ?? 0) + 1;
    const from = m.live_from ?? "";
    if (g.earliest_live_from === undefined || from < g.earliest_live_from) g.earliest_live_from = from;
    if (m.stated_from) {
      const day = m.stated_from;
      const same = g.changes.findIndex((c) => c.stated_from === day);
      if (same < 0) {
        g.changes = [...g.changes, m].sort((a, b) => ((a.stated_from ?? "") < (b.stated_from ?? "") ? -1 : 1));
        if (g.changes.length > MAX_CHANGES) g.changes = g.changes.slice(-MAX_CHANGES);
      } else if (outranks(m, g.changes[same] as Member)) {
        g.changes = g.changes.map((c, i) => (i === same ? m : c));
      }
    }
  }
  return g;
}

/** The group's latest change in effect by today; given governed, only one a governed document states. */
export function changeAsOf(g: ValueGroup, today: string, governed = false): Member | undefined {
  return g.changes.filter((c) => (c.stated_from as string) <= today && (!governed || !c.reference)).at(-1);
}

/** The first day after today on which a group comes into force or a change it holds takes effect. */
export function nextChangeDay(groups: readonly ValueGroup[], today: string): string | undefined {
  let next: string | undefined;
  for (const g of groups) {
    for (const day of [g.earliest_live_from ?? "", ...g.changes.map((c) => c.stated_from as string)]) {
      if (day > today && (next === undefined || day < next)) next = day;
    }
  }
  return next;
}

/** The groups of a slot, built from its members. */
export function groupsOf(members: readonly Member[]): ValueGroup[] {
  const groups = new Map<string, ValueGroup>();
  for (const m of members) groups.set(m.value, withMember(groups.get(m.value), m));
  return [...groups.values()];
}

/** Live members from governed documents. Groups counted before levels have no count: all were governed. */
export const governedIn = (g: ValueGroup) => g.governed ?? g.live;

const inForce = (g: ValueGroup, today: string) =>
  g.live > 0 && g.earliest_live_from !== undefined && g.earliest_live_from <= today;

/** The day from which the group's value is known to hold: its document's date or its own change. */
function since(g: ValueGroup, today: string, governed: boolean): string {
  const changed = changeAsOf(g, today, governed)?.stated_from ?? "";
  const documented = g.best.document_from ?? "";
  return changed > documented ? changed : documented;
}

function documents(g: ValueGroup): string {
  return g.versions.length === 1 ? "1 document" : `${g.versions.length} documents`;
}

/** The value a slot should hold and the case against every other value; undefined below two values. */
export function decide(groups: readonly ValueGroup[], today: string): SlotDecision | undefined {
  if (groups.length < 2) return undefined;
  const governedSlot = groups.some((g) => governedIn(g) > 0);
  const current = groups.filter((g) => inForce(g, today) && (!governedSlot || governedIn(g) > 0));
  const pool = current.length ? current : groups;
  const leader = pool.reduce((a, b) => (outranks(b.best, a.best) ? b : a));
  const baseline = since(leader, today, governedSlot);
  // The latest change in effect after the leader's own date; on a tie, the better source.
  let changed: { group: ValueGroup; change: Member } | undefined;
  for (const group of current) {
    const change = changeAsOf(group, today, governedSlot);
    if (group === leader || !change || (change.stated_from as string) <= baseline) continue;
    const day = change.stated_from as string;
    const best = changed?.change.stated_from as string | undefined;
    if (!changed || day > (best as string) || (day === best && outranks(change, changed.change))) {
      changed = { group, change };
    }
  }
  const proposed = changed?.group ?? leader;
  const day = changed?.change.stated_from;

  const cases = groups
    .filter((g) => g !== proposed)
    .map((g): CaseDraft => {
      const base = { value: g.value };
      if (g.live === 0 && g.archived === g.count) {
        return {
          ...base,
          classification: "supersession",
          status: "auto_resolved",
          priority: "low",
          confidence: 0.9,
          rationale: `Only archived documents state ${g.value}.`,
        };
      }
      if (governedSlot && governedIn(g) === 0 && g.live > 0) {
        return {
          ...base,
          classification: "contradiction",
          status: "auto_resolved",
          priority: "low",
          confidence: 0.6,
          rationale: `Only reference documents state ${g.value}; the governed ${proposed.value} holds. A note for the owner, not a todo.`,
        };
      }
      if (g.live === 0) {
        return {
          ...base,
          classification: "plan_vs_fact",
          status: "open",
          priority: "low",
          confidence: 0.6,
          rationale: `Only plans state ${g.value}.`,
        };
      }
      if (!inForce(g, today)) {
        return {
          ...base,
          classification: "plan_vs_fact",
          status: "open",
          priority: "low",
          confidence: 0.7,
          rationale: `${g.value} takes effect on ${g.earliest_live_from}.`,
        };
      }
      if (changed && day && since(g, today, governedSlot) < day) {
        const stale = g === leader;
        return {
          ...base,
          classification: "supersession",
          status: "open",
          priority: stale && g.best.authority >= GOVERNED ? "high" : "normal",
          confidence: 0.8,
          rationale: `${g.value} (${documents(g)}, the most authoritative ${g.best.document}) predates the change to ${proposed.value} on ${day} in ${changed.change.document}.`,
        };
      }
      const governed = g.best.authority >= GOVERNED && proposed.best.authority >= GOVERNED;
      return {
        ...base,
        classification: "contradiction",
        status: "open",
        priority: governed ? "high" : "normal",
        confidence: 0.6,
        rationale: `${proposed.value} comes from the more authoritative ${proposed.best.document} (${proposed.best.authority}); ${g.value} from ${g.best.document} (${g.best.authority}).`,
      };
    });
  return changed
    ? { proposed, basis: "changed", change: changed.change, cases }
    : { proposed, basis: "authority", cases };
}
