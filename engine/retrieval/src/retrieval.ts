// The Retriever over one set of options: indexing (indexing.ts), search (search.ts) and answers
// (answers.ts) share the store, the model gateway and the counts. Retrieval's doc comment
// (index.ts) describes the behaviour.

import { fileURLToPath } from "node:url";
import {
  type AnswerQuery,
  type AuthZ,
  type DocumentAnnotations,
  type EventHandler,
  type GroundedAnswer,
  type KeywordIndex,
  type KnowledgeStore,
  type ModelGateway,
  newId,
  type Principal,
  parseAs,
  type Retriever,
  type SearchHit,
  type SearchQuery,
  type SearchResult,
  type SlotVerdicts,
  type StalenessReader,
  type VectorIndex,
} from "@inspiration/contracts";
import type { Records } from "@inspiration/eventbus";
import { PromptRegistry } from "@inspiration/model-gateway";
import { ANSWER_SOURCES, type AnswerSources, Answers, LONG_CONTEXT_TOKENS, MATURE_SOURCES } from "./answers.ts";
import { DOCUMENTS, type IndexedDocument, Indexer } from "./indexing.ts";
import { metered } from "./metering.ts";
import { type Baseline, Search } from "./search.ts";

export { SNIPPET_TOKENS } from "./hits.ts";

const PROMPTS_DIR = fileURLToPath(new URL("../prompts/", import.meta.url));

export interface RetrievalOptions {
  store: KnowledgeStore;
  records: Records;
  models: ModelGateway;
  authz: AuthZ;
  vectors: VectorIndex;
  keywords: KeywordIndex;
  /** Where values stand with governance; without it no hit or answer is marked. */
  verdicts?: SlotVerdicts;
  /** How stale units are; without it every hit is fresh as of now. */
  staleness?: StalenessReader;
  /**
   * Answer the way a rival does, to measure the knowledge base against: "mature" is a
   * carefully built retrieval over the same chunks and search, without statements or
   * governance, reading MATURE_SOURCES passages with their documents' levels and dates;
   * "long_context" is a model that reads every document the asker may read, for corpora that
   * fit.
   */
  baseline?: Baseline;
  /**
   * Answer from everything the asker may read in the spaces asked for, after governance, as
   * the long-context rival reads it raw; for corpora that fit contextTokens.
   */
  readAll?: boolean;
  /** The most the long-context baseline reads for one answer; LONG_CONTEXT_TOKENS by default. */
  contextTokens?: number;
  /**
   * How many passages and statements an answer from search reads; ANSWER_SOURCES of each by
   * default. The mature baseline reads MATURE_SOURCES passages and no statements whatever this
   * says.
   */
  answerSources?: AnswerSources;
  prompts?: PromptRegistry;
  clock?: () => Date;
}

export class Retrieval implements Retriever {
  readonly store: KnowledgeStore;
  readonly records: Records;
  readonly models: ModelGateway;
  readonly authz: AuthZ;
  readonly vectors: VectorIndex;
  readonly keywords: KeywordIndex;
  readonly verdicts: SlotVerdicts | undefined;
  readonly staleness: StalenessReader | undefined;
  readonly baseline: Baseline | undefined;
  readonly readAll: boolean;
  readonly contextTokens: number;
  readonly answerSources: AnswerSources;
  readonly prompts: PromptRegistry;
  readonly clock: () => Date;
  readonly totals = { indexed: 0, chunks: 0, embedded: 0, searches: 0, answers: 0, untranslated: 0 };
  /** Indexes a document's latest version (indexing.ts). */
  readonly onBlocksChanged: EventHandler;
  readonly #search: Search;
  readonly #answers: Answers;

