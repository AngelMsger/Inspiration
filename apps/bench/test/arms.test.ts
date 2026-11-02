import type { AnswerQuery, Citation, GroundedAnswer, SearchHit } from "@inspiration/contracts";
import type { Corpus, Engine } from "@inspiration/engine";
import { describe, expect, test } from "vitest";
import { type Question, questionsReport, searchReport } from "../src/index.ts";

// Stand-in answer paths that record what each is asked and give every model the same passage,
// so the reports' own reading of their inputs is what is tested, not search.
type Call = { path: string; op: "sources" | "answer"; query: AnswerQuery };

const citation: Citation = {
  span_id: "spn_01ARMSTEST0000000000000SPAN",
  source_version_id: "srv_01ARMSTEST00000000000VERSION",
  source_title: "Travel policy",
  quote: "Current policy is available.",
};

function stand(model: string, stored: string, calls: Call[]): Engine {
  const hit = { unit_id: "chk_01ARMSTEST000000000000CHUNK", kind: "chunk", snippet: model, citations: [citation] };
  const answer = { answer: model, citations: [citation], confidence: 0.5, gaps: [], token_estimate: 10 };
  const path = (name: string) => ({
    sources: async (query: AnswerQuery) => {
      calls.push({ path: name, op: "sources", query });
      return [hit as unknown as SearchHit];
    },
    answer: async (query: AnswerQuery) => {
      calls.push({ path: name, op: "answer", query });
      return answer as unknown as GroundedAnswer;
    },
  });
  return {
    retrieval: {
      ...path("engine"),
      documents: async () => [{ document: "src_policy:travel.md", chunk_ids: [hit.unit_id], deleted: false }],
      search: async () => ({ hits: [hit] }),
    },
    compact: path("compact"),
    baselines: { mature: path("mature"), long_context: path("long_context") },
    governedLongContext: path("governed_long_context"),
    store: {
      getChunks: async (ids: string[]) => ids.map((id) => ({ id, text: stored })),
      getSourceVersion: async () => ({ source_id: "src_policy", external_id: "travel.md" }),
    },
  } as unknown as Engine;
}

const corpus = {
  reader: { tenant_id: "ten_01ARMSTEST00000000000TENANT" },
  pathOf: (source: string, external: string) => `${source}/${external}`,
} as unknown as Corpus;

const cap: Question = {
  question: "What is the cap?",
  answer: ["650"],
  kind: "changed",
  spaces: ["spc_01ARMSTEST0000000000000TOPIC"],
};

describe("what each answer path is given", () => {
  test("the search check counts an answer found only where its model reads it", async () => {
    // The stored passage states the old cap; governance gave every model a narrower snippet without it.
    const searched = await searchReport(stand("Current policy is available.", "Previous cap was 650.", []), corpus, [
      cap,
    ]);
    expect(searched.totals).toMatchObject({ found: 0, found_whole: 1, found_by_mature: 0, found_compact: 0 });
  });

  test("only the long contexts read the question's topic; every other path searches everything", async () => {
    const calls: Call[] = [];
    await questionsReport(stand("The cap is 650.", "The cap is 650.", calls), corpus, [cap]);
    const scoped = (op: Call["op"]) =>
      Object.fromEntries(calls.filter((c) => c.op === op).map((c) => [c.path, c.query.space_ids ?? null]));
    expect(scoped("answer")).toEqual({
      engine: null,
      compact: null,
      mature: null,
      long_context: cap.spaces,
      governed_long_context: cap.spaces,
    });
    const searchCalls: Call[] = [];
    await searchReport(stand("The cap is 650.", "The cap is 650.", searchCalls), corpus, [cap]);
    expect(
      Object.fromEntries(searchCalls.filter((c) => c.op === "sources").map((c) => [c.path, c.query.space_ids ?? null])),
    ).toEqual({
      engine: null,
      compact: null,
      mature: null,
      long_context: cap.spaces,
      governed_long_context: cap.spaces,
    });
  });
});
