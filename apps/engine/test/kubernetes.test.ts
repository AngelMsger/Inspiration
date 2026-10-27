import { cp, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hasStack, stackTest, VALKEY_URL } from "@inspiration/testkit";
import { describe, expect, test } from "vitest";
import { type Control, Corpus, controlReport, Engine, ingest, loadControl, SimulatedClock } from "../src/index.ts";

const KUBERNETES = fileURLToPath(new URL("../../../examples/kubernetes-docs/", import.meta.url));

/**
 * Every page and its translations come out as expected.yaml answers them, or as its engine
 * entries record. Then, were the English page to raise its node limit, the translations would
 * fall behind: the original's new value holds without a person, and freshness asks for both
 * translations to be brought up to date.
 */
async function check(stack?: { databaseUrl: string; streamPrefix: string }): Promise<void> {
  const work = await mkdtemp(join(tmpdir(), "inspiration-kubernetes-"));
  await cp(KUBERNETES, work, { recursive: true });
  const corpus = await Corpus.load(work);
  const control = (await loadControl(work)) as Control;
  const clock = new SimulatedClock(new Date("2026-10-27T09:00:00Z"));
  const engine = await Engine.open({
    clock: clock.now,
    blobDir: join(work, ".blobs"),
    resolvePrincipal: corpus.resolvePrincipal,
    vocabulary: () => corpus.vocabulary,
    ...(stack && { databaseUrl: stack.databaseUrl, valkeyUrl: VALKEY_URL, streamPrefix: stack.streamPrefix }),
  });
  try {
    expect((await ingest(engine, corpus)).dead_letters).toBe(0);
    const report = await controlReport(engine, corpus, control);
    for (const c of report.cases) expect(c.observed, c.case).toEqual(c.recorded);
    expect(report.unexpected).toEqual({});
    // The numbers README.md gives.
    expect(report.totals).toEqual({
      cases: 4,
      as_expected: 1,
      as_recorded: 4,
      statements: { expected: 33, in_slot: 29, misplaced: 18 },
      values: { expected: 11, sources_right: 9 },
      slots: { expected: 11, proposed_right: 10, cases_right: 7 },
    });

    const page = join(work, "docs/setup/best-practices/cluster-large.html");
    await writeFile(page, (await readFile(page, "utf8")).replaceAll("5,000 nodes", "6,000 nodes"));
    clock.set("2026-11-02");
    await utimes(page, clock.now(), clock.now());
    expect((await ingest(engine, corpus)).dead_letters).toBe(0);
    const { decision } = await engine.governance.slot(corpus.tenantId, "cluster_max_nodes");
    expect(decision?.proposed.value).toBe("6000 node");
    expect(decision?.cases.find((c) => c.value === "5000 node")).toMatchObject({
      classification: "supersession",
      status: "auto_resolved",
    });
    const behind = (await engine.freshness.documents(corpus.tenantId)).filter((d) => d.behind);
    expect(behind.map((d) => corpus.pathOf(...(d.document.split(":") as [string, string]))).sort()).toEqual([
      "docs/setup/best-practices/cluster-large.ja.html",
      "docs/setup/best-practices/cluster-large.zh-cn.html",
    ]);
  } finally {
    await engine.close();
    await rm(work, { recursive: true, force: true });
  }
}

describe("the Kubernetes pages in three languages", () => {
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
