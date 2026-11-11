/**
 * Knowledge extraction: claims with verbatim evidence from the blocks normalization
 * changed.
 *
 * On blocks.changed it reads the version's added and changed blocks in reading order and
 * cuts them into windows of about WINDOW_CHARS characters. Each window is one model call,
 * extraction.extract_claims, through the model gateway. The call carries the version's
 * sensitivity and the budget key tenant:<id>/extraction, is charged to the version's space
 * (space_id) in the gateway's ledger, and offers only the catalogue
 * entries whose aliases occur in the window. Passages go to the model under local
 * references ("s1"), so it can only cite spans it was given. Each table row goes with its
 * table's header row.
 *
 * How much of a version is read depends on its governance level:
 * - governed: every added and changed block.
 * - reference: only the blocks that name a catalogue fact (an alias in the text, the
 *   headings or the table header), and of their claims only those that fill a slot; the
 *   rest are counted as unused. extractOnUse(version, blocks), for a page or an answer that
 *   cites a passage, reads those blocks in full. extractCitations(tenant, citations) resolves
 *   blocks in the cited version, since an unchanged span retains its original version ID.
 *   Explicit tenant vocabulary takes precedence over discovered entries and is never saved
 *   as discovery state. Discovered predicate and qualifier aliases accumulate across reads.
 *   An optional onCommitted handler receives the original committed claims.updated event
 *   before another on-use read of the document proceeds; background delivery still applies
 *   the same event idempotently.
 * - search_only: nothing.
 *
 * A returned claim is kept when at least one quote is verbatim from its span. It is true
 * from the day its passage says it takes effect (a plan: the day it is planned for), else
 * from the version's effective_from (front matter), else from an open start. Its ID depends
 * on the prompt version, what the claim says (statement, subject, predicate, value,
 * qualifiers, type and class) and the cited spans, so extracting the same text again gives
 * the same claims, and a block edit leaves the claims of its unchanged sentences alone. A
 * model's fit to the catalogue is held to it first (fitToCatalogue): a value is written the
 * one way governance compares ("300 USD/night"), a qualifier may be named by one of its
 * words, and a fit the catalogue does not allow (another unit, an unknown qualifier, an
 * unlisted enum value) is dropped and counted as unfit, the claim kept without a slot. A
 * claim with a predicate gets its slot_key (subject entity, predicate and qualifiers). A
 * claim that was closed and is stated again (a value changed back, a document restored) is
 * a new occurrence with an ID from the version, so the earlier interval stays as it was. A
 * claim the version no longer states (it removed one of the claim's supporting spans, does
 * not state the claim again, and holds none of its other spans in a passage it did not read
 * again, so a table row whose value cell changed no longer states the old value) is:
 * - superseded by a new claim of the same slot (predicate and qualifiers);
 * - else superseded by the most similar new statement cut from the same block, at
 *   SAME_CLAIM or above;
 * - else superseded by a current claim of the same slot that the version still states where
 *   it did not change, of the same value when there is one: a fact the document stated twice
 *   is still stated when one of the two places goes;
 * - else, when it states a fact (a slot and a value) or the version deletes the document,
 *   kept current and marked unstated (Claim.unstated), because knowledge never disappears
 *   silently (docs/design/source-changes.md, rules 1 and 3);
 * - else retracted: prose the version rewrote or dropped, which its pages follow.
 * A claim marked unstated is restored (the mark is removed) when a later version states it
 * again, and superseded when a later version fills its slot with another claim. One todo per
 * document lists the claims marked unstated, for its owner to keep or retire them: kind
 * unstated, or source_deleted once the document is deleted (dedupe_key
 * "extraction:<kind>:<source>:<document>"); it is updated as the list changes and withdrawn
 * when the list is empty.
 * A new claim that cites exactly the spans of a current one restates it (a changed table
 * header re-reads its rows, a renamed heading changes the subject) and supersedes it. New,
 * closed, marked and restored claims commit with one claims.updated (origin "extracted"):
 * superseded lists the retracted ones too, and updated the marked and restored ones.
 *
 * Extraction keeps the latest version of each document it has worked on (the
 * extraction.documents table). A version older than that, delivered again late, changes
 * nothing, so a redelivery cannot reopen what a later version closed. The mark also says how
 * far reading the version has come (documents(tenant)): reading until it is read to the end,
 * then read. When a model call meets a spent budget or a model out of reach
 * (budget_exceeded, provider_error, timeout), reading stops and writes nothing: the event is
 * done with, and the mark is paused, keeping the change left to read, when it stopped first,
 * and why. resume() reads the paused documents on, the earliest stop first, and leaves a
 * company's others for the next call once one of them stops again, since they share its
 * budget. A later version that comes while a document is paused is read with what the pause
 * left, so a passage only the earlier version added is not skipped. The gateway's reply
 * cache makes the windows read before the stop cost nothing the second time. Cited blocks
 * read on use (extractOnUse) leave a pause as it was; there a spent budget is an error.
 *
 * Until real models are configured, the fake provider answers through the mock in
 * mock.ts, a model_mocks plugin.
 *
 * Not yet built: entity resolution, SOPs from documents and approval mining, the
 * artifact.dirty and comment.created subscriptions, reading a document again when its level
 * changes without a new version, and what keeping or retiring unstated claims does.
 */

export * from "./extract.ts";
export * from "./migrations.ts";
export { effectiveFrom, extractWindow, mockExtractClaims, plannedFor, readValue } from "./mock.ts";
export * from "./protocol.ts";
export * from "./vocabulary.ts";
