// The Decide for me routes of the HTTP API: the assistant deciding a member's todos, undoing
// one of its decisions, the week's decisions, and the member's standing delegation. The
// assistant (collaboration) decides only the member's own todos, with their rights.

import { MAX_ASKED } from "@inspiration/collaboration";
import {
  type Decided,
  type DecidedWeek,
  type DecideTodos,
  type Delegation,
  type InboxTodo,
  type Principal,
  type PutDelegation,
  parseAs,
} from "@inspiration/contracts";
import type { Engine } from "./engine.ts";
import { badRequest, HttpError, notFound } from "./http-errors.ts";
import { factLabels, inboxTodos } from "./todos.ts";

/** Decide the member's todos on a card, or the ones named, then let what that caused settle. */
export async function decideTodos(engine: Engine, who: Principal, body: unknown): Promise<Decided> {
  const ask = parseAs<DecideTodos>("DecideTodos", body);
  if ((ask.todo_ids?.length ?? 0) > MAX_ASKED) throw badRequest(`name at most ${MAX_ASKED} todos, a card's worth`);
  const decided = await engine.assistant.decide(who, ask);
  await engine.settle();
  return named(engine, who, decided);
}

/** This week's decisions for the member, the undone ones too. */
export async function decidedWeek(engine: Engine, who: Principal): Promise<DecidedWeek> {
  return named(engine, who, await engine.assistant.week(who));
}

/** Each decision with the fact its todo is about, named as the inbox names it. */
async function named<T extends Decided | DecidedWeek>(engine: Engine, who: Principal, value: T): Promise<T> {
  const labelOf = await factLabels(engine, who.tenant_id);
  const decisions = value.decisions.map((d) => {
    const label = labelOf(d.todo.slot_key);
    return label ? { ...d, fact_label: label } : d;
  });
  return { ...value, decisions };
}

/** Undo one of the member's decisions: the todo is open again, as the inbox shows it. */
export async function undoDecision(engine: Engine, who: Principal, decisionId: string): Promise<InboxTodo> {
  const { todo, refused } = await engine.assistant.undo(who, decisionId);
  if (refused) throw new HttpError(409, "conflict", refused);
  if (!todo) throw notFound("decision");
  await engine.settle();
  // Its requester may have asked the question again, which the todo took.
  const now = (await engine.inbox.todo(who.tenant_id, todo.id)) ?? todo;
  return (await inboxTodos(engine, who, [now]))[0] as InboxTodo;
}

export async function putDelegation(engine: Engine, who: Principal, body: unknown): Promise<Delegation> {
  const { state } = parseAs<PutDelegation>("PutDelegation", body);
  return engine.assistant.setDelegation(who.tenant_id, who.id, state);
}