  constructor(options: RetrievalOptions) {
    this.store = options.store;
    this.records = options.records;
    this.models = metered(options.models);
    this.authz = options.authz;
    this.vectors = options.vectors;
    this.keywords = options.keywords;
    this.verdicts = options.verdicts;
    this.staleness = options.staleness;
    this.baseline = options.baseline;
    this.readAll = options.readAll ?? false;
    this.contextTokens = options.contextTokens ?? LONG_CONTEXT_TOKENS;
    this.answerSources = this.baseline
      ? { passages: MATURE_SOURCES, statements: 0 }
      : (options.answerSources ?? { passages: ANSWER_SOURCES, statements: ANSWER_SOURCES });
    if (!Number.isInteger(this.answerSources.passages) || !Number.isInteger(this.answerSources.statements)) {
      throw new RangeError(`answer sources must be whole numbers: ${JSON.stringify(this.answerSources)}`);
    }
    if (
      this.answerSources.passages < 0 ||
      this.answerSources.statements < 0 ||
      this.answerSources.passages + this.answerSources.statements < 1
    ) {
      throw new RangeError(`an answer must read at least one source: ${JSON.stringify(this.answerSources)}`);
    }
    this.clock = options.clock ?? (() => new Date());
    if (options.prompts) this.prompts = options.prompts;
    else {
      this.prompts = new PromptRegistry();
      this.prompts.loadDir(PROMPTS_DIR);
    }
    this.#search = new Search({
      store: this.store,
      models: this.models,
      authz: this.authz,
      vectors: this.vectors,
      keywords: this.keywords,
      verdicts: this.verdicts,
      staleness: this.staleness,
      baseline: this.baseline,
      prompts: this.prompts,
      clock: this.clock,
      totals: this.totals,
    });
    this.#answers = new Answers({
      search: this.#search,
      records: this.records,
      models: this.models,
      prompts: this.prompts,
      clock: this.clock,
      baseline: this.baseline,
      readAll: this.readAll,
      contextTokens: this.contextTokens,
      answerSources: this.answerSources,
      totals: this.totals,
    });
    this.onBlocksChanged = new Indexer({
      store: this.store,
      records: this.records,
      models: this.models,
      prompts: this.prompts,
      totals: this.totals,
    }).onBlocksChanged;
  }

  handlers(): Record<string, EventHandler> {
    return { "blocks.changed": this.onBlocksChanged };
  }

  /** The tenant's indexed documents. */
  async documents(tenantId: string): Promise<IndexedDocument[]> {
    return this.records.find(DOCUMENTS, { tenant_id: tenantId });
  }

  async search(q: SearchQuery, who: Principal): Promise<SearchResult> {
    const query = parseAs<SearchQuery>("SearchQuery", q);
    this.totals.searches++;
    const { hits } = await this.#search.find(query, who);
    let budget = query.token_budget ?? Number.POSITIVE_INFINITY;
    const kept: SearchHit[] = [];
    for (const h of hits) {
      if (h.token_estimate > budget && kept.length) break;
      kept.push(h);
      budget -= h.token_estimate;
    }
    return {
      query_id: newId("request"),
      hits: kept,
      token_estimate: kept.reduce((n, h) => n + h.token_estimate, 0),
    };
  }

  /**
   * The marks of the Annotated view of one version of a document: every current statement
   * resting on the version's spans that the asker may read, marked as search marks it, in the
   * document's reading order; and the statements that hold in place of those outdated or
   * disputed, wherever they are stated. Nothing when the asker may not read the document.
   */
  async annotations(sourceVersionId: string, who: Principal): Promise<DocumentAnnotations> {
    const none: DocumentAnnotations = { source_version_id: sourceVersionId, statements: [], held: [] };
    const version = await this.store.getSourceVersion(sourceVersionId);
    if (!version || version.tenant_id !== who.tenant_id) return none;
    if (!(await this.#search.readableDocuments(who, [version])).has(version.id)) return none;
    const order = new Map<string, number>();
    for (const b of await this.store.blocksOf(sourceVersionId)) for (const id of b.span_ids) order.set(id, order.size);
    const first = (h: SearchHit) =>
      Math.min(...h.citations.map((c) => order.get(c.span_id) ?? Number.POSITIVE_INFINITY));
    const { hits, held } = await this.#search.marked(who, new Map([...order.keys()].map((id) => [id, 1])), (a, b) => {
      return first(a) - first(b) || (a.unit_id < b.unit_id ? -1 : 1);
    });
    return { source_version_id: sourceVersionId, statements: hits, held };
  }

  /**
   * The current statements with these IDs that the asker may read, marked as search marks
   * them, in the order asked, and the statements that hold in place of the outdated and
   * disputed ones: what a todo asks a person to choose between, or what a topic holds. A
   * statement the asker may not read is left out.
   */
  async statementsOf(
    claimIds: readonly string[],
    who: Principal,
  ): Promise<{ statements: SearchHit[]; held: SearchHit[] }> {
    const asked = new Map(claimIds.map((id, i) => [id, i]));
    const evidence = (await this.store.evidenceOf([...asked.keys()])).filter((e) => e.role === "supports");
    const { hits, held } = await this.#search.marked(
      who,
      new Map(evidence.map((e) => [e.span_id, 1])),
      (a, b) => (asked.get(a.unit_id) as number) - (asked.get(b.unit_id) as number),
      (id) => asked.has(id),
    );
    return { statements: hits, held };
  }

  /** The hits an answer to the question reads, in the order the model is given them. */
  async sources(q: AnswerQuery, who: Principal): Promise<SearchHit[]> {
    return (await this.#answers.sources(parseAs<AnswerQuery>("AnswerQuery", q), who)).hits;
  }

  async answer(q: AnswerQuery, who: Principal): Promise<GroundedAnswer> {
    return this.#answers.answer(q, who);
  }
}
