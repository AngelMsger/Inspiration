// Answers against the in-memory doubles and Postgres: what each answer records for usage,
// and how a disagreement no person has settled is marked in what the model reads.

import { newId, type Principal, type SlotVerdict } from "@inspiration/contracts";
import type { MemoryUsage } from "@inspiration/model-gateway";
import { describe, expect, vi } from "vitest";
import {
  ANSWER_SOURCES,
  ANSWER_TASK,
  ANSWERS,
  type AnswerInput,
  type AnswerRecord,
  COMPACT_SOURCES,
  inputOf,
} from "../src/index.ts";
import {
  ALICE,
  BACKENDS,
  BOB,
  cap,
  EMPTY_SPACE,
  HOTEL,
  POLICY,
  retrievalTest,
  SPACE,
  TENANT,
  verdict,
} from "./fixtures.ts";

describe.each(BACKENDS)("answers on $backend", ({ backend, skip }) => {
  const test = retrievalTest(backend);

  describe.skipIf(skip)("", () => {
    test("every answer is recorded with its time, calls, cost, member and spaces, never its words", async ({
      world,
    }) => {
      await world.document("travel.md", POLICY, { title: "Travel policy" });
      const compact = world.knowledgeBase({ answerSources: COMPACT_SOURCES });
      const question = "What is the hotel cap in tier-1 cities?";
      const given = await compact.answer({ question }, ALICE);
      const agent: Principal = { id: newId("agent"), kind: "agent", tenant_id: TENANT, on_behalf_of: BOB.id };
      const asked = await world.retrieval.answer({ question }, agent);
      const nothing = await world.retrieval.answer({ question, space_ids: [EMPTY_SPACE] }, ALICE);
      const rival = await world.baseline("long_context").answer({ question }, ALICE);
      const records = await world.records.find(ANSWERS, { tenant_id: TENANT });
      const of = (id: string) => records.find((r) => r.answer_id === id) as AnswerRecord;
      const mine = of(given.answer_id);
      expect(mine).toMatchObject({
        tenant_id: TENANT,
        member_id: ALICE.id,
        space_ids: [SPACE],
        reads: COMPACT_SOURCES,
        cost: { currency: "CNY" },
      });
      expect(mine.month).toBe(mine.at.slice(0, 7));
      expect(mine.ms).toBeGreaterThanOrEqual(0);
      expect(new Set(mine.calls.map((c) => c.operation))).toEqual(new Set(["complete", "embed", "rerank"]));
      expect(mine.calls.find((c) => c.task === ANSWER_TASK)).toMatchObject({ provider: "cloud", model: "fake-flash" });
      expect(mine.cost?.amount).toBeCloseTo(mine.calls.reduce((n, c) => n + c.cost.amount, 0));
      expect(mine.cost?.amount).toBeGreaterThan(0);
      // The usage page counts answers, never what they were about.
      expect(JSON.stringify(mine)).not.toMatch(/hotel|650|tier-1/i);
      // An agent's answer counts for the member it acts for; the standard answer reads its own sources.
      expect(of(asked.answer_id)).toMatchObject({
        member_id: BOB.id,
        agent_id: agent.id,
        reads: { passages: ANSWER_SOURCES, statements: ANSWER_SOURCES },
      });
      // An answer that found nothing read no space; it searched, and asked no model to answer.
      const none = of(nothing.answer_id);
      expect(none.space_ids).toEqual([]);
      expect(none.calls.map((c) => c.operation)).toContain("embed");
      expect(none.calls.some((c) => c.task === ANSWER_TASK)).toBe(false);
      expect(of(rival.answer_id)).toMatchObject({ reads: "everything", baseline: "long_context" });
      // Indexing is not an answer's: a new document's calls go to no record.
      await world.document("meals.md", POLICY.slice(2), { title: "Meals" });
      expect(await world.records.count(ANSWERS, { tenant_id: TENANT })).toBe(4);

      // The gateway's ledger charges every call: an answer's to the member who asked or for whom
      // an agent asked, indexing a document to its space.
      const ledger = (world.gateway.usage as MemoryUsage).records;
      const charged = (member: string) => ledger.filter((r) => r.member_id === member).length;
      const calls = (...ids: string[]) => ids.reduce((n, id) => n + of(id).calls.length, 0);
      expect(charged(ALICE.id)).toBe(calls(given.answer_id, nothing.answer_id, rival.answer_id));
      expect(charged(BOB.id)).toBe(calls(asked.answer_id));
      expect(ledger.filter((r) => !r.member_id).every((r) => r.space_id === SPACE)).toBe(true);
      expect(ledger.some((r) => r.space_id === SPACE && r.operation === "embed")).toBe(true);
    });

    test("both sides of a disagreement are marked in what an answer reads", async ({ world }) => {
      const policy = await world.document("travel.md", POLICY, { title: "Travel policy" });
      const rule = "Hotels in tier-1 cities cost at most 700 yuan a night.";
      const handbook = await world.document("handbook.md", [{ id: "p1", text: rule }], { title: "Employee handbook" });
      const held = await world.claim(POLICY[1]?.text as string, policy.spansOf("p1")[0] as never, {
        ...cap(650),
        quote: "Hotels in tier-1 cities cost at most 650 yuan a night.",
      });
      const other = await world.claim(rule, handbook.spansOf("p1")[0] as never, cap(700));
      const disputed: SlotVerdict = {
        tenant_id: TENANT,
        slot_key: HOTEL,
        held_value: "650 CNY/night",
        disputed: true,
        values: [
          { value: "650 CNY/night", standing: "holds", claim_ids: [held.id] },
          { value: "700 CNY/night", standing: "disputed", claim_ids: [other.id] },
        ],
        decided_on: "2026-10-01",
      };
      const question = { question: "How much can a hotel in a tier-1 city cost a night?" };
      const complete = vi.spyOn(world.gateway, "complete");
      const read = async () => {
        complete.mockClear();
        const answer = await world.retrieval.answer(question, ALICE);
        const asked = complete.mock.calls.find(([req]) => req.task === ANSWER_TASK)?.[0];
        const input = inputOf<AnswerInput>(asked?.messages.map((m) => m.content).join("\n") ?? "");
        return { answer, sources: input?.sources ?? [] };
      };

      world.verdicts.set(HOTEL, disputed);
      const { answer, sources } = await read();
      const statement = (text: string) => sources.find((s) => s.kind === "statement" && s.text === text);
      const [ours, theirs] = [statement(held.statement), statement(rule)];
      expect(ours).toMatchObject({ standing: "holds", disputed_with: [theirs?.ref] });
      expect(theirs).toMatchObject({ standing: "disputed", held_ref: ours?.ref, disputed_with: [ours?.ref] });
      // The passages that state either value point to their side.
      const passage = (title: string) => sources.find((s) => s.kind === "passage" && s.title.startsWith(title));
      expect(passage("Travel policy")?.disputed).toEqual([ours?.ref]);
      expect(passage("Employee handbook")?.disputed).toEqual([theirs?.ref]);
      expect(answer.answer).toContain("650");
      expect(answer.answer).toContain("700");

      // A value replaced is no disagreement: nothing is marked.
      world.verdicts.set(
        HOTEL,
        verdict({ value: "650 CNY/night", claim: held.id }, { value: "700 CNY/night", claim: other.id }),
      );
      const settled = await read();
      expect(settled.sources.some((s) => s.disputed_with || s.disputed)).toBe(false);
      complete.mockRestore();
    });
  });
});
