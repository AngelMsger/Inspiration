// The inbox routes of the HTTP API: a member's open todos with what each asks them to choose,
// and resolving one. Collaboration keeps the todos and retrieval says what each choice states,
// as the member may read it.

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

/** The member's open todos on their cards, with the statements each is about. */
export async function inboxOf(engine: Engine, who: Principal): Promise<Inbox> {
  const cards = await engine.inbox.cards(who.tenant_id, { assignee: who.id });
  const topics = new Map((await engine.store.topics(who.tenant_id)).map((n) => [n.key, n]));
  const asked = [...new Set(cards.flatMap((c) => c.todos.flatMap((t) => t.unit_ids)))];
  const labelOf = await factLabels(engine, who.tenant_id);
  const statements = new Map<string, SearchHit>(
    (await engine.retrieval.statementsOf(asked, who)).statements.map((h) => [h.unit_id, h]),
  );
  const todoOf = (todo: Todo): InboxTodo => {
    const label = labelOf(todo.slot_key);
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
    };
  };
  return {
    cards: cards.map((c): InboxCard => {
      const topic: TaxonomyNode | undefined = c.taxonomy_key ? topics.get(c.taxonomy_key) : undefined;
      return {
        batch_key: c.batch_key,
        kind: cardKind(c.batch_key),
        ...(c.week && { week: c.week }),
        ...(topic && { topic }),
        todos: c.todos.map(todoOf),
      };
    }),
  };
}

/**
 * Resolve a todo assigned to the member, then let every component read what that caused, so
 * the next read sees it: a conflict's choice changes the value that holds and the answers.
 * Returns undefined when the member has no such todo, and a reason when the request is not one
 * the todo can take.
 */
export async function resolveTodo(
  engine: Engine,
  who: Principal,
  todoId: string,
  how: ResolveTodo,
): Promise<{ todo?: Todo; refused?: string }> {
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
  await engine.settle();
  return { todo: closed };
}
