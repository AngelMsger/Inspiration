// What the ask page makes of an answer: its text with each sentence's marks, and the documents
// those marks cite. An answer cites lines of passages, and a sentence that puts a passage in
// other words, as a real model does, cites every line of it; so the reader sees each document
// once, numbered in the order the answer first cites it, and a sentence's marks name documents.
// A mark still opens the first line its own sentence cites there, not the document's first.

import type { Citation, GroundedAnswer } from "@inspiration/contracts";

/** A document an answer cites: the first line it cites there, and how many lines in all. */
export interface CitedDocument {
  first: Citation;
  lines: number;
}

/** A document a sentence cites, by its number from 1, and the first line the sentence cites there. */
export interface Mark {
  n: number;
  cited: Citation;
}

/** A run of the answer's text, or the documents the sentence before it cites. */
export type AnswerPart = { text: string } | { marks: Mark[] };

export function readAnswer(answer: GroundedAnswer): { parts: AnswerPart[]; documents: CitedDocument[] } {
  const documents: CitedDocument[] = [];
  const numberOf = new Map<string, number>();
  const counted = new Set<string>();
  const parts: AnswerPart[] = [];
  // The answer marks a sentence's citations as [n], counting from 1.
  for (const [i, piece] of answer.answer.split(/\s*\[(\d+)\]/).entries()) {
    if (i % 2 === 0) {
      if (piece) parts.push({ text: piece });
      continue;
    }
    const cited = answer.citations[Number(piece) - 1];
    if (!cited) continue;
    let n = numberOf.get(cited.source_version_id);
    if (n === undefined) {
      n = documents.push({ first: cited, lines: 0 });
      numberOf.set(cited.source_version_id, n);
    }
    const line = `${cited.span_id}|${cited.quote}`;
    if (!counted.has(line)) {
      counted.add(line);
      (documents[n - 1] as CitedDocument).lines += 1;
    }
    const last = parts.at(-1);
    if (last && "marks" in last) {
      if (!last.marks.some((m) => m.n === n)) last.marks.push({ n, cited });
    } else parts.push({ marks: [{ n, cited }] });
  }
  for (const part of parts) if ("marks" in part) part.marks.sort((a, b) => a.n - b.n);
  return { parts, documents };
}
