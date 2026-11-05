// Decide for me: the assistant decides a member's todos in their name and with their rights,
// from what the component that asked for each one advised, and leaves the rest to the member
// with why (docs/design/decide-for-me.md). No model takes part: the rules below decide, and
// the reasons come from the language packs, in the reader's language.

import {
  type Decided,
  type DecidedWeek,
  type DecideTodos,
  type DecisionVia,
  type Delegation,
  type EventHandler,
  type LeftTodo,
  newEvent,
  newId,
  type Principal,
  payloadOf,
  type Todo,
  type TodoAdvice,
  type TodoDecision,
  type TodoKind,
  type TodoLeft,
  type TodoSuggestion,
} from "@inspiration/contracts";
import { defineTable, type RecordTx } from "@inspiration/eventbus";
import { type LanguagePack, loadLanguages } from "@inspiration/kernel";
import { COMPONENT, type Inbox, ITEMS, type Item, OPEN, todoOrder } from "./inbox.ts";
import { isoWeek } from "./weeks.ts";

/** The kinds a standing delegation decides, by the MVP's decision: routine reviews, conflicts and notes. */
export const DELEGATED_KINDS: readonly TodoKind[] = ["review_due", "stale", "conflict", "note"];

/** The most todos one request may name: a card's worth. */
export const MAX_ASKED = 20;

/** Undoing this many of a member's last UNDO_WINDOW decisions of one kind pauses their delegation. */
const UNDO_LIMIT = 2;
const UNDO_WINDOW = 10;

/** What a decision rests on, which its reason says: a requester's basis, or the kind's rule. */
export type DecisionBasis = TodoAdvice["basis"] | "note" | "unchanged" | "copy";

/** Why the assistant left a todo to its member. */
export type LeftWhy = "unsure" | "person_decided" | "never" | "no_advice" | "with_conflict" | "undone";

/** A decision as collaboration keeps it. Its reason is written when it is read, in the reader's language. */
export interface DecisionRecord {
  id: string;
  tenant_id: string;
  /** The todo as the decision closed it. */
  todo: Todo;
  with: string;
  basis: DecisionBasis;
  via: DecisionVia;
  decided_by: string;
  decided_at: string;
  /** decided_at's ISO week, by which the Decided for you view reads. */
  week: string;
  undone_at?: string;
}

export const DECISIONS = defineTable<DecisionRecord>("collaboration.decisions", {
  key: (d) => d.id,
  columns: {
    tenant_id: (d) => d.tenant_id,
    member: (d) => d.decided_by,
    todo: (d) => d.todo.id,
    week: (d) => d.week,
  },
});

export interface DelegationRecord {
  tenant_id: string;
  member_id: string;
  delegation: Delegation;
}

export const DELEGATIONS = defineTable<DelegationRecord>("collaboration.delegations", {
  key: (d) => `${d.tenant_id}/${d.member_id}`,
  columns: { tenant_id: (d) => d.tenant_id },
});

const PACKS = new Map(loadLanguages(new URL("../languages/", import.meta.url)).map((p) => [p.tag, p]));

/** The pack of a locale ("zh-CN" reads zh), else English. */
function packOf(locale: string | undefined): LanguagePack {
  return PACKS.get((locale ?? "").split("-")[0] ?? "") ?? (PACKS.get("en") as LanguagePack);
}

/** What the assistant makes of one todo. */
type Verdict = { decide: { with: string; basis: DecisionBasis } } | { leave: LeftWhy; suggest?: TodoAdvice };

/**
 * The rules, in the order a careful person would follow them: never a kind it does not decide;
 * notes are acknowledged and routine reviews confirmed; a copy review waits for the conflict it
 * rides on; a conflict takes the requester's advice when it is sure and no person chose
 * otherwise on the same question.
 */
function judge(item: Item, chosenByPeople: ReadonlySet<string>): Verdict {
  const t = item.todo;
  if (!DELEGATED_KINDS.includes(t.kind)) return { leave: "never" };
  const offers = (key: string) => !t.resolutions?.length || t.resolutions.some((r) => r.key === key);
  if (t.kind === "note") return { decide: { with: "acknowledged", basis: "note" } };
  if (t.kind === "stale" && item.with_todo) return { leave: "with_conflict" };
  if (t.kind === "review_due" || t.kind === "stale") {
    return offers("reviewed")
      ? { decide: { with: "reviewed", basis: t.kind === "stale" ? "copy" : "unchanged" } }
      : { leave: "no_advice" };
  }
  const advice = item.advice;
  if (!advice || !t.resolutions?.some((r) => r.key === advice.with)) return { leave: "no_advice" };
  if ([...chosenByPeople].some((k) => k !== advice.with)) return { leave: "person_decided", suggest: advice };
  if (!advice.sure) return { leave: "unsure", suggest: advice };
  return { decide: { with: advice.with, basis: advice.basis } };
}

