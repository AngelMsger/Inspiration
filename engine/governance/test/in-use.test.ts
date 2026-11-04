import { describe, expect } from "vitest";
import { BACKENDS, governanceTest, HOTEL, TENANT } from "./fixtures.ts";

// Of two equally authoritative governed documents that disagree with no change between them,
// the newer one is proposed. The older one is out of date only when it had not changed for a
// year when the newer one did (a backup left behind); two documents both in use are a
// contradiction a person decides.

describe.each(BACKENDS)("$backend backend", ({ backend, skip }) => {
  const test = governanceTest(backend);

  describe.skipIf(skip)("documents in use", () => {
    test("without effective dates, the copy of the policy changed later is the newer one", async ({ world }) => {
      const current = await world.state(
        { title: "Travel policy", authority: 0.9, external_id: "travel.md", modified_at: "2026-09-13T08:00:00Z" },
        [{ text: "Hotels are capped at 650 yuan a night.", value: 650 }],
      );
      await world.state(
        {
          title: "Travel policy",
          authority: 0.9,
          external_id: "travel-backup.md",
          modified_at: "2024-02-08T08:00:00Z",
        },
        [{ text: "Hotels are capped at 600 yuan a night.", value: 600 }],
      );
      const { decision } = await world.governance.slot(TENANT, HOTEL);
      expect(decision?.proposed.best.claim_id).toBe(current.claims[0]?.id);
      // The backup had not changed for more than a year when the policy did: left behind.
      expect(decision?.cases.map((c) => [c.value, c.classification, c.rationale])).toEqual([
        [
          "600 CNY/night",
          "supersession",
          "600 CNY/night (1 document, the most authoritative Travel policy, from 2024-02-08) is older than 650 CNY/night in Travel policy, from 2026-09-13, which is as authoritative and has as many independent sources.",
        ],
      ]);
    });

    test("two governed documents in use that disagree are a contradiction, though one is newer", async ({ world }) => {
      await world.state({ title: "Networking runbook", authority: 0.7, modified_at: "2026-08-04T08:00:00Z" }, [
        { text: "Each namespace gets at most 3 LoadBalancer Services.", value: 3 },
      ]);
      const standards = await world.state(
        { title: "Cluster standards", authority: 0.7, modified_at: "2026-09-15T08:00:00Z" },
        [{ text: "A namespace may have at most 5 Services of type LoadBalancer.", value: 5 }],
      );
      const { decision } = await world.governance.slot(TENANT, HOTEL);
      expect(decision?.proposed.best.claim_id).toBe(standards.claims[0]?.id);
      // Six weeks newer does not show the runbook is wrong: both stand until a person decides.
      expect(decision?.cases.map((c) => [c.value, c.classification, c.status, c.priority, c.rationale])).toEqual([
        [
          "3 CNY/night",
          "contradiction",
          "open",
          "normal",
          "5 CNY/night in Cluster standards, from 2026-09-15, is newer than 3 CNY/night (1 document, the most authoritative Networking runbook, from 2026-08-04), which is as authoritative and has as many independent sources; a newer document does not show that another one is wrong.",
        ],
      ]);
      const [verdict] = await world.governance.verdicts(TENANT, [HOTEL]);
      expect(verdict?.values.map((v) => [v.value, v.standing])).toEqual([
        ["5 CNY/night", "holds"],
        ["3 CNY/night", "disputed"],
      ]);
    });

    test("a policy in effect for years but edited since is in use, against a newer one in effect", async ({
      world,
    }) => {
      await world.state(
        { title: "Travel policy", authority: 0.9, effective_from: "2020-01-01", modified_at: "2026-10-20T08:00:00Z" },
        [{ text: "The hotel cap is 600 yuan a night.", value: 600 }],
      );
      await world.state(
        { title: "Travel standard", authority: 0.9, effective_from: "2026-10-01", modified_at: "2026-10-01T08:00:00Z" },
        [{ text: "The hotel cap is 800 yuan a night.", value: 800 }],
      );
      const { decision } = await world.governance.slot(TENANT, HOTEL);
      // Edited three days ago, the policy was not left behind when the standard took effect.
      expect(decision?.cases.map((c) => [c.value, c.classification, c.status])).toEqual([
        ["600 CNY/night", "contradiction", "open"],
      ]);
    });
  });
});
