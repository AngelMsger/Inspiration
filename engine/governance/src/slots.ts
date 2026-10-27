/**
 * Fact slots and their values, and the deterministic tier of conflict detection: the pure
 * part of governance.
 *
 * A slot is a predicate with its qualifiers ("hotel_cap_per_night|tier-1 city"); every current
 * claim with a slot and a value is a member of the slot's group for that value. A group
 * keeps counts and representatives, so a slot with a thousand statements is still a
 * handful of rows: its most authoritative member, and the best member for each day on which
 * a statement says the value changed.
 *
 * Which value a slot should hold, from its groups:
 * - A group is in force when some member is neither archived nor a plan, and no such member
 *   only takes effect after today.
 * - A slot that governed documents state is decided among their values, and a group there is
 *   in force by its governed members' dates alone. A value only reference documents state,
 *   whether as a fact or a plan, is a note against it, settled without a person, and a change
 *   a reference document states moves nothing. The case names that change, so the owner
 *   learns of it. When every such document is older than the governed one that holds (an
 *   old copy of the policy kept on a drive), the value is simply out of date: no note.
 * - The leader is the in-force group whose best member in effect today is the most
 *   authoritative; between equally authoritative ones, the value more independent governed
 *   sources in effect today state, then the one from the newer document, then the one more
 *   governed statements state. Statements count as one source when they come from one
 *   document, from a document and its translations (DocumentMetadata.translation_of), or
 *   from copies of one passage: a document copied into several folders, a paragraph pasted
 *   into several handbooks. A statement that only takes effect later lends its group nothing
 *   before its day.
 * - A value only translations state, each of a document that states another value, is out of
 *   date: the original holds, and the case settles without a person (freshness asks for the
 *   translation to be brought up to date).
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
  /** The day its document was last changed, as its source reports it. */
  modified?: string;
  /** Its source version is archived or retired. */
  archived: boolean;
  /** Its source version is a reference document, not a governed one. */
  reference?: true;
  source_version_id: string;
  /** The document's title. */
  document: string;
  /** The document, as "<source>:<external ID>". Members stored before it was kept count alone. */
  document_key?: string;
  /**
   * What makes another document's statement a copy of this one: the text the document
   * translates ("t:<source>:<translation key>"), and the passage it states this in, when long
   * enough to be copied rather than written alike ("p:<hash>").
   */
  copy_keys?: string[];
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
  /**
   * The same members by the day they take effect; "" for those in effect from the start.
   * Groups stored before it was kept are counted again from their members (storedGroups).
   */
  governed_from?: Record<string, number>;
  archived: number;
  plans: number;
  /** Members from reference documents, live or not. */
  reference?: number;
  /** Source versions that state the value, in the order they were seen. */
  versions: string[];
  /** Live members first, then the highest authority and weight. */
  best: Member;
  /**
   * The best live member from each day on which a better one takes effect, oldest first, each
   * outranking the one before: the last one in effect by a day is the group's best that day.
   * Groups stored before it was kept are counted again from their members (storedGroups).
   */
  best_from?: Member[];
  /** The best live member for each day a change takes effect, oldest first; at most MAX_CHANGES. */
  changes: Member[];
  /**
   * Members by where they come from, for counting independent sources: keys are
   * sourceEntry(member), values how many members share it. Groups stored before it was kept
   * are counted again from their members (storedGroups).
   */
  sources?: Record<string, number>;
  /** The newest of its members' document dates (dateOf); "" when one of them has none. */
  newest?: string;
  /** The earliest day a live member takes effect; "" when one is in effect from the start. */
  earliest_live_from?: string;
  /** The same for live members from governed documents. */
  earliest_governed_from?: string;
}