export interface AssistantOptions {
  inbox: Inbox;
  clock?: () => Date;
}

/**
 * The assistant on the inbox: decides a card or a few todos when the member asks, decides a
 * member's new todos as they arrive while their standing delegation is on, undoes a decision
 * on request, and keeps the delegation itself. See the package doc comment for the rules.
 */
export class Assistant {
  readonly inbox: Inbox;
  readonly clock: () => Date;
  readonly totals = { decided: 0, left: 0, undone: 0, paused: 0 };

  constructor(options: AssistantOptions) {
    this.inbox = options.inbox;
    this.clock = options.clock ?? options.inbox.clock;
  }

  /** While a member's delegation is on, each new todo of theirs of its kinds is decided as it arrives. */
  readonly onTodoCreated: EventHandler = async (event) => {
    const created = payloadOf(event, "todo.created");
    const member = created.assignee_id;
    if (!member || !DELEGATED_KINDS.includes(created.kind)) return;
    await this.inbox.update(event.tenant_id, async (tx) => {
      if (!(await tx.firstDelivery(COMPONENT, event.id))) return;
      const delegation = (await tx.get(DELEGATIONS, `${event.tenant_id}/${member}`))?.delegation;
      if (delegation?.state !== "on" || !delegation.kinds.includes(created.kind)) return;
      const item = await tx.get(ITEMS, created.todo_id);
      if (item && OPEN.includes(item.todo.status))
        await this.#decide(tx, event.tenant_id, member, [item], "delegation");
    });
  };

  handlers(): Record<string, EventHandler> {
    return { "todo.created": this.onTodoCreated };
  }

  /**
   * Decide the member's open todos on one card, or the ones named, in the card's order, and
   * leave the rest with why. A named todo that is not the member's raises RangeError, and so
   * does naming more than MAX_ASKED; todos already closed are neither decided nor left.
   */
  async decide(who: Principal, ask: DecideTodos): Promise<Decided> {
    const tenantId = who.tenant_id;
    const named = ask.todo_ids ?? [];
    if (named.length > MAX_ASKED) throw new RangeError(`at most ${MAX_ASKED} todos at once, not ${named.length}`);
    const via: DecisionVia = named.length === 1 ? "assistant_once" : "assistant_batch";
    const { decided, left } = await this.inbox.update(tenantId, async (tx) => {
      let items: Item[];
      if (ask.batch_key !== undefined) {
        items = await tx.find(ITEMS, { tenant_id: tenantId, batch_key: ask.batch_key, status: OPEN });
      } else {
        const found = new Map((await tx.getMany(ITEMS, named)).map((i) => [i.todo.id, i]));
        items = named.map((id) => {
          const item = found.get(id);
          if (item?.todo.tenant_id !== tenantId || item.todo.assignee_id !== who.id)
            throw new RangeError(`unknown todo ${id}`);
          return item;
        });
      }
      const open = items
        .filter((i) => i.todo.assignee_id === who.id && OPEN.includes(i.todo.status))
        .sort((a, b) => todoOrder(a.todo, b.todo));
      return this.#decide(tx, tenantId, who.id, open, via);
    });
    const pack = packOf(who.locale);
    return { decisions: decided.map((d) => decisionOf(d, pack)), left: left.map((i) => leftOf(i, pack)) };
  }

