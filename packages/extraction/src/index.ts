/**
 * Knowledge extraction: claims with verbatim evidence from the blocks normalization
 * changed.
 *
 * On blocks.changed it reads the version's added and changed blocks in reading order and
 * cuts them into windows of about WINDOW_CHARS characters. Each window is one model call,
 * extraction.extract_claims, through the model gateway. The call carries the version's
 * sensitivity and the budget key tenant:<id>/extraction, and offers only the catalogue
 * entries whose aliases occur in the window. Passages go to the model under local
 * references ("s1"), so it can only cite spans it was given. Each table row goes with its
 * table's header row.
 *
 * A returned claim is kept when at least one quote is verbatim from its span. It is true
 * from the day its passage says it takes effect, else from the version's effective_from
 * (front matter), else from an open start. Its ID depends on the prompt version, the
 * statement and the cited spans, so extracting the same text again gives the same claims,
 * and a block edit leaves the claims of its unchanged sentences alone. A claim whose every supporting span the version removed is closed:
 * - superseded by a new claim of the same slot (predicate and qualifiers);
 * - else superseded by the most similar new statement cut from the same block, at
 *   SAME_CLAIM or above;
 * - else retracted.
 * A new claim that cites exactly the spans of a current one restates it (a changed table
 * header re-reads its rows) and supersedes it. New and closed claims commit with one
 * claims.updated (origin "extracted"); superseded lists the retracted ones too.
 *
 * Until real models are configured, the fake provider answers through the mock in
 * mock.ts, a model_mocks plugin.
 *
 * Not yet built: entity resolution, SOPs from documents and approval mining, and the
 * artifact.dirty and comment.created subscriptions.
 */

export * from "./extract.ts";
export { effectiveFrom, extractWindow, mockExtractClaims, readValue } from "./mock.ts";
export * from "./protocol.ts";
export * from "./vocabulary.ts";
