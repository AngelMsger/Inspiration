// What the inbox shows of a todo: the fact it is about, the sides a person chooses between,
// and values in the reader's words rather than the engine's normalized keys, as answers' notes
// name them too.

import type { AnswerNote, InboxCard, InboxTodo, SearchHit, TodoChoice } from "@inspiration/contracts";
import type { Say } from "./words.ts";

/** "5 day" in the reader's words ("5 days"); a value whose unit has no words, as it is. */
export function valueText(say: Say, value: string | undefined): string {
  if (!value) return "";
  const m = /^(-?\d+(?:\.\d+)?) (\S+)$/.exec(value);
  if (!m) return value;
  const key = `unit.${(m[2] as string).toLowerCase().replace("/", "_per_")}`;
  const text = say(key, { n: m[1] as string });
  return text === key ? value : text;
}

/**
 * A note in the reader's words when it names its values ("7 days" rather than "7 day"), else as the engine
 * wrote it, in the question's language.
 */
export function noteText(say: Say, note: AnswerNote): string {
  if (note.held_value === undefined || !note.values?.length) return note.text;
  const list = (items: string[]) => items.join(say("list.mark"));
  const held = valueText(say, note.held_value);
  const values = list(note.values.map((v) => valueText(say, v)));
  if (note.kind === "conflict") return say("note.conflict_text", { values, held });
  if (note.kind === "outdated" && note.documents?.length) {
    return say("note.outdated_text", { documents: list(note.documents), old: values, held });
  }
  return note.text;
}

/**
 * The fact a todo is about, with the slot's scope ("Annual leave (1 to 10 years)"): as the
 * tenant's catalogue names it, else as its topic is called, else the todo's title.
 */
export function factOf(say: Say, todo: InboxTodo, card: InboxCard | undefined): string {
  const name = todo.fact_label ?? card?.topic?.title;
  return name ? factTitle(say, name, todo.todo.slot_key) : todo.todo.title;
}

/** A fact's name with its slot's qualifiers as its scope. */
export function factTitle(say: Say, name: string, slot: string | undefined): string {
  const scope = (slot ?? "").split("|").slice(1).join(", ");
  return scope ? say("fact.scoped", { topic: name, scope }) : name;
}

/** One value a person may choose, with the statement that says it; the first is the suggestion. */
export interface Side {
  choice: TodoChoice;
  statement?: SearchHit;
  suggested: boolean;
}

export function sidesOf(todo: InboxTodo): Side[] {
  const byId = new Map(todo.statements.map((h) => [h.unit_id, h]));
  return todo.choices.map((choice, i) => ({
    choice,
    ...(choice.unit_id && byId.has(choice.unit_id) && { statement: byId.get(choice.unit_id) }),
    suggested: i === 0,
  }));
}

/** The week number of an ISO week ("2026-W45" is 45). */
export const weekOf = (week: string | undefined) => (week ? String(Number(week.split("-W")[1])) : "");