  /**
   * Undo one of the member's decisions: the todo opens again, marked as undone, and
   * todo.reopened tells its requester to restore what the resolution changed. Undoing 2 of
   * the member's last 10 decisions of one kind pauses their delegation. Undefined for a
   * decision that is not the member's; a refusal when it was undone already or a later
   * decision replaced it.
   */
  async undo(who: Principal, decisionId: string): Promise<{ todo?: Todo; refused?: string }> {
    const tenantId = who.tenant_id;
    const out = await this.inbox.update(tenantId, async (tx) => {
      const decision = await tx.get(DECISIONS, decisionId);
      if (decision?.tenant_id !== tenantId || decision.decided_by !== who.id) return {};
      if (decision.undone_at) return { refused: `decision ${decisionId} was undone already` };
      // The todo no longer closed by this decision: a later one replaced it.
      const item = await tx.get(ITEMS, decision.todo.id);
      if (item?.todo.status !== "done" || item.todo.resolved_at !== decision.todo.resolved_at) {
        return { refused: `a later decision replaced decision ${decisionId}` };
      }
      const at = this.clock().toISOString();
      const { resolved_by: _by, resolved_at: _at, resolved_with: _with, ...todo } = item.todo;
      item.todo = { ...todo, status: "open" };
      item.left = { why: "undone", at };
      await tx.put(ITEMS, [item]);
      await tx.put(DECISIONS, [{ ...decision, undone_at: at }]);
      const t = item.todo;
      await tx.publish(
        newEvent(
          "todo.reopened",
          {
            todo_id: t.id,
            kind: t.kind,
            space_id: t.space_id,
            dedupe_key: item.dedupe_key,
            ...(t.slot_key && { slot_key: t.slot_key }),
            created_by: t.created_by,
            decision_id: decision.id,
            undid: decision.with,
            reopened_by: who.id,
          },
          { tenantId, producer: COMPONENT, subject: t.id, occurredAt: this.clock() },
        ),
      );
      this.totals.undone++;
      await this.#pauseAfterUndos(tx, tenantId, who.id, t.kind, at);
      return { todo: item.todo };
    });
    return out;
  }

  /** What the assistant decided for the member in a week (this one by default), newest first, with what it left and what was undone. */
  async week(who: Principal, week = isoWeek(this.clock())): Promise<DecidedWeek> {
    const records = this.inbox.records;
    const decisions = (await records.find(DECISIONS, { tenant_id: who.tenant_id, member: who.id, week })).sort(
      (a, b) => (a.decided_at < b.decided_at ? 1 : a.decided_at > b.decided_at ? -1 : 0),
    );
    const mine = await records.find(ITEMS, { tenant_id: who.tenant_id, assignee: who.id });
    const pack = packOf(who.locale);
    return {
      week,
      decisions: decisions.map((d) => decisionOf(d, pack)),
      left: mine.filter((i) => i.left && i.left.why !== "undone" && isoWeek(new Date(i.left.at)) === week).length,
      undone: decisions.filter((d) => d.undone_at).length,
    };
  }

  /** Every decision the assistant made in the tenant, the undone ones too: what usage counts. */
  async decisions(tenantId: string): Promise<DecisionRecord[]> {
    return this.inbox.records.find(DECISIONS, { tenant_id: tenantId });
  }

  /** What the assistant would choose on each of these todos and why it left them, in the reader's language. */
  async marks(
    who: Principal,
    todoIds: readonly string[],
  ): Promise<Map<string, { suggestion?: TodoSuggestion; left?: TodoLeft }>> {
    const pack = packOf(who.locale);
    const out = new Map<string, { suggestion?: TodoSuggestion; left?: TodoLeft }>();
    for (const item of await this.inbox.records.getMany(ITEMS, todoIds)) {
      if (item.todo.tenant_id !== who.tenant_id) continue;
      const suggestion = suggestionOf(item, pack);
      out.set(item.todo.id, {
        ...(suggestion && { suggestion }),
        ...(item.left && { left: { reason: pack.section("left").text(item.left.why) } }),
      });
    }
    return out;
  }

  /** The member's standing delegation; unset until they answer the offer. */
  async delegation(tenantId: string, memberId: string): Promise<Delegation> {
    const record = await this.inbox.records.get(DELEGATIONS, `${tenantId}/${memberId}`);
    return record?.delegation ?? { state: "unset", kinds: [...DELEGATED_KINDS] };
  }

  /** Turn the member's standing delegation on, or pause it; pausing it here is the person's. */
  async setDelegation(tenantId: string, memberId: string, state: "on" | "paused"): Promise<Delegation> {
    return this.inbox.update(tenantId, async (tx) => {
      const delegation: Delegation = {
        state,
        kinds: [...DELEGATED_KINDS],
        ...(state === "paused" && { paused_reason: "person" as const }),
        changed_at: this.clock().toISOString(),
      };
      await tx.put(DELEGATIONS, [{ tenant_id: tenantId, member_id: memberId, delegation }]);
      return delegation;
    });
  }

