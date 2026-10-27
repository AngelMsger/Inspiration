import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hasStack, stackTest, VALKEY_URL } from "@inspiration/testkit";
import { describe, expect, test } from "vitest";
import {
  type CaseResult,
  type Control,
  Corpus,
  controlLines,
  controlReport,
  Engine,
  ingest,
  loadControl,
  SimulatedClock,
  type SlotOutcome,
} from "../src/index.ts";

const CONTROL = fileURLToPath(new URL("../../../examples/control/", import.meta.url));

/**
 * Every case comes out as expected.yaml answers it, or as its engine entry records. A change
 * that closes a gap fails here until the entry goes; one that opens a gap, until one is added.
 */
async function check(stack?: { databaseUrl: string; streamPrefix: string }): Promise<void> {
  const corpus = await Corpus.load(CONTROL);
  const control = (await loadControl(CONTROL)) as Control;
  const blobDir = await mkdtemp(join(tmpdir(), "inspiration-control-"));
  const clock = new SimulatedClock(new Date("2026-10-23T09:00:00Z"));
  const engine = await Engine.open({
    clock: clock.now,
    blobDir,
    resolvePrincipal: corpus.resolvePrincipal,
    vocabulary: () => corpus.vocabulary,
    ...(stack && { databaseUrl: stack.databaseUrl, valkeyUrl: VALKEY_URL, streamPrefix: stack.streamPrefix }),
  });
  try {
    const run = await ingest(engine, corpus);
    expect(run.dead_letters).toBe(0);
    const report = await controlReport(engine, corpus, control);
    for (const c of report.cases) expect(c.observed, c.case).toEqual(c.recorded);
    expect(report.unexpected).toEqual({});
    // The numbers README.md gives.
    expect(report.totals).toEqual({
      cases: 8,
      as_expected: 6,
      as_recorded: 8,
      statements: { expected: 23, in_slot: 22, misplaced: 1 },
      values: { expected: 14, sources_right: 13 },
      slots: { expected: 11, proposed_right: 9, cases_right: 10 },
    });
    // The notice and its two copies are three statements but one source, against two.
    const taxi = report.cases.find((c) => c.case === "reposted-notice");
    expect(taxi?.counts.taxi_cap_per_day).toEqual({
      "40 USD/day": { statements: 3, governed: 3, documents: 3 },
      "45 USD/day": { statements: 2, governed: 2, documents: 2 },
    });
    expect(taxi?.observed.taxi_cap_per_day?.proposed).toBe("45 USD/day");
  } finally {
    await engine.close();
    await rm(blobDir, { recursive: true, force: true });
  }
}

describe("the control corpus", () => {
  test("in memory", async () => {
    await check();
  });

  describe.skipIf(!hasStack())("on the stack", () => {
    stackTest("Postgres with the outbox relayed to Valkey Streams", async ({ databaseUrl, streamPrefix, valkey }) => {
      expect(valkey).toBeDefined(); // removes this run's stream keys afterwards
      await check({ databaseUrl, streamPrefix });
    });
  });
});

describe("the control summary", () => {
  const outcome = (proposed: string): Record<string, SlotOutcome> => ({
    s: { values: { [proposed]: [["a.md"]] }, proposed, cases: {} },
  });
  const result = (name: string, expected: string, recorded: string, observed: string): CaseResult => ({
    case: name,
    group: "g",
    question: "q",
    expected: outcome(expected),
    recorded: outcome(recorded),
    observed: outcome(observed),
    counts: {},
  });

  test("counts each case once, a closed gap whose entry is still there as right", () => {
    const cases = [result("closed", "1", "2", "1"), result("gap", "1", "2", "2"), result("new", "1", "1", "3")];
    const totals = { cases: 3, as_expected: 1, as_recorded: 1 } as const;
    const lines = controlLines({
      cases,
      unexpected: {},
      totals: {
        ...totals,
        statements: { expected: 0, in_slot: 0, misplaced: 0 },
        values: { expected: 0, sources_right: 0 },
        slots: { expected: 0, proposed_right: 0, cases_right: 0 },
      },
    });
    expect(lines[0]).toBe("control: 3 cases, 1 as expected; 1 differ as expected.yaml records, 1 otherwise");
    expect(lines.filter((l) => /^ {2}\S/.test(l) && l.includes(": "))).toEqual(
      expect.arrayContaining(["  right: closed (g). q", "  known gap: gap (g). q", "  differs: new (g). q"]),
    );
  });
});

describe("expected.yaml", () => {
  test("an engine entry for a slot the case does not expect is refused", async () => {
    const dir = await mkdtemp(join(tmpdir(), "inspiration-control-"));
    try {
      await writeFile(
        join(dir, "expected.yaml"),
        [
          "cases:",
          "  - {case: c, group: g, question: q, slots: {a: {values: {}}},",
          "     engine: {why: w, slots: {b: {proposed: x}}}}",
        ].join("\n"),
      );
      await expect(loadControl(dir)).rejects.toThrow(/engine entry for b/);
      await writeFile(join(dir, "expected.yaml"), "cases: [{case: c}]\n");
      await expect(loadControl(dir)).rejects.toThrow(/invalid expected.yaml/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a corpus without one has no control check", async () => {
    expect(await loadControl(join(CONTROL, "policies"))).toBeUndefined();
  });
});
