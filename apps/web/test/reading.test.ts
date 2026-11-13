// Following how far the engine has read a space's documents: counting them by state, and asking
// for a space's tree again only while some of its documents are waiting or being read.

import type { DocumentEntry, DocumentTree, DocumentTreeNode, ReadingState } from "@inspiration/contracts";
import { describe, expect, test } from "vitest";
import { countsOf, delayOf, follow, going, stateOf } from "../src/reading.ts";

const doc = (name: string, state?: ReadingState): DocumentTreeNode => ({
  kind: "document",
  name,
  source_id: "src_1",
  path: [name],
  document: {
    source_id: "src_1",
    external_id: `${name}.md`,
    title: name,
    fetched_at: "2026-11-05T06:00:00Z",
    ...(state && { reading: { state } }),
  } as DocumentEntry,
});

const tree = (space: string, waiting: number, reading = 0): DocumentTree => ({
  space_id: space,
  sources: [],
  reading: { waiting, reading, read: 1, paused: 0, failed: 0 },
});

describe("reading", () => {
  test("counts the documents below a node by state, taking one the engine says nothing of as read", () => {
    const folder: DocumentTreeNode = {
      kind: "folder",
      name: "policy",
      source_id: "src_1",
      path: ["policy"],
      children: [doc("travel", "reading"), doc("budget", "failed"), doc("handbook")],
    };
    expect(countsOf([folder, doc("notes", "paused"), doc("plan", "reading")])).toEqual({
      waiting: 0,
      reading: 2,
      read: 1,
      paused: 1,
      failed: 1,
    });
    expect(stateOf(doc("handbook").document as DocumentEntry)).toBe("read");
  });

  test("follows a tree while documents wait or are read, including paused work that will automatically resume", () => {
    expect(going(tree("spc_1", 1))).toBe(true);
    expect(going(tree("spc_1", 0, 2))).toBe(true);
    expect(going({ ...tree("spc_1", 0), reading: { waiting: 0, reading: 0, read: 0, paused: 3, failed: 1 } })).toBe(
      true,
    );
    expect(going({ space_id: "spc_1", sources: [] })).toBe(false);
  });

  test("waits longer each time, up to half a minute", () => {
    expect([0, 1, 2, 3, 20].map(delayOf)).toEqual([2000, 3000, 4500, 6750, 30_000]);
  });

  test("asks for each space again until it settles, and again after a failed read", async () => {
    const answers: Record<string, (DocumentTree | Error)[]> = {
      spc_1: [tree("spc_1", 2), tree("spc_1", 0, 1), tree("spc_1", 0)],
      spc_2: [new Error("dropped"), tree("spc_2", 0)],
    };
    const asked: string[] = [];
    const heard: string[] = [];
    const waits: number[] = [];
    const settled = await follow(
      ["spc_1", "spc_2"],
      async (space) => {
        asked.push(space);
        const next = answers[space]?.shift();
        if (!next || next instanceof Error) throw next ?? new Error("none left");
        return next;
      },
      (t) => heard.push(`${t.space_id}:${t.reading?.waiting}/${t.reading?.reading}`),
      { signal: new AbortController().signal, wait: async (ms) => void waits.push(ms) },
    );
    expect(settled).toBe(true);
    expect(asked).toEqual(["spc_1", "spc_2", "spc_1", "spc_2", "spc_1"]);
    expect(heard).toEqual(["spc_1:2/0", "spc_1:0/1", "spc_2:0/0", "spc_1:0/0"]);
    expect(waits).toEqual([2000, 3000, 4500]);
  });

  test("stops when the page leaves, without saying the spaces settled", async () => {
    const stop = new AbortController();
    const asked: string[] = [];
    const settled = await follow(
      ["spc_1"],
      async (space) => {
        asked.push(space);
        stop.abort();
        return tree(space, 1);
      },
      () => {},
      { signal: stop.signal, wait: async () => {} },
    );
    expect(settled).toBe(false);
    expect(asked).toEqual(["spc_1"]);
  });
});
