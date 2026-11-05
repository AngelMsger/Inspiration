// A snapshot: the demo script it records, and how its page answers from the recording.

import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { loadPeople } from "../src/backend.ts";
import { addressOf, answer, callKey, type Recording, replayed, savedPlace, startOf } from "../src/replay.ts";
import { answerModel, loadScript, questionsOf } from "../src/snapshot.ts";

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
    // Every ask in the demo is the one hotel question, put again after each change, in each
    // language the app speaks, so the answer comes in the language the page shows.
    expect(questionsOf(steps)).toHaveLength(3);
    for (const step of steps.filter((s) => typeof s.open !== "string"))
      expect(Object.keys(step.open).sort()).toEqual(["en", "ja", "zh"]);
  });

  test("opens a step in the page's language, else in English", () => {
    const [step] = loadScript("steps: [{as: mem_x, open: {en: /ask?q=hotel, ja: /ask?q=hoteru}, text: {en: Ask}}]");
    expect(step && addressOf(step, "ja")).toBe("/ask?q=hoteru");
    expect(step && addressOf(step, "zh")).toBe("/ask?q=hotel");
    expect(addressOf({ as: "mem_x", open: "/inbox", text: {} }, "ja")).toBe("/inbox");
  });

  test("refuses steps without a member, an address and words", () => {
    expect(() => loadScript("steps: [{as: mem_x, open: inbox, text: {}}]")).toThrow(RangeError);
    expect(() => loadScript("steps: [{as: mem_x, open: {en: inbox}, text: {}}]")).toThrow(RangeError);
    expect(() => loadScript("steps: [{as: mem_x, open: {}, text: {}}]")).toThrow(RangeError);
    expect(() => loadScript("steps: []")).toThrow(RangeError);
  });
});

describe("the model a recording names", () => {
  test("is the one a gateway config prefers for answers, unless it is a stand-in", async () => {
    const demo = await readFile(fileURLToPath(new URL("../../../config/gateway.demo.yaml", import.meta.url)), "utf8");
    expect(answerModel(demo)).toBe("deepseek-flash");
    const dev = await readFile(fileURLToPath(new URL("../../../config/gateway.dev.yaml", import.meta.url)), "utf8");
    expect(answerModel(dev)).toBeUndefined();
    const faked =
      "providers: [{name: cloud, kind: fake}]\nroutes: [{match: 'retrieval.*', prefer: [cloud/fake-flash]}]";
    expect(answerModel(faked)).toBeUndefined();
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
    bodies: { one: { inbox: 1 }, two: { inbox: 2 }, done: { ok: true }, spaces: { tenant: { name: "Hengyuan" } } },
    states: [
      {
        mem_A: {
          [callKey("GET", "/v0/inbox")]: { status: 200, body: "one" },
          [callKey("GET", "/v0/spaces")]: { status: 200, body: "spaces" },
        },
        mem_B: { [callKey("POST", "/v0/todos/t/resolve", '{"with":"x"}')]: { status: 200, body: "done", next: 1 } },
      },
      { mem_A: { [callKey("GET", "/v0/inbox")]: { status: 200, body: "two" } } },
    ],
  };
  const start = { state: 0, member: "mem_A" };

  test("is signed in as the place's person, and acts as another when asked", () => {
    expect(answer(recording, start, "GET", "/session").json).toMatchObject({
      account: { name: "A" },
      companies: [{ tenant_id: "ten_1", name: "Hengyuan" }],
      current: { member_id: "mem_A", display_name: "A", role: "member" },
    });
    const moved = answer(recording, start, "POST", "/demo/act-as", '{"member":"mem_B"}');
    expect([moved.json, moved.place]).toMatchObject([
      { current: { member_id: "mem_B" } },
      { state: 0, member: "mem_B" },
    ]);
    expect(answer(recording, start, "POST", "/demo/act-as", '{"member":"mem_C"}').status).toBe(400);
    expect(answer(recording, start, "GET", "/members").json).toMatchObject({
      members: [{ member_id: "mem_A" }, { member_id: "mem_B" }],
    });
    expect(answer(recording, start, "PATCH", "/account", '{"locale":"ja"}').json).toMatchObject({
      account: { locale: "ja" },
    });
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

  test("starts at the beginning, as the first person, when the tab keeps nothing", () => {
    expect([startOf(recording), savedPlace(recording)]).toEqual([start, start]);
  });

  test("keeps the members and invite links the tab changes, and the people the script acts as", () => {
    const c = { member: "mem_C", name: "C" };
    const company: Recording = {
      ...recording,
      people: { tenant: "ten_1", people: [{ ...a, role: "super_admin" }, b, c] },
      steps: [{ as: "mem_B", open: "/inbox", text: {} }],
    };
    const tab = replayed(company, "https://demo.example/");
    const as = (member: string) => ({ state: 0, member });
    const ask = (member: string, method: string, path: string, body?: string) =>
      answer(company, as(member), method, path, body, tab);
    const made = ask("mem_A", "POST", "/invites", "{}");
    const url = (made.json as { url: string }).url;
    expect([made.status, url]).toEqual([201, expect.stringMatching(/^https:\/\/demo\.example\/#\/join\//)]);
    const code = url.split("/").pop() as string;
    expect(ask("mem_C", "GET", `/join/${code}`).json).toMatchObject({ company: { name: "Hengyuan" } });
    expect(ask("mem_B", "GET", "/invites").status).toBe(403);
    expect(ask("mem_A", "DELETE", "/members/mem_B").json).toMatchObject({ error: { code: "demo_script" } });
    expect(ask("mem_A", "DELETE", "/members/mem_C").status).toBe(204);
    expect(ask("mem_A", "GET", "/members").json).toMatchObject({
      members: [{ member_id: "mem_A" }, { member_id: "mem_B" }],
    });
    expect(ask("mem_C", "GET", "/session").json).toMatchObject({ companies: [] });
    expect(ask("mem_C", "GET", "/members").status).toBe(400);
    expect(ask("mem_C", "POST", `/join/${code}`, "{}").json).toMatchObject({ current: { member_id: "mem_C" } });
    expect(ask("mem_A", "GET", "/invites").json).toMatchObject({ invites: [{ joined: 1 }] });
    // Another tab starts from the recording again.
    expect(answer(company, as("mem_C"), "GET", "/session").json).toMatchObject({ current: { member_id: "mem_C" } });
  });
});
