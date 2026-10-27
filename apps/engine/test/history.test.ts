import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hasStack, stackTest, VALKEY_URL } from "@inspiration/testkit";
import { describe, expect, test } from "vitest";
import {
  Corpus,
  Engine,
  type History,
  inEffect,
  loadHistory,
  loadTimeline,
  replay,
  type Timeline,
} from "../src/index.ts";

const EXPENSES = fileURLToPath(new URL("../../../examples/gitlab-expenses/", import.meta.url));

/**
 * After every version, every slot leads with what timeline.yaml expects or what its engine
 * entry records. A change that closes a gap fails here until the entry goes; one that opens a
 * gap, until one is added.
 */
async function check(stack?: { databaseUrl: string; streamPrefix: string }): Promise<void> {
  const corpus = await Corpus.load(EXPENSES);
  const history = (await loadHistory(EXPENSES)) as History;
  const timeline = (await loadTimeline(EXPENSES)) as Timeline;
  const blobDir = await mkdtemp(join(tmpdir(), "inspiration-history-"));
  let now = new Date(history.steps[0]?.at as string);
  const engine = await Engine.open({
    clock: () => now,
    blobDir,
    resolvePrincipal: corpus.resolvePrincipal,
    vocabulary: () => corpus.vocabulary,
    ...(stack && { databaseUrl: stack.databaseUrl, valkeyUrl: VALKEY_URL, streamPrefix: stack.streamPrefix }),
  });
  try {
    const report = await replay(engine, EXPENSES, history, (at) => (now = at), { timeline });
    const check = report.check as NonNullable<typeof report.check>;
    for (const slot of check.slots) {
      for (const row of slot.rows) expect(row.observed, `${slot.slot} on ${row.at}`).toBe(row.recorded);
    }
    // The numbers README.md gives.
    expect(check.totals).toEqual({ steps: 294, right: 165, as_recorded: 294 });
    expect(check.unexpected).toEqual(["home_office_stipend"]);
    // The moved notice: a version that states nothing leaves no knowledge.
    const moved = report.steps.find((s) => s.at.startsWith("2026-03-18"));
    expect(moved?.slots).toEqual({});
    // The one change of the last year, a new version superseding the old value.
    const last = report.steps.at(-1);
    expect(last?.slots.meal_allowance_per_day).toEqual({ leads: "120 USD/day", values: ["120 USD/day"] });
  } finally {
    await engine.close();
    await rm(blobDir, { recursive: true, force: true });
  }
}

describe("the GitLab expense policy history", () => {
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

describe("history.yaml and timeline.yaml", () => {
  test("the value in effect is the last entry on or before the day", () => {
    const entries = [
      { from: "2023-08-29", value: "100 USD/day" },
      { from: "2026-06-19", value: "120 USD/day" },
    ];
    expect(inEffect(entries, "2023-08-28")).toBeNull();
    expect(inEffect(entries, "2026-06-18")).toBe("100 USD/day");
    expect(inEffect(entries, "2026-06-19")).toBe("120 USD/day");
  });

  test("steps out of order, and engine entries for slots the timeline lacks, are refused", async () => {
    const dir = await mkdtemp(join(tmpdir(), "inspiration-history-"));
    try {
      await writeFile(
        join(dir, "history.yaml"),
        "document: a.md\nsteps:\n  - {at: 2024-02-01T00:00:00Z, from: b.md}\n  - {at: 2024-01-01T00:00:00Z, from: a.md}\n",
      );
      await expect(loadHistory(dir)).rejects.toThrow(/in order/);
      await writeFile(join(dir, "history.yaml"), "steps: []\n");
      await expect(loadHistory(dir)).rejects.toThrow(/invalid history.yaml/);
      await writeFile(
        join(dir, "timeline.yaml"),
        "slots: {a: [{from: 2024-01-01, value: x}]}\nengine: {b: {why: w, timeline: []}}\n",
      );
      await expect(loadTimeline(dir)).rejects.toThrow(/engine entry for b/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a corpus without them has no replay", async () => {
    expect(await loadHistory(join(EXPENSES, "handbook"))).toBeUndefined();
    expect(await loadTimeline(join(EXPENSES, "handbook"))).toBeUndefined();
  });
});
