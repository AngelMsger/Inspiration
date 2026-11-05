/**
 * Stand-ins for a model on retrieval's three tasks, registered as model_mocks plugins so the
 * fake provider answers them deterministically.
 *
 * retrieval.write_context names the document and the headings above each part ("Travel
 * policy: Lodging › Tier-one cities."), in the document's language. A model also says what
 * the document is about where its title does not.
 *
 * retrieval.answer_question keeps the sentences of the sources (a statement, or a line of
 * a passage) that share most of the question's words, statements before passages and never
 * an outdated value, and answers with up to three of them as written, each citing its
 * source. An outdated value found gives its place to the one that holds, which may be
 * written in another language. A statement picked that is one side of a disagreement brings
 * the statements of the other values after it, so the answer gives them all. Nothing shared,
 * nothing answered: the question is a gap. A
 * model writes the
 * answer in the question's language, combines sources and reads what a sentence leaves to
 * the next ("the following thresholds:"); the stand-in only shows which sources an answer
 * would rest on.
 *
 * retrieval.translate_question translates nothing, so search runs on the question alone, as
 * it does when no model can translate it.
 */

import type { ChatMessage } from "@inspiration/contracts";
import { languageOf } from "@inspiration/kernel";
import type { MockResponder } from "@inspiration/model-gateway";
import {
  type AnswerInput,
  type AnswerOutput,
  type ContextInput,
  type ContextOutput,
  inputOf,
  type TranslateOutput,
} from "./protocol.ts";
import { fill, overlap, packFor, terms } from "./text.ts";

const textOf = (messages: readonly ChatMessage[]) => messages.map((m) => m.content).join("\n");

export const mockWriteContext: MockResponder = (messages) => {
  const input = inputOf<ContextInput>(textOf(messages));
  if (!input) return JSON.stringify({ headers: [] } satisfies ContextOutput);
  const { title, language } = input.document;
  const headers = input.chunks.map((c) => {
    const pack = packFor(language ?? languageOf(`${title}\n${c.text}`));
    const header = c.heading_path.length
      ? fill(pack.text("context"), { title, path: c.heading_path.join(pack.text("path_mark")) })
      : fill(pack.text("context_title"), { title });
    return { ref: c.ref, header: header.slice(0, 300) };
  });
  return JSON.stringify({ headers } satisfies ContextOutput);
};

/** Sentences sharing less of the question than this are left out. */
const ENOUGH = 0.25;

export const mockAnswerQuestion: MockResponder = (messages) => {
  const input = inputOf<AnswerInput>(textOf(messages));
  const none: AnswerOutput = { sentences: [], gaps: input ? [input.question] : [], confidence: 0 };
  if (!input) return JSON.stringify(none);
  const question = terms(input.question);
  const byRef = new Map(input.sources.map((s) => [s.ref, s]));
  const scored = input.sources
    .flatMap((s) =>
      s.text
        .split("\n")
        .filter((line) => line.trim())
        .flatMap((line) => {
          const score = overlap(question, `${s.title}\n${line}`);
          if (s.standing !== "outdated") return [{ s, line: line.trim(), score }];
          const held = byRef.get(s.held_ref ?? "");
          return held ? [{ s: held, line: held.text.trim(), score }] : [];
        }),
    )
    .filter((x) => x.score >= ENOUGH)
    .sort(
      (a, b) =>
        b.score - a.score ||
        Number(b.s.kind === "statement") - Number(a.s.kind === "statement") ||
        Number(b.s.standing === "holds") - Number(a.s.standing === "holds") ||
        Number(a.s.ref) - Number(b.s.ref),
    );
  // Each sentence once: a statement and the passage it was read from say the same.
  const said = new Set<string>();
  const picked = scored.filter((x) => !said.has(x.line) && said.add(x.line)).slice(0, 3);
  if (!picked.length) return JSON.stringify(none);
  for (const x of [...picked]) {
    for (const ref of x.s.disputed_with ?? []) {
      const other = byRef.get(ref);
      const line = other?.text.trim();
      if (other && line && !said.has(line) && said.add(line)) picked.push({ s: other, line, score: x.score });
    }
  }
  const output: AnswerOutput = {
    sentences: picked.map((x) => ({ text: x.line, sources: [x.s.ref] })),
    gaps: [],
    confidence: Math.min(0.9, 0.4 + 0.5 * (picked[0]?.score ?? 0)),
  };
  return JSON.stringify(output);
};

export const mockTranslateQuestion: MockResponder = () =>
  JSON.stringify({ translations: [] } satisfies TranslateOutput);
