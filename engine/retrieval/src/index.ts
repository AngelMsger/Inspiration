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
 * - Each chunk carries the principal tokens of its document's latest captured ACL
 *   (access-control's aclTokens), and an acl.changed rewrites them.
 * - The duplicates blocks.changed reports are kept as editions of one text, each way
 *   (retrieval.editions): a copy, an older revision, last year's policy in a downloads
 *   folder. A document's report replaces the pairs it named before; pairs another document
 *   named against an earlier version of it go too.
 *
 * search(query, principal):
 * - The vector and keyword indexes each return their best rows under the principal's
 *   permission filter (spaces, ACL tokens, clearance), and reciprocal rank fusion merges
 *   them. Every chunk is checked again against the document's permission before it is used.
 * - The current statements those chunks quote join them, when the principal may read the
 *   statement (access control's derived-knowledge rule). A statement cites only evidence in
 *   documents the principal can read now; hidden support is never cited or named.
 * - The reranker orders statements and passages together. A statement that fills a fact
 *   slot is marked with where its value stands with governance (holds, outdated, disputed,
 *   differs) and, when it is not the value that holds, the statement that is. Outdated
 *   values rank lower. Hits carry freshness from the freshness engine, a snippet of about
 *   80 tokens and a token estimate of the whole item; token_budget cuts the list.
 *
 * answer(query, principal) searches with the question and asks the model
 * (retrieval.answer_question) to answer from the best passages and, beside them, the best
 * statements only (ANSWER_SOURCES of each, so a statement never takes a passage's place),
 * every sentence citing them; passages are given sentence by sentence. A statement found
 * whose value does not hold brings the statement of the one that does, which the model is
 * pointed to, in whatever language it is written. So does a passage's sentence that states
 * such a value, through its statement, which joins marked; a sentence that only states
 * replaced values is left out of its passage. A sentence of the answer that cites nothing
 * given is dropped, and one that quotes some of a passage's sentences cites those. Notes in
 * the question's language, on the values the answer gives, say when sources differ and a
 * person has yet to decide, and when a source found states a replaced value; another says
 * when a statement rests on one weakly read source. sources(query, principal) gives the
 * hits an answer reads, in the order the model gets them.
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
 * Baselines, to measure the knowledge base against over the same documents and model
 * (RetrievalOptions.baseline): "passages" answers from passages alone, without statements
 * or governance, as plain retrieval over chunks does; "long_context" gives the model every
 * passage the asker may read, document by document, and refuses with ContextTooLong when
 * they come to more than contextTokens.
 *
 * Not built yet: indexes of pages, procedures and entities (hits are statements and
 * passages), a full-text index per language, FAQ precompute, the semantic cache, values in
 * notes written the question's way (they are the catalogue's: "5000 node"), and saying an
 * answer may be incomplete because material the asker cannot read would change it
 * (docs/design/compiled-knowledge-permissions.md), and editions of a renamed document,
 * which normalization does not pair unless nearly the same.
 */

export * from "./chunks.ts";
export * from "./migrations.ts";
export * from "./mock.ts";
export * from "./protocol.ts";
export * from "./retrieval.ts";
export { overlap, terms } from "./text.ts";
