/**
 * Governance: compares what documents say about the same fact, proposes which value holds,
 * and asks a person to decide when it cannot settle it alone.
 *
 * On claims.updated it keeps every current claim with a slot (its slot_key) and a value in
 * that slot's value group, counted incrementally, and decides the slot again (the rules are
 * in slots.ts):
 * - The proposed value is the most authoritative one in force, unless a statement dated
 *   later than it changed the value ("from 1 October 2026 ... raised to 650 yuan").
 *   Between equally authoritative values, the one more governed statements in effect today
 *   state is proposed. That counts statements, so a copy of a policy counts too, while the
 *   support people are shown is to count a copy once: an assumption still to be checked
 *   against a corpus built for it.
 * - Every other value gets a ConflictCase from the deterministic tier: a supersession
 *   (auto-resolved when only archived documents state it), plan versus fact, or a
 *   contradiction, with the proposed value's best claim as proposed_winner_id.
 * - Governed documents decide a slot they state. A value only reference documents state is
 *   an auto-resolved contradiction, and a change a reference document dates moves nothing;
 *   the case names that change, so the owner learns of it. Governance publishes a note for
 *   such a value (todo.requested of kind note, dedupe_key "governance:note:<slot>:<value>")
 *   naming the reference document, the date it gives and both values, and again only when
 *   one of those or the statements it points to change. A note asks for no decision.
 * - A case whose value is no longer stated, or is now the proposed one, is auto-resolved.
 * - When a slot's open cases or proposed value change, governance publishes one
 *   todo.requested for the slot (dedupe_key "governance:conflict:<slot>"); a new statement
 *   that only repeats a known value asks for nothing, and neither does a slot only reference
 *   documents state, which has no owner. Collaboration owns the todo.
 * - When the reason for a request or a note goes away (the slot stops asking, or the value
 *   is no longer stated by reference documents alone), governance publishes it again marked
 *   withdrawn, and collaboration dismisses the open todo.
 *
 * Updates of one tenant run one at a time in a process, and the inbox mark commits with the
 * rows, so a redelivered event changes nothing. Run one governance consumer per tenant.
 *
 * A slot is decided when its claims change, and again on the first day a dated change or a
 * governed statement it holds takes effect: recheck(tenant) decides the slots that are due,
 * and the engine calls it once a day.
 *
 * Not built yet: the semantic, NLI and model-judge tiers for claims without a slot, citation
 * audit, claim merge into canonical claims, coverage gaps and the taxonomy gardener.
 */

export * from "./governance.ts";
export * from "./migrations.ts";
export * from "./slots.ts";
