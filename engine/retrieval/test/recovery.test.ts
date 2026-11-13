import { GatewayException, payloadOf } from "@inspiration/contracts";
import { describe, expect, vi } from "vitest";
import { JOBS } from "../src/indexing.ts";
import { ALICE, BACKENDS, retrievalTest, SOURCE, TENANT } from "./fixtures.ts";

describe.each(BACKENDS)("index recovery on $backend", ({ backend, skip }) => {
  const test = retrievalTest(backend);
  describe.skipIf(skip)("", () => {
    test("an embedding outage survives reconstruction and resumes without a new source version", async ({ world }) => {
      const embed = vi
        .spyOn(world.gateway, "embed")
        .mockRejectedValue(new GatewayException("provider_error", "offline"));
      const doc = await world.document("leave", [{ id: "p", text: "Leave allowance: 20 days." }]);
      expect(await world.retrieval.documents(TENANT)).toEqual([]);
      expect(await world.retrieval.indexing(TENANT)).toMatchObject([{ state: "paused", code: "provider_error" }]);
      const restarted = world.knowledgeBase({});
      expect(await restarted.resume("src_00000000OTHER")).toBe(0);
      embed.mockRestore();
      expect(await restarted.resume(SOURCE)).toBe(1);
      expect(await restarted.indexing(TENANT)).toEqual([]);
      expect(
        (await restarted.search({ text: "leave allowance", kinds: ["chunk"] }, ALICE)).hits[0]?.citations[0]
          ?.source_version_id,
      ).toBe(doc.version.id);
      expect(await restarted.resume()).toBe(0);
      await restarted.onBlocksChanged(doc.event);
      expect(restarted.totals.indexed).toBe(1);
    });

    test("a newer version or deletion supersedes failed work; a late event cannot restore it", async ({ world }) => {
      const first = await world.document("leave", [{ id: "p", text: "Leave allowance: 20 days." }]);
      const embed = vi
        .spyOn(world.gateway, "embed")
        .mockRejectedValue(new GatewayException("budget_exceeded", "spent"));
      const second = await world.document("leave", [{ id: "p", text: "Leave allowance: 25 days." }]);
      expect((await world.retrieval.documents(TENANT))[0]?.source_version_id).toBe(first.version.id);
      expect(await world.retrieval.resume()).toBe(0);
      const deleted = await world.document("leave", [], { deleted: true });
      expect(await world.retrieval.indexing(TENANT)).toEqual([]);
      embed.mockRestore();
      await world.retrieval.onBlocksChanged(second.event);
      expect(await world.retrieval.resume()).toBe(0);
      expect((await world.retrieval.documents(TENANT))[0]?.source_version_id).toBe(deleted.version.id);
      expect((await world.retrieval.search({ text: "leave", kinds: ["chunk"] }, ALICE)).hits).toEqual([]);
    });

    test("work persisted before a crash is resumed; a bad document does not block the next one", async ({ world }) => {
      const first = await world.document("broken", [{ id: "p", text: "Broken document." }], { indexed: false });
      const second = await world.document("good", [{ id: "p", text: "Leave allowance: 30 days." }], { indexed: false });
      for (const doc of [first, second]) {
        await world.records.transaction((tx) =>
          tx.put(JOBS, [
            {
              tenant_id: TENANT,
              source_id: SOURCE,
              document: `${SOURCE}:${doc.version.external_id}`,
              source_version_id: doc.version.id,
              fetched_at: doc.version.fetched_at,
              change: payloadOf(doc.event, "blocks.changed"),
              state: "pending",
            },
          ]),
        );
      }
      const embed = vi.spyOn(world.gateway, "embed").mockRejectedValueOnce(new Error("bad document"));
      const restarted = world.knowledgeBase({});
      expect(await restarted.resume()).toBe(1);
      expect(await restarted.indexing(TENANT)).toMatchObject([{ state: "failed", code: "index_error" }]);
      embed.mockRestore();
      expect(await restarted.resume()).toBe(1);
      expect(await restarted.documents(TENANT)).toHaveLength(2);
    });
  });
});
