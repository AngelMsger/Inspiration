// Files and folders going into a space's uploads: which files a pick sends and where, what each
// answer means for the person, and sending a few at a time with retries on a dropped connection.

import type { FileWritten } from "@inspiration/contracts";
import { describe, expect, test } from "vitest";
import { ApiFailure } from "../src/api.ts";
import { MAX_FILE, mayUpload, type Outcome, plan, reasonOf, send, type Upload } from "../src/uploads.ts";

const file = (size = 3) => new Blob(["x".repeat(size)]);
const written = (changed: boolean) => ({ changed }) as FileWritten;
const states = (uploads: Upload[]) => uploads.map((u) => [u.path.join("/"), u.outcome.state]);

describe("uploads", () => {
  test("lets editors, stewards and space owners upload, and nobody else", () => {
    const roles = ["viewer", "commenter", "editor", "steward", "owner", undefined] as const;
    const may = roles.map((role) => mayUpload({ id: "spc_1", name: "Finance", owner_ids: ["mem_1"], role } as never));
    expect(may).toEqual([false, false, true, true, true, false]);
  });

  test("puts a folder's files below the folder on screen, and refuses what the engine would", () => {
    const uploads = plan(
      [
        { file: file(), relative: "policy/travel/travel-policy.docx" },
        { file: file(), relative: "policy/.DS_Store" },
        { file: file(), relative: "policy/~$travel-policy.docx" },
        { file: file(), relative: "policy/.git/config.md" },
        { file: file(), relative: "policy/photo.jpg" },
        { file: file(MAX_FILE + 1), relative: "policy/scan.PDF" },
        { file: file(), relative: "policy/readme.md" },
      ],
      ["finance"],
      (path) => path.join("/") === "finance/policy/readme.md",
    );
    expect(states(uploads)).toEqual([
      ["finance/policy/travel/travel-policy.docx", "waiting"],
      ["finance/policy/photo.jpg", "failed"],
      ["finance/policy/scan.PDF", "failed"],
      ["finance/policy/readme.md", "waiting"],
    ]);
    expect(uploads.map((u) => (u.outcome.state === "failed" ? u.outcome.reason : u.existed))).toEqual([
      false,
      "unsupported",
      "too_large",
      true,
    ]);
  });

  test("sends a file picked twice once, the later one", () => {
    const later = file(5);
    const uploads = plan(
      [
        { file: file(), relative: "a.md" },
        { file: later, relative: "a.md" },
      ],
      [],
      () => false,
    );
    expect(uploads.map((u) => u.file)).toEqual([later]);
  });

  test("says what an answer did: added, a new version, or the same bytes again", async () => {
    const uploads = plan(
      ["new.md", "changed.md", "same.md"].map((relative) => ({ file: file(), relative })),
      [],
      (path) => path[0] !== "new.md",
    );
    const outcomes: Outcome[] = [];
    await send(
      uploads,
      async (u) => written(u.path[0] !== "same.md"),
      (i, o) => (outcomes[i] = o),
    );
    expect(outcomes.map((o) => o.state)).toEqual(["added", "version", "same"]);
  });

  test("names the engine's refusals", () => {
    const why = (status: number, code: string) => reasonOf(new ApiFailure(status, code, "the message")).reason;
    expect([
      why(413, "too_large"),
      why(415, "unsupported_type"),
      why(403, "forbidden"),
      why(0, "internal"),
      why(404, "not_recorded"),
      why(400, "bad_request"),
    ]).toEqual(["too_large", "unsupported", "forbidden", "network", "recorded", "other"]);
    expect(reasonOf(new TypeError("Failed to fetch")).reason).toBe("network");
  });

  test("sends three at a time, retries a dropped connection and not a refusal", async () => {
    const uploads = plan(
      ["a", "b", "c", "d", "e", "f"].map((n) => ({ file: file(), relative: `${n}.md` })),
      [],
      () => false,
    );
    let open = 0;
    let most = 0;
    const tries = new Map<string, number>();
    const waits: number[] = [];
    const outcomes: Outcome[] = [];
    await send(
      uploads,
      async (u) => {
        const name = u.path[0] as string;
        tries.set(name, (tries.get(name) ?? 0) + 1);
        open++;
        most = Math.max(most, open);
        await new Promise((r) => setTimeout(r, 5));
        open--;
        if (name === "b.md" && (tries.get(name) ?? 0) < 2) throw new ApiFailure(0, "internal", "dropped");
        if (name === "c.md") throw new ApiFailure(0, "internal", "dropped");
        if (name === "d.md") throw new ApiFailure(415, "unsupported_type", "not read");
        return written(true);
      },
      (i, o) => (outcomes[i] = o),
      { wait: async (ms) => void waits.push(ms) },
    );
    expect(most).toBe(3);
    expect(outcomes.map((o) => (o.state === "failed" ? o.reason : o.state))).toEqual([
      "added",
      "added",
      "network",
      "unsupported",
      "added",
      "added",
    ]);
    expect(Object.fromEntries(tries)).toMatchObject({ "b.md": 2, "c.md": 3, "d.md": 1 });
    expect(waits.sort()).toEqual([1000, 1000, 2000]);
  });
});
