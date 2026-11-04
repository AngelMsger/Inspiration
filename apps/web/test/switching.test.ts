// Picking people in quick succession: the backend and the screen both end on the person picked
// last, whatever order the answers come back in.

import { describe, expect, test } from "vitest";
import { switcher } from "../src/switching.ts";

/** A promise the test settles by hand. */
function later<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const settle = () => new Promise((done) => setTimeout(done, 0));

describe("switcher", () => {
  test("a late answer for the person picked earlier gives nothing", async () => {
    const change = switcher();
    const slow = later<string>();
    const first = change(
      () => Promise.resolve("lina"),
      () => slow.promise,
    );
    const second = change(
      () => Promise.resolve("wanglei"),
      async (who) => `${who}'s library`,
    );
    expect(await second).toEqual({ value: "wanglei's library" });
    slow.resolve("lina's library");
    expect(await first).toBeUndefined();
  });

  test("a late failure for the person picked earlier is not shown", async () => {
    const change = switcher();
    const slow = later<string>();
    const first = change(
      () => Promise.resolve("lina"),
      () => slow.promise,
    );
    const second = change(
      () => Promise.resolve("wanglei"),
      async (who) => who,
    );
    expect(await second).toEqual({ value: "wanglei" });
    slow.reject(new Error("engine down"));
    expect(await first).toBeUndefined();
  });

  test("the latest change's failure is shown", async () => {
    const change = switcher();
    await expect(
      change(
        () => Promise.reject(new Error("no such person")),
        async () => "",
      ),
    ).rejects.toThrow("no such person");
  });

  test("a request for the person waits for the one asked before it, even when that one fails", async () => {
    const change = switcher();
    const sent: string[] = [];
    const slow = later<string>();
    const first = change(
      () => {
        sent.push("lina");
        return slow.promise;
      },
      async (who) => who,
    );
    const second = change(
      () => {
        sent.push("wanglei");
        return Promise.resolve("wanglei");
      },
      async (who) => who,
    );
    await settle();
    expect(sent).toEqual(["lina"]);
    slow.reject(new Error("engine down"));
    expect(await second).toEqual({ value: "wanglei" });
    expect(sent).toEqual(["lina", "wanglei"]);
    expect(await first).toBeUndefined();
  });
});
