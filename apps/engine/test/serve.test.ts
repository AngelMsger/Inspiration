// The trial's models: the sample company's calls on its own stand-ins, everyone else's on the
// real model, told apart by the calls' budget keys.

import type { ModelGateway } from "@inspiration/contracts";
import { expect, test } from "vitest";
import { byTenant } from "../src/serve.ts";

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
