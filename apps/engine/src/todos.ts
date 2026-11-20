// The inbox routes of the HTTP API: a member's open todos with what each asks them to choose,
// what the assistant would choose and why it left one, and resolving one. Collaboration keeps
// the todos and retrieval says what each choice states, as the member may read it.

import { setTimeout as sleep } from "node:timers/promises";
import { cardKind } from "@inspiration/collaboration";
import type {
  Inbox,
  InboxCard,
  InboxTodo,
  Principal,
  ResolveTodo,
  SearchHit,
  TaxonomyNode,
  Todo,
  TodoChoice,
} from "@inspiration/contracts";
import type { Engine } from "./engine.ts";

/** What the tenant's predicate catalogue calls the fact of a slot; its qualifiers are its scope. */
export async function factLabels(
  engine: Engine,
  tenantId: string,
): Promise<(slot: string | undefined) => string | undefined> {
  const catalogue = (await engine.vocabulary(tenantId))?.predicates ?? [];
  return (slot) => (slot ? catalogue.find((p) => p.predicate === slot.split("|")[0])?.label : undefined);
}

/**
 * Todos as the inbox shows them to the member: the statements each is about, as the member may
 * read them, its choices, and what the assistant would choose and why it left it.
 */
export async function inboxTodos(engine: Engine, who: Principal, todos: readonly Todo[]): Promise<InboxTodo[]> {
  const asked = [...new Set(todos.flatMap((t) => t.unit_ids))];
  const labelOf = await factLabels(engine, who.tenant_id);
  const statements = new Map<string, SearchHit>(
    (await engine.retrieval.statementsOf(asked, who)).statements.map((h) => [h.unit_id, h]),
  );
  const marks = await engine.assistant.marks(
    who,
    todos.map((t) => t.id),
  );
  return todos.map((todo): InboxTodo => {
    const label = labelOf(todo.slot_key);
    const { suggestion, left } = marks.get(todo.id) ?? {};
    return {
      todo,
      ...(label && { fact_label: label }),
      statements: todo.unit_ids.flatMap((id) => statements.get(id) ?? []),
      choices: (todo.resolutions ?? []).map((r): TodoChoice => {
        const { value, claim_id } = r.effect ?? {};
        return {
          key: r.key,
          label: r.label,
          ...(typeof value === "string" && { value }),
          ...(typeof claim_id === "string" && { unit_id: claim_id }),
        };
      }),
      ...(suggestion && { suggestion }),
      ...(left && { left }),
    };
  });
}

/** The member's open todos on their cards, with the statements each is about. */
export async function inboxOf(engine: Engine, who: Principal): Promise<Inbox> {
  const cards = await engine.inbox.cards(who.tenant_id, { assignee: who.id });
  const topics = new Map((await engine.store.topics(who.tenant_id)).map((n) => [n.key, n]));
  const shown = new Map(
    (
      await inboxTodos(
        engine,
        who,
        cards.flatMap((c) => c.todos),
      )
    ).map((t) => [t.todo.id, t]),
  );
  return {
    cards: cards.map((c): InboxCard => {
      const topic: TaxonomyNode | undefined = c.taxonomy_key ? topics.get(c.taxonomy_key) : undefined;
      return {
        batch_key: c.batch_key,
        kind: cardKind(c.batch_key),
        ...(c.week && { week: c.week }),
        ...(topic && { topic }),
        todos: c.todos.map((t) => shown.get(t.id) as InboxTodo),
      };
    }),
  };
}

export interface WaitOptions {
  maxRounds?: number;
}

/** True once a resolved or reopened todo's governance effect is visible in the store. */
async function todoEffectVisible(engine: Engine, todo: Todo): Promise<boolean> {
  if (todo.created_by !== "governance" || todo.kind !== "conflict" || !todo.slot_key) return true;
  const [verdict] = await engine.governance.verdicts(todo.tenant_id, [todo.slot_key]);
  if (!verdict) return true;
  if (todo.status === "open") {
    return verdict.chosen_at === undefined;
  }
  const effect = todo.resolutions?.find((r) => r.key === todo.resolved_with)?.effect as
    | { slot_key?: string; value?: string }
    | undefined;
  if (todo.status === "done" && effect?.slot_key === todo.slot_key && typeof effect.value === "string") {
    // Either the chosen value now holds, or governance superseded the question and asked a new one.
    return verdict.chosen_at === todo.resolved_at || !verdict.disputed;
  }
  return true;
}

/** Return whether these todos still have a pending governance effect after the wait budget. */
export async function waitForTodos(
  engine: Engine,
  todos: readonly Todo[],
  options: WaitOptions = {},
): Promise<boolean> {
  const allVisible = async () => (await Promise.all(todos.map((t) => todoEffectVisible(engine, t)))).every(Boolean);
  if (!engine.isServiceRunning) {
    // Batch callers drive delivery themselves, including downstream work for ordinary notes.
    try {
      await engine.settle(options.maxRounds);
    } catch (error) {
      if (!todos.some((t) => t.created_by === "governance" && t.kind === "conflict" && t.slot_key)) throw error;
    }
    return !(await allVisible());
  }
  for (let round = 0; round < (options.maxRounds ?? 250) && engine.isServiceRunning; round++) {
    if (await allVisible()) return false;
    await sleep(20);
  }
  return !(await allVisible());
}

/**
 * Resolve a todo assigned to the member, then let every component read what that caused, so
 * the next read sees it: a conflict's choice changes the value that holds and the answers.
 * Returns undefined when the member has no such todo, a reason when the request is not one
 * the todo can take, and pending: true when background delivery has not yet applied the choice.
 */
export async function resolveTodo(
  engine: Engine,
  who: Principal,
  todoId: string,
  how: ResolveTodo,
  options: WaitOptions = {},
): Promise<{ todo?: Todo; refused?: string; pending?: boolean }> {
  const todo = await engine.inbox.todo(who.tenant_id, todoId);
  if (!todo || todo.assignee_id !== who.id) return {};
  const offered = todo.resolutions ?? [];
  if (how.with !== undefined && offered.length && !offered.some((r) => r.key === how.with)) {
    return { refused: `todo ${todoId} offers no resolution ${how.with}` };
  }
  if (how.status !== "dismissed" && offered.length && how.with === undefined) {
    return { refused: `choose one of the resolutions todo ${todoId} offers, or dismiss it` };
  }
  const closed = await engine.inbox.resolve(who.tenant_id, todoId, {
    by: who.id,
    ...(how.with !== undefined && { with: how.with }),
    ...(how.status && { status: how.status }),
  });
  const pending = await waitForTodos(engine, [closed], options);
  return { todo: closed, ...(pending && { pending: true }) };
}
