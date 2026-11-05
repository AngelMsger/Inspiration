// The Decide for me routes of the HTTP API: the assistant deciding a member's todos, undoing
// one of its decisions, the week's decisions, and the member's standing delegation. The
// assistant (collaboration) decides only the member's own todos, with their rights.

import { MAX_ASKED } from "@inspiration/collaboration";
import {
  type Decided,
  type DecideTodos,
  type Delegation,
  type InboxTodo,
  type Principal,
  type PutDelegation,
  parseAs,
} from "@inspiration/contracts";
import type { Engine } from "./engine.ts";
import { badRequest, HttpError, notFound } from "./http-errors.ts";
import { inboxTodos } from "./todos.ts";

/** Decide the member's todos on a card, or the ones named, then let what that caused settle. */
export async function decideTodos(engine: Engine, who: Principal, body: unknown): Promise<Decided> {
  const ask = parseAs<DecideTodos>("DecideTodos", body);
  if ((ask.todo_ids?.length ?? 0) > MAX_ASKED) throw badRequest(`name at most ${MAX_ASKED} todos, a card's worth`);
  const decided = await engine.assistant.decide(who, ask);
  await engine.settle();
  return decided;
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
