/**
 * Collaboration. Built so far: the inbox, where requests for a person's attention become
 * todos on cards, and Decide for me, where the assistant decides them for a member who lets it.
 *
 * On todo.requested and review.due the inbox keeps one open todo per dedupe_key: a later
 * request with the key replaces its title, detail, priority and units and leaves it where it
 * is; a new one publishes todo.created. A request marked withdrawn dismisses the open todo
 * with its key (resolved_with "withdrawn") and opens nothing. A request marked refresh only
 * replaces an open todo, and the item keeps the units it swapped in (Item.refreshed) so
 * review load does not count them as more to decide. Reviews become todos by kind:
 * ttl and verification_expiry are review_due, assumption is assumption_drift,
 * evidence_changed is stale.
 *
 * Routing. A todo's topic is the placement of its first claim (the proposed value of a
 * conflict, the governed value of a note), else the topic most of its claims are in; a
 * review's is the topic most of its document's statements are in. Its assignee is the
 * topic's owner, else the nearest owner above it. reroute(tenant) routes open todos again
 * once topics or owners change.
 *
 * Cards (Todo.batch_key) and the weekly budget:
 * - An owner's todos about one topic in one ISO week share a card of at most `cardSize` (20)
 *   todos. An owner gets at most `budget` (10) cards a week. A todo goes in the first week
 *   from its due week with room, at most `horizon` (26) weeks later, else in its due week
 *   over the budget. Urgent and high todos always go in their due week.
 * - Notes (kind note) go on the owner's notes card of the week, outside the budget, and one
 *   action acknowledges them (acknowledge).
 * - A copy review (stale) from the same source update as an open conflict todo, sharing its
 *   correlation_id, goes on that conflict's card, whichever of the two came first, or on the
 *   card's next part when it is full. A conflict and its copy reviews stay together in the
 *   conflict's week, so the budget is a soft limit: like urgent todos, a group may take a
 *   card over it. When the conflict closes, reroute routes the review on its own.
 * - Reviews already due when freshness first saw their document (backlog) go on a
 *   first-review campaign card per space and topic, nobody's budget.
 * - Todos of a topic nobody owns, or of no topic, go on the space steward's card of the week.
 * - Campaign and steward cards hold at most `cardSize` todos too; the rest start a next card
 *   ("<card>:2").
 *
 * Resolutions. A request may offer resolutions, each with an effect its requester applies; a
 * later request with its key replaces them. resolve(tenant, todo, {by, with}) closes a todo,
 * done or dismissed, accepting only a key the todo offers when it offers any, and publishes
 * todo.resolved with the chosen effect in the same transaction. `by` is the person, or the
 * agent deciding for one. Closing a closed todo changes nothing and publishes nothing; a
 * withdrawn todo is dismissed without the event.
 *
 * Decide for me (assistant.ts, docs/design/decide-for-me.md). The assistant decides a member's
 * todos in their name, with their rights only: it closes nothing but the member's own todos,
 * as resolve does, and records a TodoDecision with how it was asked (assistant_once for one
 * todo, assistant_batch for a card or several, delegation as a todo arrives). No model takes
 * part; a request's advice (TodoRequested.suggestion) and the todo's kind decide:
 * - Notes are acknowledged. A review due by age (review_due) is confirmed ("reviewed"), since
 *   a change to its document would have restarted its clock. A copy review (stale) is confirmed
 *   too, unless it rides on an open conflict of the same source update, which it waits for.
 * - A conflict takes the requester's advice when the requester is sure and offers that
 *   resolution. It is left to the member, with the advice as its suggestion, when the requester
 *   is not sure, or when a person chose otherwise on an earlier todo of the same question: the
 *   assistant never outvotes a person.
 * - Every other kind is never decided for the member.
 * Left todos stay where they are, marked with why (Item.left). Reasons are written when they
 * are read, from the language packs, in the reader's locale, so they follow the member's
 * language. Undo reopens the todo on its card, marked as undone, and publishes todo.reopened so
 * its requester restores what the resolution changed; a decision undone already, or no longer
 * the one that closed its todo, is refused. A member's standing delegation (Delegation) is
 * unset until they answer the offer; while it is on, each new todo of theirs of its kinds
 * (review_due, stale, conflict, note) is decided as it arrives (todo.created). Undoing 2 of
 * their last 10 decisions of one kind pauses it (paused_reason undone) until they turn it on.
 * Assistant.decisions lists a tenant's decisions, the undone ones too, for the usage page.
 *
 * A todo stays in its week until it is resolved; nothing moves it on when the week passes.
 * Updates of one tenant run one at a time in a process, and the inbox mark commits with the
 * rows, so a redelivered event changes nothing. Run one collaboration consumer per tenant.
 *
 * Not yet built: comments and anchoring, agent replies, overrides, joint approval (the
 * business layer's), the publish state machine, quality gates, verification expiry, stewards
 * and admins as assignees (the business layer provisions them), and an event that tells the
 * inbox when topics or owners change. For Decide for me: the passages a decision rests on
 * (TodoDecision.span_ids), kinds a space owner keeps for people, open comments as a reason to
 * leave a todo, the super admin's switch, and a model task for what the rules leave.
 */

export * from "./assistant.ts";
export * from "./inbox.ts";
export * from "./migrations.ts";
export * from "./weeks.ts";
