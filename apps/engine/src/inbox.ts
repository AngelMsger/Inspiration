/**
 * The inbox part of a run report: the todos collaboration keeps, by kind, and what they ask
 * of each owner per ISO week. Cards (an owner's todos about one topic in one week) are
 * counted against the weekly budget, and again as the same todos would fall without it, in
 * the week each fell due. Notes per owner per week sit outside the budget. The first-review
 * campaign and the steward's cards (topics nobody owns) are counted apart. Todos withdrawn
 * because their reason went away are counted, and left out of the rest.
 */

import { cardKind, type Item, weeksBetween } from "@inspiration/collaboration";
import { type Spread, spread } from "./claims.ts";
import type { Engine } from "./engine.ts";

export interface InboxReport {
  /** The inbox's settings: cards per owner and week, todos per card. */
  budget: number;
  card_size: number;
  todos: number;
  open: number;
  withdrawn: number;
  by_kind: Record<string, number>;
  /** Members with a card or a note. */
  owners: number;
  /** Review cards, per owner and week with any, and owner weeks over the budget. */
  cards: { total: number; per_owner_week: Spread; over_budget: number; todos_per_card: Spread };
  /** The same todos in the weeks they fell due, as many cards as the card size takes. */
  without_budget: { per_owner_week: Spread; over_budget: number };
  /** Todos the budget moved to a later week, and by how many weeks. */
  deferred: { todos: number; weeks: Spread };
  notes: { total: number; per_owner_week: Spread };
  campaign: { todos: number; cards: number };
  steward: { todos: number; cards: number };
}

function bump<K>(counts: Map<K, number>, key: K, by = 1): void {
  counts.set(key, (counts.get(key) ?? 0) + by);
}

export async function inboxReport(engine: Engine, tenantId: string): Promise<InboxReport> {
  const { budget, cardSize } = engine.inbox.settings;
  const items = await engine.inbox.items(tenantId);
  const byKind: Record<string, number> = {};
  const owners = new Set<string>();
  const cards = new Map<string, number>();
  const cardsPerWeek = new Map<string, number>();
  const due = new Map<string, number>();
  const notes = new Map<string, number>();
  const deferred: number[] = [];
  const campaign = new Set<string>();
  const steward = new Set<string>();
  let open = 0;
  let withdrawn = 0;
  let campaignTodos = 0;
  let stewardTodos = 0;
  const reviews: Item[] = [];
  for (const item of items) {
    const t = item.todo;
    byKind[t.kind] = (byKind[t.kind] ?? 0) + 1;
    if (t.status === "open" || t.status === "in_progress") open++;
    if (t.resolved_with === "withdrawn") {
      withdrawn++;
      continue;
    }
    if (t.assignee_id) owners.add(t.assignee_id);
    const kind = cardKind(t.batch_key as string);
    if (kind === "notes") bump(notes, `${t.assignee_id ?? t.batch_key}\x1f${t.week}`);
    else if (kind === "campaign") {
      campaignTodos++;
      campaign.add(t.batch_key as string);
    } else if (kind === "steward") {
      stewardTodos++;
      steward.add(t.batch_key as string);
    } else reviews.push(item);
  }
  for (const { todo: t, due_week } of reviews) {
    if (!cards.has(t.batch_key as string)) bump(cardsPerWeek, `${t.assignee_id}\x1f${t.week}`);
    bump(cards, t.batch_key as string);
    bump(due, `${t.assignee_id}\x1f${t.taxonomy_key ?? ""}\x1f${due_week}`);
    if (t.week !== due_week) deferred.push(weeksBetween(due_week, t.week as string));
  }
  const unbudgeted = new Map<string, number>();
  for (const [k, n] of due) {
    const [owner, , week] = k.split("\x1f");
    bump(unbudgeted, `${owner}\x1f${week}`, Math.ceil(n / cardSize));
  }
  return {
    budget,
    card_size: cardSize,
    todos: items.length,
    open,
    withdrawn,
    by_kind: byKind,
    owners: owners.size,
    cards: {
      total: cards.size,
      per_owner_week: spread([...cardsPerWeek.values()]),
      over_budget: [...cardsPerWeek.values()].filter((n) => n > budget).length,
      todos_per_card: spread([...cards.values()]),
    },
    without_budget: {
      per_owner_week: spread([...unbudgeted.values()]),
      over_budget: [...unbudgeted.values()].filter((n) => n > budget).length,
    },
    deferred: { todos: deferred.length, weeks: spread(deferred) },
    notes: { total: [...notes.values()].reduce((a, b) => a + b, 0), per_owner_week: spread([...notes.values()]) },
    campaign: { todos: campaignTodos, cards: campaign.size },
    steward: { todos: stewardTodos, cards: steward.size },
  };
}

export function inboxLines(r: InboxReport): string[] {
  const kv = (o: Record<string, number>) =>
    Object.entries(o)
      .sort(([, a], [, b]) => b - a)
      .map(([k, v]) => `${k} ${v}`)
      .join(", ");
  const c = r.cards;
  return [
    `inbox: ${r.todos} todos (${kv(r.by_kind) || "none"}), ${r.open} open, ${r.withdrawn} withdrawn, for ${r.owners} owners`,
    `  cards ${c.total}, per owner and week median ${c.per_owner_week.median}, max ${c.per_owner_week.max} (budget ${r.budget}; ${c.over_budget} owner weeks over it); todos per card median ${c.todos_per_card.median}, max ${c.todos_per_card.max}`,
    `  without the budget: per owner and week median ${r.without_budget.per_owner_week.median}, max ${r.without_budget.per_owner_week.max} (${r.without_budget.over_budget} owner weeks over ${r.budget}); ${r.deferred.todos} todos moved later, by median ${r.deferred.weeks.median}, max ${r.deferred.weeks.max} weeks`,
    `  notes ${r.notes.total}, per owner and week median ${r.notes.per_owner_week.median}, max ${r.notes.per_owner_week.max}; first-review campaign ${r.campaign.todos} todos on ${r.campaign.cards} cards; steward ${r.steward.todos} todos on ${r.steward.cards} cards`,
  ];
}
