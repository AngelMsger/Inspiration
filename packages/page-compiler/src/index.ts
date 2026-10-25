/**
 * Page compiler. Built so far: the knowledge outline, which is the topics of each space and
 * where each statement sits in them.
 *
 * Sections are the blocks under one heading path of a document, with the current claims
 * that rest on their spans. A claim citing several sections belongs to the first in reading
 * order. On claims.updated, page-compiler reads the document's latest version again and
 * keeps its sections (the page_compiler.sections table).
 * - A section of a current governed document gets an embedding: its deepest heading's
 *   embedding plus its text's (the heading path and the first EMBED_CHARS characters),
 *   normalized, through the model gateway with the document's sensitivity and the budget
 *   key tenant:<id>/page-compiler. A new or changed one joins the nearest topic at `join`
 *   similarity or more, or stays unfiled (未归类) until the next re-clustering.
 * - A statement with a fact slot goes to the topic most of the slot's statements are in,
 *   from any section of the space. Statements of reference documents are placed only that
 *   way, and those of archived and search-only documents not at all.
 * - Placements of statements the document no longer states are removed, and the topics'
 *   statement counts change with them in the same transaction. The update reads the
 *   document as it is now, so a late or repeated delivery changes nothing.
 * - The new sections commit first, together with the store writes they call for
 *   (page_compiler.pending, with absolute counts). If the store writes then fail, the
 *   tenant's next update or re-clustering finishes them before it reads anything.
 *
 * recluster(tenant) clusters every space's governed sections again (cluster.ts), starting
 * from the last run's topics, and places every statement. It goes through these steps:
 * - Keys stay stable: a section stays in its topic while it is at least `keep` similar to
 *   it. A new topic's key comes from the section or topic that seeded it, and retired keys
 *   are never reused.
 * - Topics have at most three levels: areas, topics and subtopics. A topic splits when it
 *   holds more than maxStatements statements and its sections differ enough. Below
 *   minStatements it is dissolved, and its statements are unfiled.
 * - At most `budget` of the statements placed before move to another topic that still
 *   exists. The moves that gain least wait for a later run.
 * - New topics are named by the model, on page-compiler.name_topics, 20 per call, from the
 *   bottom up: subtopics, then topics, then areas, so a topic with topics below it is named
 *   after them. A topic the model leaves out takes its commonest heading.
 * - Topics written to the knowledge store are proposed until an owner confirms them, and
 *   retired when they have no statements left.
 * - A topic an owner confirmed, or one that holds a confirmed placement, is never dissolved
 *   or retired, even as the last subtopic of a split, and confirmed placements and those a
 *   page or a person made never move.
 * - A topic keeps its owner (owner_id) through re-clustering. The business layer names
 *   owners; setOwner(tenant, topic, member) keeps one, and documentsIn(tenant) lists the
 *   documents each topic holds, with their sections and statements, to choose from.
 * The knowledge store is written before page-compiler's own records. After a crash in
 * between, the next run starts again from the earlier topics and retires the ones the
 * interrupted run proposed.
 *
 * Until real models are configured, the fake provider names topics through the mock in
 * mock.ts, a model_mocks plugin. Its embeddings are hashed character n-grams, so topics
 * follow shared headings and wording rather than meaning.
 *
 * Not yet built: pages (PageSpec synthesis with citations, page snapshots and
 * page.rendered), diagram compilers, the artifact.dirty subscription, and moving a
 * statement's placement when a page cites it.
 */

export * from "./cluster.ts";
export * from "./headings.ts";
export * from "./migrations.ts";
export { mockNameTopics } from "./mock.ts";
export * from "./protocol.ts";
export * from "./topics.ts";