  /** Decide or leave each todo, closing the decided ones as the member would. */
  async #decide(
    tx: RecordTx,
    tenantId: string,
    member: string,
    items: readonly Item[],
    via: DecisionVia,
  ): Promise<{ decided: DecisionRecord[]; left: Item[] }> {
    const decided: DecisionRecord[] = [];
    const left: Item[] = [];
    const now = this.clock();
    for (const item of items) {
      const verdict = judge(item, await this.#chosenByPeople(tx, item));
      if ("leave" in verdict) {
        item.left = { why: verdict.leave, at: now.toISOString() };
        await tx.put(ITEMS, [item]);
        left.push(item);
        continue;
      }
      const [todo] = await this.inbox.closeIn(tx, tenantId, [item.todo.id], { by: member, with: verdict.decide.with });
      const record: DecisionRecord = {
        id: newId("decision"),
        tenant_id: tenantId,
        todo: todo as Todo,
        with: verdict.decide.with,
        basis: verdict.decide.basis,
        via,
        decided_by: member,
        decided_at: now.toISOString(),
        week: isoWeek(now),
      };
      await tx.put(DECISIONS, [record]);
      decided.push(record);
    }
    this.totals.decided += decided.length;
    this.totals.left += left.length;
    return { decided, left };
  }

  /**
   * The resolutions people chose on earlier todos of the same question (dedupe key), leaving
   * out the assistant's decisions that still stand: it never outvotes a person.
   */
  async #chosenByPeople(tx: RecordTx, item: Item): Promise<Set<string>> {
    if (item.todo.kind !== "conflict") return new Set();
    const earlier = (await tx.find(ITEMS, { tenant_id: item.todo.tenant_id, dedupe_key: item.dedupe_key })).filter(
      (i) => i.todo.id !== item.todo.id && i.todo.status === "done" && i.todo.resolved_with !== undefined,
    );
    const chosen = new Set<string>();
    for (const i of earlier) {
      const mine = await tx.find(DECISIONS, { tenant_id: i.todo.tenant_id, todo: i.todo.id });
      if (!mine.some((d) => !d.undone_at && d.todo.resolved_at === i.todo.resolved_at))
        chosen.add(i.todo.resolved_with as string);
    }
    return chosen;
  }

  async #pauseAfterUndos(tx: RecordTx, tenantId: string, member: string, kind: TodoKind, at: string): Promise<void> {
    const record = await tx.get(DELEGATIONS, `${tenantId}/${member}`);
    if (record?.delegation.state !== "on") return;
    const last = (await tx.find(DECISIONS, { tenant_id: tenantId, member }))
      .filter((d) => d.todo.kind === kind)
      .sort((a, b) => (a.decided_at < b.decided_at ? 1 : a.decided_at > b.decided_at ? -1 : 0))
      .slice(0, UNDO_WINDOW);
    if (last.filter((d) => d.undone_at).length < UNDO_LIMIT) return;
    record.delegation = { ...record.delegation, state: "paused", paused_reason: "undone", changed_at: at };
    await tx.put(DELEGATIONS, [record]);
    this.totals.paused++;
  }
}

function labelOf(todo: Todo, key: string, pack: LanguagePack): string {
  return todo.resolutions?.find((r) => r.key === key)?.label ?? pack.section("labels").text(key);
}

function decisionOf(d: DecisionRecord, pack: LanguagePack): TodoDecision {
  return {
    id: d.id,
    todo: d.todo,
    with: d.with,
    label: labelOf(d.todo, d.with, pack),
    reason: pack.section("reasons").text(d.basis),
    via: d.via,
    decided_by: d.decided_by,
    decided_at: d.decided_at,
    ...(d.undone_at && { undone_at: d.undone_at }),
  };
}

/** The requester's advice, when the todo still offers it, as the inbox shows it selected. */
function suggestionOf(item: Item, pack: LanguagePack): TodoSuggestion | undefined {
  const advice = item.advice;
  if (!advice || !item.todo.resolutions?.some((r) => r.key === advice.with)) return undefined;
  return { with: advice.with, reason: pack.section("reasons").text(advice.basis) };
}

function leftOf(item: Item, pack: LanguagePack): LeftTodo {
  const suggestion = suggestionOf(item, pack);
  return {
    todo_id: item.todo.id,
    reason: pack.section("left").text(item.left?.why ?? "no_advice"),
    ...(suggestion && { suggestion }),
  };
}
