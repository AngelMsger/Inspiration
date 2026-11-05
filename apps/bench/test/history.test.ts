import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Corpus, Engine } from "@inspiration/engine";
import { hasStack, quick, stackTest, VALKEY_URL } from "@inspiration/testkit";
import { describe, expect, test } from "vitest";
import {
  type History,
  inEffect,
  loadHistory,
  loadTimeline,
  type ReplayReport,
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
    expect(check.totals).toEqual({ steps: 294, right: 174, as_recorded: 294 });
    expect(check.unexpected).toEqual(["home_office_stipend"]);
    // The moved notice states nothing: every fact is kept, marked, until the page comes back.
    const at = (day: string) => report.steps.find((s) => s.at.startsWith(day));
    expect(at("2026-03-18")?.slots.hotel_cap_per_night).toEqual({
      leads: "300 USD/night",
      values: ["300 USD/night"],
      unstated: true,
    });
    const unstated = (day: string) => Object.keys(at(day)?.slots ?? {}).filter((k) => at(day)?.slots[k]?.unstated);
    expect(unstated("2026-03-18")).toEqual(Object.keys(at("2026-03-18")?.slots ?? {}));
    expect(unstated("2026-05-14")).toEqual(["phone_service_monthly_cap"]);
    // A cap the stand-in stopped reading in 2023 stays, marked.
    expect(at("2026-09-13")?.slots.phone_service_monthly_cap).toMatchObject({ leads: "50 USD/month", unstated: true });
    // The one change of the last year, a new version superseding the old value.
    const last = report.steps.at(-1);
    expect(last?.slots.meal_allowance_per_day).toEqual({ leads: "120 USD/day", values: ["120 USD/day"] });
    // The owner has one todo for the document, about the one fact the stand-in no longer reads.
    const open = (await engine.inbox.items(corpus.tenantId, { open: true })).filter((i) => i.todo.kind === "unstated");
    expect(open.map((i) => i.todo.title)).toEqual(["Global Travel and Expense Policy: 1 statement no longer stated"]);
    const [phone] = await engine.store.getClaims(open[0]?.todo.unit_ids ?? []);
    expect(phone).toMatchObject({ slot_key: "phone_service_monthly_cap", value: { normalized: "50 USD/month" } });
    // What people were asked, against what changed; README.md says which asks were worth it.
    expect(report.review).toEqual({
      versions: 20,
      changed_facts: 20,
      todos: 2,
      todos_by_kind: { conflict: 1, unstated: 1 },
      more: 2,
      withdrawn: 1,
      notes: 0,
      asks_per_changed_fact: 0.2,
      cases: 1,
      settled: 0,
      first: { todos: {}, more: {}, withdrawn: 0, notes: 0, cases: 0, settled: 0 },
    });
    const asked = report.steps.filter((s) => Object.keys(s.asks.todos).length || Object.keys(s.asks.more).length);
    expect(asked.map((s) => s.at.slice(0, 10))).toEqual(["2022-01-20", "2023-02-08", "2023-05-17", "2026-03-18"]);
  } finally {
    await engine.close();
    await rm(blobDir, { recursive: true, force: true });
  }
}

// Twenty versions ingested one after another: about 9 s in memory and 15 s on Postgres on their
// own, and up to twice that while the rest of the suite runs beside them.
describe("the GitLab expense policy history", { timeout: 60_000 }, () => {
  test("in memory", async () => {
    await check();
  });

  describe.skipIf(!hasStack() || quick())("on the stack", () => {
    stackTest("Postgres with the outbox relayed to Valkey Streams", async ({ databaseUrl, streamPrefix, valkey }) => {
      expect(valkey).toBeDefined(); // removes this run's stream keys afterwards
      await check({ databaseUrl, streamPrefix });
    });
  });
});

/** Replay the versions of one handbook page, each a list of lines, through a fresh engine. */
async function replayPage(
  versions: string[][],
  then: (report: ReplayReport, engine: Engine, tenant: string) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), "inspiration-history-"));
  const blobDir = await mkdtemp(join(tmpdir(), "inspiration-history-"));
  try {
    for (const file of ["corpus.yaml", "vocabulary.yaml"]) await copyFile(join(EXPENSES, file), join(dir, file));
    await mkdir(join(dir, "handbook", "finance"), { recursive: true });
    await mkdir(join(dir, "history"));
    const steps = [];
    for (const [i, lines] of versions.entries()) {
      await writeFile(join(dir, "history", `v${i + 1}.md`), `# Travel and expenses\n\n${lines.join("\n")}\n`);
      steps.push(`  - {at: 2024-0${i + 1}-01T00:00:00Z, from: history/v${i + 1}.md}`);
    }
    await writeFile(join(dir, "history.yaml"), `document: handbook/finance/expenses.md\nsteps:\n${steps.join("\n")}\n`);
    const corpus = await Corpus.load(dir);
    const history = (await loadHistory(dir)) as History;
    let now = new Date(history.steps[0]?.at as string);
    const engine = await Engine.open({
      clock: () => now,
      blobDir,
      resolvePrincipal: corpus.resolvePrincipal,
      vocabulary: () => corpus.vocabulary,
    });
    try {
      await then(await replay(engine, dir, history, (at) => (now = at)), engine, corpus.tenantId);
    } finally {
      await engine.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(blobDir, { recursive: true, force: true });
  }
}

test("a statement that leaves an open todo and comes back gives it more to decide each time it comes back", async () => {
  const hotel = "- Hotel stays are reimbursable up to $600 USD per night.";
  const meal = "- Meals while traveling are reimbursable, up to $100 USD per day.";
  const other = "- Book every trip through the travel desk.";
  // Both, neither, the hotel back, the hotel gone again, both back.
  await replayPage([[hotel, meal], [other], [hotel], [other], [hotel, meal]], async (report) => {
    expect(report.steps.map((s) => s.asks)).toMatchObject([
      { todos: {} },
      { todos: { unstated: 1 } },
      { more: {} },
      { more: { unstated: 1 } },
      { withdrawn: 1 },
    ]);
    expect(report.review).toMatchObject({ todos: 1, more: 1, withdrawn: 1 });
  });
});

test("a todo shown a statement in place of a superseded one is not given more to decide", async () => {
  const capped = "- Hotel stays are capped at $300 USD per night.";
  const lines = [
    "- Hotel stays are reimbursable up to $300 USD per night.",
    "- Hotel stays: up to $300 USD per night.",
    "- Hotel stays are reimbursable up to $400 USD per night in New York.",
  ];
  // The todo shows the capped line for 300; the next version drops it, and 300 still leads.
  await replayPage([[...lines, capped], lines], async (report, engine, tenant) => {
    const [item] = await engine.inbox.items(tenant, { open: true });
    expect(item?.refreshed).toHaveLength(1);
    expect(report.steps.map((s) => [s.asks.todos, s.asks.more])).toEqual([
      [{ conflict: 1 }, {}],
      [{}, {}],
    ]);
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
