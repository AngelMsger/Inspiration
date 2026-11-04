// An answer on the ask page: each document it cites once, numbered as the answer first cites
// it, and a sentence's marks naming documents, however many of their lines it cites.

import type { Citation, GroundedAnswer } from "@inspiration/contracts";
import { expect, test } from "vitest";
import { readAnswer } from "../src/answers.ts";

const line = (version: string, n: number): Citation => ({
  span_id: `spn_${version}${n}`,
  source_version_id: `sv_${version}`,
  source_title: `Document ${version}`,
  quote: `Line ${n} of ${version}.`,
});

const answerOf = (text: string, citations: Citation[]): GroundedAnswer => ({
  answer_id: "req_1",
  answer: text,
  citations,
  confidence: 0.8,
  gaps: [],
  token_estimate: 10,
});

/** The marks of each run of marks: the document's number, and the line the mark opens. */
const marksOf = (text: string, citations: Citation[]) =>
  readAnswer(answerOf(text, citations)).parts.flatMap((p) =>
    "marks" in p ? [p.marks.map((m) => `${m.n}:${m.cited.span_id}`)] : [],
  );

test("a sentence citing every line of one passage marks its document once", () => {
  const citations = [line("A", 1), line("A", 2), line("A", 3), line("B", 1)];
  const text = "Hotels cost 650. [1][2][3][4] Directors claim cost. [2]";
  const { parts, documents } = readAnswer(answerOf(text, citations));
  expect(parts.filter((p) => "text" in p)).toEqual([{ text: "Hotels cost 650." }, { text: " Directors claim cost." }]);
  expect(marksOf(text, citations)).toEqual([["1:spn_A1", "2:spn_B1"], ["1:spn_A2"]]);
  expect(documents.map((d) => [d.first.source_title, d.first.quote, d.lines])).toEqual([
    ["Document A", "Line 1 of A.", 3],
    ["Document B", "Line 1 of B.", 1],
  ]);
});

test("a mark opens the line its own sentence cites, not the document's first", () => {
  const citations = [line("A", 1), line("A", 2)];
  expect(marksOf("First. [1] Second. [2]", citations)).toEqual([["1:spn_A1"], ["1:spn_A2"]]);
});

test("documents are numbered as the answer first cites them, a sentence's marks in order, unknown ones left out", () => {
  const citations = [line("A", 1), line("B", 1)];
  const text = "First. [2] Then. [1][9] Last. [1][2]";
  expect(marksOf(text, citations)).toEqual([["1:spn_B1"], ["2:spn_A1"], ["1:spn_B1", "2:spn_A1"]]);
  const { documents } = readAnswer(answerOf(text, citations));
  expect(documents.map((d) => d.first.source_title)).toEqual(["Document B", "Document A"]);
});
