// The engine process's models: the sample company's calls on its own models, everyone else's
// on the rest, told apart by the calls' budget keys, and all of them within the budgets of
// --gateway, counted in one ledger that a restart keeps.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompletionRequest, ModelGateway } from "@inspiration/contracts";
import { hasStack, stackTest } from "@inspiration/testkit";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { byTenant, openModels } from "../src/models.ts";

const SAMPLE = "ten_sample";
const OTHER = "ten_other";
/** About 250 tokens, CNY 0.00025 at the price below: two calls spend the limit. */
const LONG = "word ".repeat(200);

let dir: string;
const files = { day: "", month: "", sample: "" };

/** A gateway file: one paid fake provider and the budgets given. */
async function config(name: string, file: string, budgets: string): Promise<string> {
  const path = join(dir, `${file}.yaml`);
  await writeFile(
    path,
    `currency: CNY
providers:
  - name: ${name}
    kind: fake
    max_sensitivity: internal
    models:
      - {name: ${name}-flash, operations: [complete], tiers: [flash, standard], price: {input: 1, output: 2}}
budgets:
${budgets}
`,
  );
  return path;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "inspiration-models-"));
  files.day = await config("trial", "day", '  - {match: "*", period: day, limit: 0.0003, pooled: true}');
  files.month = await config("trial", "month", '  - {match: "*", period: month, limit: 0.0003, pooled: true}');
  // Its own budget is generous; the trial's hold instead.
  files.sample = await config("sample", "sample", '  - {match: "*", period: day, limit: 1, pooled: true}');
});
afterAll(() => rm(dir, { recursive: true, force: true }));

function ask(tenantId: string, content: string): CompletionRequest {
  return {
    task: "retrieval.answer_question",
    prompt_version: "answer@1",
    messages: [{ role: "user", content }],
    sensitivity: "internal",
    budget_key: `tenant:${tenantId}/retrieval`,
  };
}

/** A gateway that only says its name, for every operation. */
function named(name: string): ModelGateway {
  const answer = async () => name as never;
  return { complete: answer, embed: answer, rerank: answer, ocr: answer };
}

test("one tenant's calls go to its own models, every other tenant's to the rest", async () => {
  const models = byTenant("ten_sample", named("own"), named("rest"));
  const call = (budget_key: string) => ({ budget_key, sensitivity: "internal" as const });
  expect(await models.embed({ ...call("tenant:ten_sample/retrieval"), texts: ["x"], input_type: "query" })).toBe("own");
  expect(await models.rerank({ ...call("tenant:ten_sample/retrieval"), query: "q", documents: ["d"] })).toBe("own");
  expect(await models.embed({ ...call("tenant:ten_sample2/retrieval"), texts: ["x"], input_type: "query" })).toBe(
    "rest",
  );
  expect(await models.ocr({ ...call("tenant:ten_other/normalization"), image: { blob_id: "b" } as never })).toBe(
    "rest",
  );
});

test("the sample company's calls and everyone else's count against the same budgets", async () => {
  for (const [first, then] of [
    [SAMPLE, OTHER],
    [OTHER, SAMPLE],
  ] as const) {
    const { models, close } = await openModels({
      gateway: files.day,
      corpus: { gateway: files.sample, tenantId: SAMPLE },
    });
    try {
      const spent = await models.complete(ask(first, `${LONG}1`));
      expect(spent.provider).toBe(first === SAMPLE ? "sample" : "trial");
      await models.complete(ask(first, `${LONG}2`));
      await expect(models.complete(ask(then, "again"))).rejects.toMatchObject({ code: "budget_exceeded" });
    } finally {
      await close();
    }
  }
});

test("a budget over a month needs a ledger that outlives the server", async () => {
  await expect(openModels({ gateway: files.month })).rejects.toThrow(/--usage/);
});

describe.skipIf(!hasStack())("with the ledger in Postgres", () => {
  stackTest("a restarted server reads what the month spent, the sample company's too", async ({ databaseUrl }) => {
    const open = () =>
      openModels({ gateway: files.month, corpus: { gateway: files.sample, tenantId: SAMPLE }, usageUrl: databaseUrl });
    const before = await open();
    try {
      await before.models.complete(ask(SAMPLE, `${LONG}1`));
      await before.models.complete(ask(OTHER, `${LONG}2`));
    } finally {
      await before.close();
    }
    const after = await open();
    try {
      await expect(after.models.complete(ask(OTHER, "again"))).rejects.toMatchObject({ code: "budget_exceeded" });
      await expect(after.models.complete(ask(SAMPLE, "again"))).rejects.toMatchObject({ code: "budget_exceeded" });
    } finally {
      await after.close();
    }
  });
});
