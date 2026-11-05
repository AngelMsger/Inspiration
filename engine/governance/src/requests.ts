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
function questionOf(decision: SlotDecision | undefined, groups: readonly ValueGroup[]): string {
  const open = (decision?.cases ?? []).filter((c) => c.status === "open");
  // Only a slot that governed documents state has an owner to ask, even when a reference
  // document's change holds it.
  if (!decision || !open.length || !groups.some((g) => governedIn(g) > 0)) return "";
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
  const question = questionOf(free, asOf(stored, today));
  const choice = state?.chosen;
  const chosen =
    free && choice && question && choice.question === question
      ? withChoice(free, asOf(stored, today), choice)
      : undefined;
  return { ...((chosen ?? free) && { decision: chosen ?? free }), question };
}

/**
 * The space whose owner answers for a slot: the proposed value's, or, when only a reference
 * document's change holds it, that of the governed value it changed.
 */
export function ownerSpace(proposed: ValueGroup, others: Iterable<ValueGroup>): string {
  if (governedIn(proposed) > 0) return proposed.best.space_id;
  return [...others].find((g) => governedIn(g) > 0)?.best.space_id ?? proposed.best.space_id;
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
  // Governance is sure of the value it proposes unless a value as authoritative contradicts
  // it with no dated change between them: a newer document does not show the other is wrong.
  const even = open.some(
    (c, i) =>
      c.classification === "contradiction" && (contenders[i] as ValueGroup).best.authority >= proposed.best.authority,
  );
  const why = decision.change
    ? `changed on ${decision.change.stated_from} in ${decision.change.document}${decision.change.reference ? ", a reference document" : ""}`
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
    space_id: ownerSpace(proposed, contenders),
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
    suggestion: {
      with: `choose:${proposed.value}`,
      sure: !even,
      basis: even ? "disagreement" : decision.basis === "changed" ? "changed" : "authority",
    },
  };
}

/** The request that withdraws an earlier one. */
export function withdrawal(request: TodoRequested): TodoRequested {
  const { refresh: _refresh, ...rest } = request;
  return { ...rest, withdrawn: true };
}

/** The note for a value only reference documents state: what they say, and the governed value that holds. */
export function noteOf(proposed: ValueGroup, other: ValueGroup, draft: CaseDraft, space: string): Note {
  const since = other.best.stated_from ?? other.best.document_from;
  const request: TodoRequested = {
    kind: "note",
    space_id: space,
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