export interface CaseDraft {
  /** The group the case is about; the proposed value is the other side. */
  value: string;
  classification: ConflictClass;
  status: ConflictStatus;
  priority: Priority;
  confidence: number;
  rationale: string;
  /** Only reference documents state the value, against a governed one: a note for the owner. */
  note?: true;
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

/** How a ranks against b, by everything but their IDs: positive when a ranks above b, 0 on a tie. */
function rank(a: Member, b: Member): number {
  if (isLive(a) !== isLive(b)) return isLive(a) ? 1 : -1;
  if (isGoverned(a) !== isGoverned(b)) return isGoverned(a) ? 1 : -1;
  if (a.authority !== b.authority) return a.authority > b.authority ? 1 : -1;
  if (a.weight !== b.weight) return a.weight > b.weight ? 1 : -1;
  return 0;
}

/** The day a member counts from, whether it counts for the tie-break, its document and its copy keys. */
type SourceEntry = [day: string, governed: 0 | 1, document: string, ...copies: string[]];

function sourceEntry(m: Member): string {
  const entry: SourceEntry = [
    m.live_from ?? "",
    isGoverned(m) ? 1 : 0,
    m.document_key ?? `claim:${m.claim_id}`,
    ...(m.copy_keys ?? []),
  ];
  return JSON.stringify(entry);
}

/**
 * The group's documents as independent sources: documents that share a copy key, directly or
 * through others, are one source. Given today, only governed live members in effect by then.
 */
export function sourcesOf(g: ValueGroup, today?: string): string[][] {
  const parent = new Map<string, string>();
  const root = (k: string): string => {
    const up = parent.get(k) ?? k;
    if (up === k) return k;
    const top = root(up);
    parent.set(k, top);
    return top;
  };
  const join = (a: string, b: string) => {
    const [x, y] = [root(a), root(b)];
    if (x !== y) parent.set(x < y ? y : x, x < y ? x : y);
  };
  const documents = new Set<string>();
  for (const [key, n] of Object.entries(g.sources ?? {})) {
    const [day, governed, document, ...copies] = JSON.parse(key) as SourceEntry;
    if (n <= 0 || (today !== undefined && (!governed || day > today))) continue;
    documents.add(document);
    for (const c of copies) join(`d:${document}`, `c:${c}`);
  }
  const by = new Map<string, string[]>();
  for (const d of [...documents].sort()) {
    const r = root(`d:${d}`);
    by.set(r, [...(by.get(r) ?? []), d]);
  }
  return [...by.values()];
}

/** Independent governed sources in effect by today that state the group's value. */
export const independentAsOf = (g: ValueGroup, today: string) => sourcesOf(g, today).length;

/**
 * The group's governed documents in effect by today, each with the document it translates
 * ("<source>:<external ID>"), or undefined for one that translates none.
 */
function originalsOf(g: ValueGroup, today: string): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  for (const [key, n] of Object.entries(g.sources ?? {})) {
    const [day, governed, document, ...copies] = JSON.parse(key) as SourceEntry;
    if (n <= 0 || !governed || day > today) continue;
    const text = copies.find((c) => c.startsWith("t:"))?.slice(2);
    out.set(document, text !== undefined && text !== document ? text : undefined);
  }
  return out;
}

/**
 * True when only translations state a's value, each of a document that states b's. The
 * original holds: a translation that says otherwise has fallen behind it, or misreads it.
 */
export function translates(a: ValueGroup, b: ValueGroup, today: string): boolean {
  const ours = originalsOf(a, today);
  if (!ours.size) return false;
  const theirs = originalsOf(b, today);
  return [...ours.values()].every((original) => original !== undefined && theirs.has(original));
}

/** True when a ranks above b as the representative of a group. */
function outranks(a: Member, b: Member): boolean {
  const r = rank(a, b);
  return r ? r > 0 : a.claim_id < b.claim_id;
}

/**
 * True when group a leads b: its best member outranks b's, or the two tie and only
 * translations of documents stating a's value state b's (translates), or more independent
 * governed sources in effect today state a's value, then the newer document does (newer),
 * then more governed statements. Without these a tie would fall to the claim
 * IDs, and a side remark in a policy ("objections within 5 working days") could outrank the
 * article several policies state. Copies count once, or a notice reposted in three folders
 * would outvote two handbooks that say otherwise in their own words, and three handbooks
 * that paste a paragraph of 2025 the travel policy of 2026. Reference documents and
 * statements that take effect later are not counted: a FAQ, or next year's policy, would
 * decide today's value.
 */
function leads(a: ValueGroup, b: ValueGroup, today: string): boolean {
  const r = rank(a.best, b.best);
  if (r) return r > 0;
  if (translates(b, a, today) || translates(a, b, today)) return translates(b, a, today);
  const [s, t] = [independentAsOf(a, today), independentAsOf(b, today)];
  if (s !== t) return s > t;
  if (newer(a, b, today) || newer(b, a, today)) return newer(a, b, today);
  const [x, y] = [governedAsOf(a, today), governedAsOf(b, today)];
  if (x !== y) return x > y;
  return a.best.claim_id < b.best.claim_id;
}

/**
 * True when a and b are as authoritative and as well supported, and a's best statement is
 * from a document that took effect later: the newer policy replaces the older one. Without
 * an effective date on both, the document changed later is the newer: a copy of last year's
 * policy saved on a drive against the policy as it is now.
 */
