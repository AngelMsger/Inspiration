/**
 * The benchmark rivals answers are measured against, over a running engine's own documents,
 * indexes and model: a mature RAG without statements or governance, a model reading every
 * document raw, and the knowledge base reading every document after governance.
 */

import type { Citation } from "@inspiration/contracts";
import type { Corpus, Engine } from "@inspiration/engine";
import { ContextTooLong, Retrieval } from "@inspiration/retrieval";
import type { InputSource } from "./audit.ts";

export interface Rivals {
  readonly mature: Retrieval;
  readonly long_context: Retrieval;
  readonly governed_long_context: Retrieval;
}

export interface RivalsOptions {
  /** The most a long-context answer reads, raw or governed, in tokens; LONG_CONTEXT_TOKENS unless given. */
  contextTokens?: number;
  /** Prebuilt rivals (or test doubles) instead of constructing them from the engine. */
  rivals?: Rivals;
}

/** Builds the three benchmark rival Retrieval instances over a running engine's store and indexes. */
export function rivalsOf(engine: Engine, options: RivalsOptions = {}): Rivals {
  if (options.rivals) return options.rivals;
  const indexes = {
    store: engine.store,
    records: engine.records,
    models: engine.models,
    authz: engine.authz,
    vectors: engine.vectors,
    keywords: engine.keywords,
    clock: engine.clock,
  };
  const context = options.contextTokens !== undefined ? { contextTokens: options.contextTokens } : {};
  return {
    mature: new Retrieval({ ...indexes, baseline: "mature" }),
    long_context: new Retrieval({ ...indexes, baseline: "long_context", ...context }),
    governed_long_context: new Retrieval({
      ...indexes,
      verdicts: engine.governance,
      staleness: engine.freshness,
      readAll: true,
      ...context,
    }),
  };
}

export type LongContextInputs = { raw: InputSource[] | null; governed: InputSource[] | null };

/**
 * What raw and governed long context give their models, for the evidence audit, by topic; each
 * null when the documents do not fit the context. Every document of a question's topic the reader
 * may read, so the same for each question of it: read once per topic, with no model call.
 */
export async function longContextInputs<Q extends { question: string; spaces?: string[] }>(
  rivals: Rivals,
  corpus: Corpus,
  questions: readonly Q[],
  pathsOf: (citations: readonly Citation[]) => Promise<string[]>,
): Promise<{ of: (q: Q) => LongContextInputs; all: LongContextInputs[] }> {
  /** What a long context gives its model, of the spaces asked for or all; null when the documents do not fit. */
  const inputOf = async (retrieval: Retrieval, question: string, spaces?: string[]): Promise<InputSource[] | null> => {
    try {
      const hits = await retrieval.sources({ question, ...(spaces && { space_ids: spaces }) }, corpus.reader);
      return await Promise.all(
        hits.map(async (h) => ({
          text: h.snippet,
          documents: await pathsOf(h.citations),
          ...(h.standing && { standing: h.standing, unit: h.unit_id }),
          ...(h.held_unit_id && { held: h.held_unit_id }),
        })),
      );
    } catch (e) {
      if (e instanceof ContextTooLong) return null;
      throw e;
    }
  };
  const topicOf = (q: Q) => q.spaces?.join(" ") ?? "";
  const inputs = new Map<string, LongContextInputs>();
  for (const q of questions) {
    if (inputs.has(topicOf(q))) continue;
    inputs.set(topicOf(q), {
      raw: await inputOf(rivals.long_context, q.question, q.spaces),
      governed: await inputOf(rivals.governed_long_context, q.question, q.spaces),
    });
  }
  return { of: (q) => inputs.get(topicOf(q)) as LongContextInputs, all: [...inputs.values()] };
}
