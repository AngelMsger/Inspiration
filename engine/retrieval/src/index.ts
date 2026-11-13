/**
 * Retrieval: search and grounded answers over what a member may read.
 *
 * Indexing (consumer group "retrieval"):
 * - On blocks.changed, the document's latest version is cut into chunks (chunks.ts): its
 *   blocks in reading order with the headings above them, about 400 to 800 tokens each.
 *   A new chunk gets a contextual header from the model (retrieval.write_context) and an
 *   embedding of its header, heading path and text, both through the model gateway with the
 *   version's sensitivity and the budget key tenant:<id>/retrieval. A chunk an edit left
 *   unchanged keeps its ID, header and embedding; chunks of the previous version that are
 *   gone are removed, and a deleted document's chunks with them. A late event of an older
 *   version changes nothing.
 * - Index work is persisted before model calls. indexing() reports unfinished work; resume()
 *   retries it after outages, budget resets or restart, optionally scoped to one source.
 *   Successful newer versions and tombstones supersede failed older work.
 * - Each chunk carries its tenant's tokens (access-control's chunkTokens). Who may read it
 *   comes from its space; source ACLs decide nothing.
 * - The duplicates blocks.changed reports are kept as editions of one text, each way
 *   (retrieval.editions): a copy, an older revision, last year's policy in a downloads
 *   folder. A document's report replaces the pairs it named before; pairs another document
 *   named against an earlier version of it go too.
 *
 * search(query, principal):
 * - The vector and keyword indexes each return their best rows under the principal's
 *   permission filter (spaces, the tenant's token, clearance), for the question and for its
 *   translations into the other languages retrieval has packs for (retrieval.translate_question,
 *   asked while the question itself is searched), and reciprocal rank fusion merges them all.
 *   Without a model to translate it, the question searches alone. Every chunk is checked
 *   again against the document's permission before it is used.
 * - The current statements those chunks quote join them, when the principal may read the
 *   statement (access control's derived-knowledge rule). A statement cites only evidence in
 *   documents the principal can read now; hidden support is never cited or named.
 * - The reranker orders statements and passages together, in a request labelled as the
 *   most sensitive of them, so the gateway sends it only to a provider cleared for that;
 *   with none cleared the fused order stands. A statement that fills a fact slot is marked
 *   with where its value stands with governance (holds, outdated, disputed, differs) and,
 *   when it is not the value that holds, the statement that is. The principal sees a
 *   verdict only as far as they may read its values: a value with no statement they may
 *   read is left out, a contradiction stands only between values left, and without the
 *   value that holds the slot is unmarked, so a hidden value shows through no mark, note
 *   or ID. Outdated values rank lower. Hits carry freshness from the freshness engine, a snippet of about
 *   80 tokens and a token estimate of the whole item; token_budget cuts the list.
 *
 * answer(query, principal) searches with the question and asks the model
 * (retrieval.answer_question) to answer from the best passages and, beside them, the best
 * statements only (ANSWER_SOURCES of each by default, so a statement never takes a passage's
 * place), every sentence citing them. RetrievalOptions.answerSources sets how many of each: a
 * compact answer (COMPACT_SOURCES) reads mostly statements, the conclusions governance kept,
 * and two passages, about half the input, for a smaller, faster model. A passage is given whole, sentence by sentence, where a search
 * hit shows only its snippet: a snippet is picked by the words it shares with the question,
 * so it misses the answer when the two are in different languages or say it differently. It
 * comes with its document's governance level and the day the document last changed, so that
 * where passages disagree and no statement settles it, the model answers with the governed
 * source, then the most recent, and says that sources differ. Both sides of a disagreement no
 * person has settled are marked in what the model reads: each statement names the statements
 * of the other values, and each passage the statements its lines state, so the answer gives
 * the value that holds, says that sources differ and gives the other values. A statement found
 * whose value does not hold brings the statement of the one that does, which the model is
 * pointed to, in whatever language it is written, when it passes the question's filters,
 * with its own freshness. So does a passage's sentence that states
 * such a value, through its statement, which joins marked; a sentence that only states
 * replaced values is left out of its passage. A sentence of the answer that cites nothing
 * given is dropped, and one that quotes some of a passage's sentences cites those. Notes in
 * the question's language, on the values the answer gives, say when sources differ and a
 * person has yet to decide, and when a source found states a replaced value, each also
 * naming the value that holds, the other values and the documents as data, so a screen can
 * say them in its reader's words; another says when a statement rests on one weakly read
 * source. sources(query, principal) gives the
 * hits an answer reads, in the order the model gets them.
 *
 * Every answer is recorded in retrieval.answers (metering.ts), for usage: when it was asked,
 * how long it took from the question to the answer, search included, each model call it made
 * with its provider, model, tokens and cost, and their cost together, the member it was for
 * (an agent's member, with the agent), the spaces of the sources it read and how many sources
 * it read; never the question or the answer. A record that cannot be written is logged, and
 * the answer is still given. In the gateway's ledger every model call of a search or an answer
 * is charged to that member (member_id), and the calls that index a document, its contextual
 * headers and embeddings, to the document's space (space_id).
 *
 * An answer reads the latest edition of a document the asker can read. An edition replaces
 * another when it changed later, by the dates its source gives, at no lower governance level
 * and authority, through editions of editions as far as they chain: a newer draft in
 * someone's folder never replaces the governed policy, and an edition the asker cannot read
 * replaces nothing. A replaced edition's passages are left out before the best are taken,
 * and so are statements only replaced editions state, in a fact slot or not, since a value
 * that left the latest edition is no longer stated; the value that holds in place of such a
 * statement still joins. search() still lists every edition.
 *
 * annotations(version, principal) gives the Annotated view of one version of a document:
 * every current statement resting on its spans that the asker may read, marked as search
 * marks it and in the document's reading order, with the statements that hold in place of
 * the outdated and disputed ones, wherever they are stated. A document the asker may not
 * read has no marks. statementsOf(claims, principal) gives the current statements with
 * those IDs that the asker may read, marked the same way and in the order asked, with the
 * statements that hold instead: what a todo asks a person to choose between, or what a topic
 * holds.
 *
 * Baselines, to measure the knowledge base against over the same documents and model
 * (RetrievalOptions.baseline): "mature" answers from passages alone, without statements or
 * governance, as a carefully built RAG does: the same search (hybrid, translated, reranked,
 * over MATURE_POOL passages where the knowledge base reranks RERANK_POOL), MATURE_SOURCES passages, each with its document's level and date; "long_context" gives
 * the model every passage the asker may read in the spaces asked for, document by document,
 * and refuses with ContextTooLong when they come to more than contextTokens. The query's
 * filters are on statements, so neither baseline applies them.
 *
 * readAll answers the way the long-context baseline reads, after governance: every passage
 * the asker may read, without replaced editions and without the sentences that state only
 * values that no longer hold, each such value marked with the one that holds beside it, as
 * an answer from search reads what it found; ContextTooLong when that comes to more than
 * contextTokens. It is measured against the long-context baseline: governance must never
 * leave an answer worse than the raw documents. It works it all out again for each question.
 *
 * Not built yet: indexes of pages, procedures and entities (hits are statements and
 * passages), a full-text index per language, FAQ precompute, the semantic cache, values in
 * notes written the question's way (they are the catalogue's: "5000 node"), and saying an
 * answer may be incomplete because material the asker cannot read would change it
 * (docs/design/compiled-knowledge-permissions.md), and editions of a renamed document,
 * which normalization does not pair unless nearly the same.
 *
 * A readOnUse callback may read authorized citations before composing an answer. When it
 * requests a refresh, sources are retrieved again through the same authorization and
 * standing rules. Compact and standard answers share this path, inside answer timing;
 * reading keeps its component's model budget. No callback is used by the rival baselines.
 */

export {
  ANSWER_SOURCES,
  type AnswerSources,
  COMPACT_SOURCES,
  ContextTooLong,
  LONG_CONTEXT_TOKENS,
  MATURE_SOURCES,
  THIN,
} from "./answers.ts";
export * from "./chunks.ts";
export { DOCUMENTS, EDITIONS, type Edition, EMBED_BATCH, type IndexedDocument } from "./indexing.ts";
export { ANSWERS, type AnswerCall, type AnswerRecord } from "./metering.ts";
export * from "./migrations.ts";
export * from "./mock.ts";
export * from "./protocol.ts";
export * from "./retrieval.ts";
export { type Baseline, POOL, RERANK_POOL, RRF_K, STATEMENT_POOL } from "./search.ts";
export { overlap, terms } from "./text.ts";
