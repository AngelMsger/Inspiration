// A snapshot: the demo script it records, and how its page answers from the recording.

import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { loadPeople } from "../src/backend.ts";
import { answer, callKey, type Recording, savedPlace } from "../src/replay.ts";
import { loadScript, questionsOf } from "../src/snapshot.ts";

const CORPUS = fileURLToPath(new URL("../../../examples/corpus/", import.meta.url));

describe("the demo script", async () => {
  const steps = loadScript(await readFile(`${CORPUS}script.yaml`, "utf8"));
  const people = loadPeople(`${CORPUS}people.yaml`);

  test("is taken by the corpus's people, in every language the app speaks", () => {
    const members = new Set(people.people.map((p) => p.member));
    for (const step of steps) {
      expect(members.has(step.as), step.as).toBe(true);
      expect(Object.keys(step.text).sort()).toEqual(["en", "ja", "zh"]);
    }
  });

  test("puts in upstream edits the corpus has, and asks its questions", async () => {
    const updates = await readdir(`${CORPUS}updates`);
    for (const step of steps.filter((s) => s.do?.update)) expect(updates).toContain(step.do?.update);
    expect(questionsOf(steps)).toHaveLength(2);
  });

  test("refuses steps without a member, an address and words", () => {
    expect(() => loadScript("steps: [{as: mem_x, open: inbox, text: {}}]")).toThrow(RangeError);
    expect(() => loadScript("steps: []")).toThrow(RangeError);
  });
});

describe("a snapshot's page", () => {
  const a = { member: "mem_A", name: "A" };
  const b = { member: "mem_B", name: "B" };
  const recording: Recording = {
    recorded_at: "2026-11-04T00:00:00.000Z",
    people: { tenant: "ten_1", people: [a, b] },
    steps: [],
    questions: ["q1", "q2"],
    bodies: { one: { inbox: 1 }, two: { inbox: 2 }, done: { ok: true } },
    states: [
      {
        mem_A: { [callKey("GET", "/v0/inbox")]: { status: 200, body: "one" } },
        mem_B: { [callKey("POST", "/v0/todos/t/resolve", '{"with":"x"}')]: { status: 200, body: "done", next: 1 } },
      },
      { mem_A: { [callKey("GET", "/v0/inbox")]: { status: 200, body: "two" } } },
    ],
  };
  const start = { state: 0, member: "mem_A" };

  test("acts as the place's person, and as another when asked", () => {
    expect(answer(recording, start, "GET", "/session").json).toMatchObject({ person: a });
    const moved = answer(recording, start, "POST", "/session", '{"member":"mem_B"}');
    expect([moved.json, moved.place]).toMatchObject([{ person: b }, { state: 0, member: "mem_B" }]);
    expect(answer(recording, start, "POST", "/session", '{"member":"mem_C"}').status).toBe(400);
  });

  test("answers what was recorded, and moves on with a step's action", () => {
    expect(answer(recording, start, "GET", "/v0/inbox").json).toEqual({ inbox: 1 });
    const acted = answer(recording, { state: 0, member: "mem_B" }, "POST", "/v0/todos/t/resolve", '{"with":"x"}');
    expect(acted.place).toEqual({ state: 1, member: "mem_B" });
    expect(answer(recording, { ...acted.place, member: "mem_A" }, "GET", "/v0/inbox").json).toEqual({ inbox: 2 });
  });

  test("says what was not recorded, and which questions were", () => {
    const asked = answer(recording, start, "POST", "/v0/answers", '{"question":"q3"}');
    expect([asked.status, asked.json]).toEqual([404, { error: { code: "not_recorded", message: "q1\nq2" } }]);
    expect(answer(recording, start, "GET", "/v0/topics/x").json).toEqual({
      error: { code: "not_recorded", message: "" },
    });
  });

  test("starts at the beginning when the tab keeps nothing", () => {
    expect(savedPlace(recording)).toEqual(start);
    expect(savedPlace(recording, { state: 1, member: "mem_B" })).toEqual({ state: 1, member: "mem_B" });
  });
});
