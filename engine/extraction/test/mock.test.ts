import { type ClaimValue, slotOf } from "@inspiration/contracts";
import { testData } from "@inspiration/testkit";
import { describe, expect, test } from "vitest";
import {
  effectiveFrom,
  extractWindow,
  parseVocabulary,
  plannedFor,
  readValue,
  type Vocabulary,
  VocabularyError,
  type WindowInput,
} from "../src/index.ts";

/** Cases in one language, from test/data/<tag>.yaml; en.yaml says what each one checks. */
interface Cases {
  vocabulary: unknown;
  values: { text: string; predicate: string; value: Partial<ClaimValue> | null }[];
  effective: { text: string; day: string | null }[];
  change: { title: string; date: string; heading: string[]; text: string };
  plans: { text: string; document_date?: string; day: string | null }[];
  plan: { title: string; date: string; text: string; day: string };
  window: { title: string; spans: string[]; claims: [string, string, string | null][] };
  clauses: { text: string; statements: string[]; qualifiers: string[] };
  rows: {
    title: string;
    language?: string;
    header: string[];
    cells: string[];
    statement: string;
    slot: string;
    number: number;
  }[];
}

const LANGUAGES = ["en", "ja", "zh"].map((tag) => {
  const cases = testData<Cases>(import.meta.url, `${tag}.yaml`);
  return { tag, ...cases, catalogue: parseVocabulary(cases.vocabulary) };
});

const paragraph = (texts: readonly string[], heading: string[] = []) => ({
  kind: "paragraph",
  heading_path: heading,
  spans: texts.map((text, i) => ({ ref: `s${i + 1}`, text })),
});

describe.each(LANGUAGES)("the extraction mock in $tag", (cases) => {
  const { catalogue } = cases;
  const entry = (predicate: string) =>
    catalogue.predicates.find((p) => p.predicate === predicate) as Vocabulary["predicates"][number];
  const extract = (document: WindowInput["document"], blocks: WindowInput["blocks"]) =>
    extractWindow({ document, vocabulary: catalogue.predicates, blocks });

  test("values are the number before a unit word, or a known enum value", () => {
    for (const { text, predicate, value } of cases.values) {
      if (value) expect(readValue(text, entry(predicate)), text).toMatchObject(value);
      else expect(readValue(text, entry(predicate)), text).toBeUndefined();
    }
  });

  test("a passage's effective day is read in each written form", () => {
    for (const { text, day } of cases.effective) expect(effectiveFrom(text), text).toBe(day ?? undefined);
  });

  test("a change decided without a day takes the document's date", () => {
    const { title, date, heading, text } = cases.change;
    const window = (day?: string) =>
      extract({ title, ...(day && { date: day }) }, [{ ...paragraph([text], heading), kind: "list_item" }]).map(
        (c) => c.valid_from,
      );
    expect(window(date)).toEqual([date]);
    expect(window()).toEqual([undefined]);
  });

  test("a plan takes effect on the day it is planned for, in the document's year when it names none", () => {
    for (const { text, document_date, day } of cases.plans)
      expect(plannedFor(text, document_date), text).toBe(day ?? undefined);
    const { title, date, text, day } = cases.plan;
    const [plan] = extract({ title, date }, [{ ...paragraph([text]), kind: "list_item" }]);
    expect(plan).toMatchObject({ claim_type: "plan", valid_from: day });
  });

  test("passages that state nothing checkable are skipped; the longest alias picks the qualifier", () => {
    const { title, spans, claims: expected } = cases.window;
    const claims = extract({ title }, [paragraph(spans)]);
    expect(claims.map((c) => [c.evidence[0]?.span, c.claim_type, slotOf(c) ?? null])).toEqual(expected);
    expect(claims[1]).toMatchObject({ subject: title, knowledge_class: "general", confidence: 0.7 });
  });

  test("a passage that gives a value in each of its clauses becomes a claim per clause", () => {
    const { text, statements, qualifiers } = cases.clauses;
    const claims = extract({ title: "-" }, [paragraph([text])]);
    expect(claims.map((c) => c.statement)).toEqual(statements);
    expect(claims.map((c) => c.qualifiers?.[0])).toEqual(qualifiers);
    for (const c of claims) expect(text).toContain(c.evidence[0]?.quote);
  });

  test("a table row is a statement of its header and cells, and cites the cells", () => {
    for (const row of cases.rows) {
      const [claim] = extract({ title: row.title, ...(row.language && { language: row.language }) }, [
        {
          kind: "table_row",
          heading_path: [],
          header: row.header,
          spans: row.cells.map((text, i) => ({ ref: `s${i + 1}`, text })),
        },
      ]);
      expect(claim?.statement).toBe(row.statement);
      expect(claim && slotOf(claim)).toBe(row.slot);
      expect(claim?.value?.number).toBe(row.number);
      expect(claim?.evidence.map((e) => e.quote)).toEqual(row.cells);
    }
  });
});

test("a catalogue is validated", () => {
  expect(() =>
    parseVocabulary({ predicates: [{ predicate: "Hotel Cap", label: "x", aliases: [], value: {} }] }),
  ).toThrow(VocabularyError);
});
