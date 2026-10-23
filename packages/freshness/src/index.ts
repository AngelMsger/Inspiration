/**
 * Freshness: decides when knowledge needs a look, and says so with review.due. It changes
 * no knowledge and asks no model; collaboration turns each review into a todo, and research
 * may re-check the units itself.
 *
 * It keeps one record per current document (rules.ts has the arithmetic):
 * - On blocks.changed, a new version restarts the document's review clock from the day it
 *   last changed in its source (metadata.modified_at). Documents that repeat each other
 *   are remembered from the version's duplicates. When an edit leaves a copy sharing less
 *   of the new text, and the copy is no more authoritative and not archived, the copy gets
 *   an evidence_changed review at once ("转发-差旅费管理办法 repeats 差旅费管理办法, which
 *   changed").
 * - On claims.updated, it keeps the knowledge class of each current claim and the day each
 *   plan names (the claim's valid_time start). The shortest review interval among the
 *   classes sets the document's next ttl review; a plan day still ahead gets an assumption
 *   review on that day.
 * - tick(tenant) publishes every review that has fallen due, each once; the engine calls it
 *   once a day. Each review carries a dedupe_key per document and kind
 *   ("freshness:ttl:<document>"), so repeated ones merge into one todo.
 * - staleness(tenant, units) scores current source versions and claims: age against the
 *   review interval, a document it repeats having changed, a plan day having come.
 *
 * Archived documents and dated records (front matter date: minutes, reports) are never due,
 * by age or by their plans: a record is true as of its day, and later records say what
 * became of its plans. Delivery is at least once: the inbox mark commits with the records, a
 * version older than the one kept changes nothing, and a published review is not scheduled
 * again for the same version. Handlers and ticks of one tenant run one at a time in a
 * process; run one freshness consumer per tenant.
 *
 * Not built yet: dependency edges and artifact.dirty with early cutoff (with the page
 * compiler, the first component that builds from claims), verification expiry, learning
 * from a todo that a person reviewed a document without editing it, and contradiction in
 * the score.
 */

export * from "./freshness.ts";
export * from "./migrations.ts";
export * from "./rules.ts";
