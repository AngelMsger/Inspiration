/**
 * Collaboration. Built so far: the inbox, where requests for a person's attention become
 * todos on cards.
 *
 * On todo.requested and review.due the inbox keeps one open todo per dedupe_key: a later
 * request with the key replaces its title, detail, priority and units and leaves it where it
 * is; a new one publishes todo.created. A request marked withdrawn dismisses the open todo
 * with its key (resolved_with "withdrawn") and opens nothing. Reviews become todos by kind:
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
 *   card's next part when it is full. When the conflict closes, reroute routes the review on
 *   its own.
 * - Reviews already due when freshness first saw their document (backlog) go on a
 *   first-review campaign card per space and topic, nobody's budget.
 * - Todos of a topic nobody owns, or of no topic, go on the space steward's card of the week.
 * - Campaign and steward cards hold at most `cardSize` todos too; the rest start a next card
 *   ("<card>:2").
 *
 * A todo stays in its week until it is resolved; nothing moves it on when the week passes.
 * Updates of one tenant run one at a time in a process, and the inbox mark commits with the
 * rows, so a redelivered event changes nothing. Run one collaboration consumer per tenant.
 *
 * Not yet built: comments and anchoring, agent replies, overrides, the resolutions a todo
 * offers and what choosing one does, the publish state machine, quality gates, verification
 * expiry, stewards and admins as assignees (the business layer provisions them), and an event
 * that tells the inbox when topics or owners change.
 */

export * from "./inbox.ts";
export * from "./migrations.ts";
export * from "./weeks.ts";
