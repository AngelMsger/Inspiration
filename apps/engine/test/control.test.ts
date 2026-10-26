import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hasStack, stackTest, VALKEY_URL } from "@inspiration/testkit";
import { describe, expect, test } from "vitest";
import { type Control, Corpus, controlReport, Engine, ingest, loadControl, SimulatedClock } from "../src/index.ts";

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
    const report = await controlReport(engine, corpus, control, run.duplicates);
    for (const c of report.cases) expect(c.observed, c.case).toEqual(c.recorded);
    expect(report.unexpected).toEqual({});
    // The numbers README.md gives.
    expect(report.totals).toEqual({
      cases: 8,
      as_expected: 3,
      as_recorded: 8,
      statements: { expected: 23, in_slot: 22, misplaced: 1 },
      values: { expected: 14, sources_right: 11 },
      slots: { expected: 11, proposed_right: 7, cases_right: 8 },
    });
    // What governance counts is statements: the notice and its two copies are three.
    const taxi = report.cases.find((c) => c.case === "reposted-notice")?.counts.taxi_cap_per_day;
    expect(taxi).toEqual({
      "40 USD/day": { statements: 3, governed: 3, documents: 3 },
      "45 USD/day": { statements: 2, governed: 2, documents: 2 },
    });
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
