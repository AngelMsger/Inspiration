// What Decide for me shows of the assistant's work in the inbox: which cards it may still be
// asked about, the marks it leaves on what it left, and its decisions in the reader's words.
// The engine decides; the page only asks, card by card, and keeps the answers on screen until
// the inbox is read again.

import type {
  Decided,
  DecideTodos,
  InboxCard,
  InboxTodo,
  LeftTodo,
  TaxonomyNode,
  TodoDecision,
} from "@inspiration/contracts";
import { factTitle, type Side, valueText } from "./todos.ts";
import type { Say } from "./words.ts";

/** A todo with the marks the assistant gave it in this visit, until the inbox read again holds them. */
export function marked(item: InboxTodo, marks: ReadonlyMap<string, LeftTodo>): InboxTodo {
  const mark = marks.get(item.todo.id);
  if (!mark) return item;
  return {
    ...item,
    left: item.left ?? { reason: mark.reason },
    ...((item.suggestion ?? mark.suggestion) && { suggestion: item.suggestion ?? mark.suggestion }),
  };
}

/** The cards holding a todo the assistant has not left yet, which a press of Decide for me asks about. */
export const toDecide = (cards: readonly InboxCard[]): InboxCard[] => cards.filter((c) => c.todos.some((t) => !t.left));

/** Asks the assistant about each card in turn, in the inbox's order, and hands on each answer as it comes. */
export async function decideCards(
  cards: readonly InboxCard[],
  decide: (asked: DecideTodos) => Promise<Decided>,
  onCard: (decided: Decided) => void,
): Promise<void> {
  for (const card of cards) onCard(await decide({ batch_key: card.batch_key }));
}

/** The side the assistant would choose: its suggestion when it has one, else the value proposed first. */
export const suggestedSide = (item: InboxTodo, sides: readonly Side[]): Side | undefined =>
  item.suggestion ? sides.find((s) => s.choice.key === item.suggestion?.with) : sides[0];

/** What a decision chose, in the reader's words: the value it keeps, else the resolution's label. */
export function chosenText(say: Say, decision: TodoDecision): string {
  const value = decision.todo.resolutions?.find((r) => r.key === decision.with)?.effect?.value;
  return typeof value === "string" ? valueText(say, value) : decision.label;
}

/**
 * The fact a decision is about, as the inbox named it when it showed the todo, else as the
 * tenant's catalogue or its topic calls it, with the slot's scope, else the todo's title.
 */
export function decisionFact(
  say: Say,
  decision: TodoDecision,
  shown: string | undefined,
  topics: readonly TaxonomyNode[],
): string {
  if (shown) return shown;
  const name = decision.fact_label ?? topics.find((t) => t.key === decision.todo.taxonomy_key)?.title;
  return name ? factTitle(say, name, decision.todo.slot_key) : decision.todo.title;
}
