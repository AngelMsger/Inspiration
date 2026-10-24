/**
 * Governance: compares what documents say about the same fact, proposes which value holds,
 * and asks a person to decide when it cannot settle it alone.
 *
 * On claims.updated it keeps every current claim with a slot (its slot_key) and a value in
 * that slot's value group, counted incrementally, and decides the slot again (the rules are
 * in slots.ts):
 * - The proposed value is the most authoritative one in force, unless a statement dated
 *   later than it changed the value ("自 2026 年 10 月 1 日起……调整为 650 元").
 * - Every other value gets a ConflictCase from the deterministic tier: a supersession
 *   (auto-resolved when only archived documents state it), plan versus fact, or a
 *   contradiction, with the proposed value's best claim as proposed_winner_id.
 * - Governed documents decide a slot they state. A value only reference documents state is
 *   an auto-resolved contradiction, a note for the owner rather than a todo, and a change a
 *   reference document dates moves nothing.
 * - A case whose value is no longer stated, or is now the proposed one, is auto-resolved.
 * - When a slot's open cases or proposed value change, governance publishes one
 *   todo.requested for the slot (dedupe_key "governance:conflict:<slot>"); a new statement
 *   that only repeats a known value asks for nothing, and neither does a slot only reference
 *   documents state, which has no owner. Collaboration owns the todo.
 *
 * Updates of one tenant run one at a time in a process, and the inbox mark commits with the
 * rows, so a redelivered event changes nothing. Run one governance consumer per tenant.
 *
 * A slot is decided when its claims change, and again on the first day a dated change it
 * holds takes effect: recheck(tenant) decides the slots that are due, and the engine calls
 * it once a day.
 *
 * Not built yet: the semantic, NLI and model-judge tiers for claims without a slot, citation
 * audit, claim merge into canonical claims, coverage gaps and the taxonomy gardener; and
 * nothing tells collaboration yet that a conflict went away by itself.
 */

export * from "./governance.ts";
export * from "./migrations.ts";
export * from "./slots.ts";
