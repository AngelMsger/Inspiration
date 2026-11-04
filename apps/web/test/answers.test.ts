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

test("a sentence citing every line of one passage marks its document once", () => {
  const citations = [line("A", 1), line("A", 2), line("A", 3), line("B", 1)];
  const { parts, documents } = readAnswer(
    answerOf("Hotels cost 650. [1][2][3][4] Directors claim cost. [2]", citations),
  );
  expect(parts).toEqual([
    { text: "Hotels cost 650." },
    { marks: [1, 2] },
    { text: " Directors claim cost." },
    { marks: [1] },
  ]);
  expect(documents.map((d) => [d.first.source_title, d.first.quote, d.lines])).toEqual([
    ["Document A", "Line 1 of A.", 3],
    ["Document B", "Line 1 of B.", 1],
  ]);
});

test("documents are numbered as the answer first cites them, a sentence's marks in order, unknown ones left out", () => {
  const citations = [line("A", 1), line("B", 1)];
  const { parts, documents } = readAnswer(answerOf("First. [2] Then. [1][9] Last. [1][2]", citations));
  expect(parts).toEqual([
    { text: "First." },
    { marks: [1] },
    { text: " Then." },
    { marks: [2] },
    { text: " Last." },
    { marks: [1, 2] },
  ]);
  expect(documents.map((d) => d.first.source_title)).toEqual(["Document B", "Document A"]);
});