function newer(a: ValueGroup, b: ValueGroup, today: string): boolean {
  if (rank(a.best, b.best) || independentAsOf(a, today) !== independentAsOf(b, today)) return false;
  const [x, y] = [a.best, b.best];
  if (x.document_from && y.document_from) return x.document_from > y.document_from;
  return dateOf(x) > dateOf(y);
}

/** A document's own date: the day it takes effect, else the day it was last changed. */
function dateOf(m: Member): string {
  return m.document_from ?? m.modified ?? "";
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
        governed_from: {},
        archived: 0,
        plans: 0,
        versions: [],
        best: m,
        best_from: [],
        changes: [],
        sources: {},
      };
  g.count++;
  const dated = dateOf(m);
  g.newest = g.count === 1 ? dated : g.newest && dated && (dated > g.newest ? dated : g.newest);
  const entry = sourceEntry(m);
  g.sources = { ...g.sources, [entry]: (g.sources?.[entry] ?? 0) + 1 };
  if (m.reference) g.reference = (g.reference ?? 0) + 1;
  if (m.archived) g.archived++;
  if (m.claim_type === "plan") g.plans++;
  if (!g.versions.includes(m.source_version_id)) g.versions.push(m.source_version_id);
  if (group === undefined || outranks(m, g.best)) g.best = m;
  if (isLive(m)) {
    g.live++;
    const from = m.live_from ?? "";
    g.best_from = withBest(g.best_from ?? [], m);
    if (g.earliest_live_from === undefined || from < g.earliest_live_from) g.earliest_live_from = from;
    if (isGoverned(m)) {
      g.governed++;
      g.governed_from = { ...g.governed_from, [from]: (g.governed_from?.[from] ?? 0) + 1 };
      if (g.earliest_governed_from === undefined || from < g.earliest_governed_from) g.earliest_governed_from = from;
    }
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

const dayOf = (m: Member) => m.live_from ?? "";

/** The best-from list with one more live member: it holds from its day until a better one does. */
function withBest(list: readonly Member[], m: Member): Member[] {
  const day = dayOf(m);
  const before = list.filter((b) => dayOf(b) <= day);
  const previous = before.at(-1);
  if (previous && !outranks(m, previous)) return [...list];
  return [...before.filter((b) => dayOf(b) < day), m, ...list.filter((b) => dayOf(b) > day && outranks(b, m))];
}

/** The group's best live member in effect by today. */
export function bestAsOf(g: ValueGroup, today: string): Member | undefined {
  return g.best_from?.filter((b) => dayOf(b) <= today).at(-1);
}

/**
 * The groups as they stand today: each one's best is its best live member in effect by today,
 * or its best overall while none is. decide() compares groups this way, and what it proposes
 * and says about each value names these members.
 */
export function asOf(groups: readonly ValueGroup[], today: string): ValueGroup[] {
  return groups.map((g) => {
    const best = bestAsOf(g, today);
    return best && best.claim_id !== g.best.claim_id ? { ...g, best } : g;
  });
}

/** The group's latest change in effect by today; given governed, only one a governed document states. */
export function changeAsOf(g: ValueGroup, today: string, governed = false): Member | undefined {
  return g.changes.filter((c) => (c.stated_from as string) <= today && (!governed || !c.reference)).at(-1);
}

/**
 * The first day after today on which a group comes into force, a change it holds takes
 * effect, one of its governed statements does and counts for it, or a better statement
 * becomes its best.
 */
export function nextChangeDay(groups: readonly ValueGroup[], today: string): string | undefined {
  let next: string | undefined;
  for (const g of groups) {
    const starts = [
      g.earliest_live_from ?? "",
      g.earliest_governed_from ?? "",
      ...Object.keys(g.governed_from ?? {}),
      ...(g.best_from ?? []).map(dayOf),
    ];
    for (const day of [...starts, ...g.changes.map((c) => c.stated_from as string)]) {
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

/** Live members from governed documents. */
export const governedIn = (g: ValueGroup) => g.governed;

/** Live members from governed documents that are in effect by today. */
export function governedAsOf(g: ValueGroup, today: string): number {
  let n = 0;
  for (const [day, count] of Object.entries(g.governed_from ?? {})) if (day <= today) n += count;
  return n;
}

/** The first day the group's value holds; in a governed slot, by its governed members alone. */
const startOf = (g: ValueGroup, governed: boolean) => (governed ? g.earliest_governed_from : g.earliest_live_from);

const inForce = (g: ValueGroup, today: string, governed: boolean) => {
  const start = startOf(g, governed);
  return (governed ? governedIn(g) : g.live) > 0 && start !== undefined && start <= today;
};

/** Every member is from a reference document. Groups counted before levels had none. */
const referenceOnly = (g: ValueGroup) => (g.reference ?? 0) === g.count;

/** The day from which the group's value is known to hold: its document's date or its own change. */
function since(g: ValueGroup, today: string, governed: boolean): string {
  const changed = changeAsOf(g, today, governed)?.stated_from ?? "";
  const documented = g.best.document_from ?? "";
  return changed > documented ? changed : documented;
}

/** A change to the group's value that only a reference document states, after the proposed value's own date. */
function referenceChange(g: ValueGroup, proposed: ValueGroup, today: string): string | undefined {
  const change = changeAsOf(g, today);
  if (!change?.reference || (change.stated_from as string) <= since(proposed, today, true)) return undefined;
  return `${change.document}, a reference document, says ${g.value} from ${change.stated_from}`;
}

function documents(g: ValueGroup): string {
  return g.versions.length === 1 ? "1 document" : `${g.versions.length} documents`;
}

/**
 * The value a slot should hold and the case against every other value, comparing the groups
 * as they stand today (asOf); undefined below two values.
 */
export function decide(stored: readonly ValueGroup[], today: string): SlotDecision | undefined {
  if (stored.length < 2) return undefined;
  const groups = asOf(stored, today);
  const governedSlot = groups.some((g) => governedIn(g) > 0);
  const current = groups.filter((g) => inForce(g, today, governedSlot));
  const pool = current.length ? current : groups;
  const leader = pool.reduce((a, b) => (leads(b, a, today) ? b : a));
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
      const said = governedSlot ? referenceChange(g, proposed, today) : undefined;
      if (governedSlot && referenceOnly(g) && g.live === 0) {
        return {
          ...base,
          classification: "plan_vs_fact",
          status: "auto_resolved",
          priority: "low",
          confidence: 0.6,
          note: true,
          rationale: `Only reference documents plan ${g.value}; the governed ${proposed.value} holds. A note for the owner, not a todo.`,
        };
      }
      if (governedSlot && governedIn(g) === 0 && g.live > 0) {
        const held = dateOf(proposed.best);
        if (!said && g.newest && held && g.newest < held) {
          return {
            ...base,
            classification: "supersession",
            status: "auto_resolved",
            priority: "low",
            confidence: 0.8,
            rationale: `Only reference documents state ${g.value}, the newest from ${g.newest}; the governed ${proposed.value} from ${held} holds, and an older document that says otherwise is out of date.`,
          };
        }
        return {
          ...base,
          classification: "contradiction",
          status: "auto_resolved",
          priority: "low",
          confidence: 0.6,
          note: true,
          rationale: said
            ? `${said}; the governed ${proposed.value} holds until a governed document says so. A note for the owner, not a todo.`
            : `Only reference documents state ${g.value}; the governed ${proposed.value} holds. A note for the owner, not a todo.`,
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
      if (!inForce(g, today, governedSlot)) {
        return {
          ...base,
          classification: "plan_vs_fact",
          status: "open",
          priority: "low",
          confidence: 0.7,
          rationale: `${g.value} takes effect on ${startOf(g, governedSlot)}.`,
        };
      }
      if (translates(g, proposed, today)) {
        return {
          ...base,
          classification: "supersession",
          status: "auto_resolved",
          priority: "low",
          confidence: 0.9,
          rationale: `Only translations (${documents(g)}) state ${g.value}, of documents that state ${proposed.value}: the original holds, and a translation that says otherwise is out of date.`,
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
      if (!changed && newer(proposed, g, today)) {
        return {
          ...base,
          classification: "supersession",
          status: "open",
          priority: "normal",
          confidence: 0.7,
          rationale: `${g.value} (${documents(g)}, the most authoritative ${g.best.document}, from ${dateOf(g.best) || "an earlier date"}) is older than ${proposed.value} in ${proposed.best.document}, from ${dateOf(proposed.best)}, which is as authoritative and has as many independent sources.`,
        };
      }
      const governed = g.best.authority >= GOVERNED && proposed.best.authority >= GOVERNED;
      return {
        ...base,
        classification: "contradiction",
        status: "open",
        priority: governed ? "high" : "normal",
        confidence: 0.6,
        rationale: `${proposed.value} comes from the more authoritative ${proposed.best.document} (${proposed.best.authority}); ${g.value} from ${g.best.document} (${g.best.authority}).${said ? ` ${said}.` : ""}`,
      };
    });
  return changed
    ? { proposed, basis: "changed", change: changed.change, cases }
    : { proposed, basis: "authority", cases };
}
