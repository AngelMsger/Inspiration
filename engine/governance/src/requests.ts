// What governance asks people and how their answers come back: the todo for a slot's open
// cases with a choice per value, the note for a value only reference documents state, and the
// decision a person's choice makes while it still answers the question asked.

import { contentHash, type Priority, type TodoRequested } from "@inspiration/contracts";
import type { Note, SlotState } from "./governance.ts";
import { asOf, type CaseDraft, decide, governedIn, type SlotDecision, type ValueGroup, withChoice } from "./slots.ts";

export const COMPONENT = "governance";

const PRIORITY: readonly Priority[] = ["low", "normal", "high", "urgent"];

/** "hotel_cap_per_night (tier-1 city)" */
function slotLabel(slot: string): string {
  const [predicate, ...qualifiers] = slot.split("|");
  return qualifiers.length ? `${predicate} (${qualifiers.join(", ")})` : (predicate as string);
}

function statements(g: ValueGroup): string {
  const n = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;
  return `${n(g.count, "statement")} in ${n(g.versions.length, "document")}, the most authoritative ${g.best.document}`;
}

/**
 * What governance asks a person when a slot has open cases: a hash of the proposed value and
 * the open cases. A person's choice answers it, and a todo is asked again only when it changes.
 * "" when governance asks nothing.
 */
function questionOf(decision: SlotDecision | undefined): string {
  const open = (decision?.cases ?? []).filter((c) => c.status === "open");
  if (!decision || !open.length || governedIn(decision.proposed) === 0) return "";
  return contentHash(
    JSON.stringify([decision.proposed.value, open.map((c) => [c.value, c.classification, c.priority])]),
  );
}

/** What a person chooses on a conflict todo, as its resolutions carry it. */
export interface ChoiceEffect {
  slot_key: string;
  value: string;
  question: string;
  /** The value's best statement, for showing the choice. */
  claim_id: string;
}

/**
 * A slot's decision with the person's choice applied while it answers the question governance
 * would ask today, and that question.
 */
export function decisionOf(
  stored: readonly ValueGroup[],
  today: string,
  state: SlotState | undefined,
): { decision?: SlotDecision; question: string } {
  const free = decide(stored, today);
  const question = questionOf(free);
  const choice = state?.chosen;
  const chosen =
    free && choice && question && choice.question === question
      ? withChoice(free, asOf(stored, today), choice)
      : undefined;
  return { ...((chosen ?? free) && { decision: chosen ?? free }), question };
}

/** The todo request for a slot's open cases, offering each value to choose. */
export function todoOf(
  decision: SlotDecision,
  open: readonly CaseDraft[],
  groups: Map<string, ValueGroup>,
  question: string,
): TodoRequested {
  const { proposed } = decision;
  const contenders = open.map((c) => groups.get(c.value) as ValueGroup);
  const why = decision.change
    ? `changed on ${decision.change.stated_from} in ${decision.change.document}`
    : "the most authoritative source";
  const detail = [
    `- **${proposed.value}**, proposed (${why}): ${statements(proposed)}.`,
    ...open.map(
      (c) =>
        `- ${c.value}, ${c.classification.replace(/_/g, " ")}: ${statements(groups.get(c.value) as ValueGroup)}. ${c.rationale}`,
    ),
  ].join("\n");
  const priority = open.reduce<Priority>(
    (p, c) => (PRIORITY.indexOf(c.priority) > PRIORITY.indexOf(p) ? c.priority : p),
    "low",
  );
  const predicate = proposed.slot.split("|")[0] as string;
  return {
    kind: "conflict",
    space_id: proposed.best.space_id,
    title: `${slotLabel(proposed.slot)}: ${[proposed, ...contenders].map((g) => g.value).join(" or ")}`,
    detail,
    priority,
    unit_ids: [proposed.best.claim_id, ...contenders.map((g) => g.best.claim_id)],
    dedupe_key: `${COMPONENT}:conflict:${proposed.slot}`,
    batch_key: `${COMPONENT}:conflict:${predicate}`,
    slot_key: proposed.slot,
    resolutions: [proposed, ...contenders].map((g, i) => {
      const effect: ChoiceEffect = { slot_key: proposed.slot, value: g.value, question, claim_id: g.best.claim_id };
      return { key: `choose:${g.value}`, label: `${i ? "Choose" : "Keep"} ${g.value}`, effect: { ...effect } };
    }),
  };
}

/** The request that withdraws an earlier one. */
export function withdrawal(request: TodoRequested): TodoRequested {
  const { refresh: _refresh, ...rest } = request;
  return { ...rest, withdrawn: true };
}

/** The note for a value only reference documents state: what they say, and the governed value that holds. */
export function noteOf(proposed: ValueGroup, other: ValueGroup, draft: CaseDraft): Note {
  const since = other.best.stated_from ?? other.best.document_from;
  const request: TodoRequested = {
    kind: "note",
    space_id: proposed.best.space_id,
    title: `${slotLabel(proposed.slot)}: ${other.value} in ${other.best.document}, ${proposed.value} holds`,
    detail: [
      `- **${proposed.value}** holds: ${statements(proposed)}.`,
      `- ${other.value}${since ? ` (from ${since})` : ""}: ${statements(other)}. ${draft.rationale}`,
    ].join("\n"),
    priority: "low",
    unit_ids: [proposed.best.claim_id, other.best.claim_id],
    dedupe_key: `${COMPONENT}:note:${proposed.slot}:${other.value}`,
    batch_key: `${COMPONENT}:note:${proposed.slot}`,
    slot_key: proposed.slot,
  };
  return { request, said: contentHash(JSON.stringify([request.title, since ?? "", request.unit_ids])) };
}
