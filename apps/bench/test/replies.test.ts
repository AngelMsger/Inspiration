import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeProvider, Gateway, parseGatewayConfig, ValkeyCache } from "@inspiration/model-gateway";
import { hasStack, stackTest as test } from "@inspiration/testkit";
import { describe, expect } from "vitest";
import { exportReplies, importReplies } from "../src/replies.ts";

const CONFIG = parseGatewayConfig({
  providers: [
    { name: "cloud", kind: "fake", max_sensitivity: "internal", models: [{ name: "chat", operations: ["complete"] }] },
  ],
});

function gateway(cache: ValkeyCache): { gateway: Gateway; provider: FakeProvider } {
  const provider = new FakeProvider(CONFIG.providers[0] as (typeof CONFIG.providers)[number]);
  return { gateway: new Gateway(CONFIG, { cache, providers: { cloud: provider } }), provider };
}

const ask = (g: Gateway, content: string) =>
  g.complete({
    task: "extraction.extract_claims",
    prompt_version: "claims@1",
    messages: [{ role: "user", content }],
    sensitivity: "internal",
    budget_key: "tenant:ten_x/extraction",
  });

describe.skipIf(!hasStack())("replies kept beyond the cache", () => {
  test("an exported cache answers a fresh one's calls after import", async ({ valkey, streamPrefix }) => {
    const before = gateway(new ValkeyCache(valkey, { prefix: `${streamPrefix}:a` }));
    await ask(before.gateway, "first");
    await ask(before.gateway, "second");
    const file = join(await mkdtemp(join(tmpdir(), "replies-")), "replies.jsonl");
    expect(await exportReplies(before.gateway.cache as ValkeyCache, file)).toBe(2);
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    expect(lines.map((l) => JSON.parse(l).reply.provider)).toEqual(["cloud", "cloud"]);

    const fresh = new ValkeyCache(valkey, { prefix: `${streamPrefix}:b` });
    expect(await importReplies(fresh, file, 60)).toBe(2);
    const after = gateway(fresh);
    expect((await ask(after.gateway, "second")).cached).toBe(true);
    expect((await ask(after.gateway, "third")).cached).toBe(false);
    expect(after.provider.calls).toHaveLength(1);
    const ttl = await valkey.ttl(`${streamPrefix}:b:gw:cache:${JSON.parse(lines[0] as string).key}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });
});
