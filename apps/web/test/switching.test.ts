// Picking people, or companies, in quick succession: the backend and the screen both end on the
// one picked last, whatever order the answers come back in, and the frame takes no clicks while
// the backend may act for another company than the one it shows.

import { describe, expect, test } from "vitest";
import { keptFor, switcher } from "../src/switching.ts";

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

describe("changing company", () => {
  // Two companies that happen to hold the same member ID, and a backend whose current company is
  // the one the last request to land named.
  const SAME = "mem_01SAMEMEMBER";
  const backend = () => {
    const state = { current: "ten_HENGYUAN" };
    return {
      state,
      enter: async (tenant: string) => {
        state.current = tenant;
        return { tenant_id: tenant, member_id: SAME };
      },
    };
  };

  test("a library read for the company left behind never shows under the next one", async () => {
    const heard: boolean[] = [];
    const change = switcher((on) => heard.push(on));
    const server = backend();
    const qinghe = later<string>();
    // Into Qinghe, whose library is slow, then straight back to Hengyuan.
    const toQinghe = change(
      () => server.enter("ten_QINGHE"),
      () => qinghe.promise,
    );
    const back = change(
      () => server.enter("ten_HENGYUAN"),
      async (s) => `${s.tenant_id} library`,
    );
    expect(await back).toEqual({ value: "ten_HENGYUAN library" });
    qinghe.resolve("ten_QINGHE library");
    expect(await toQinghe).toBeUndefined();
    // The backend ends where the screen does.
    expect(server.state.current).toBe("ten_HENGYUAN");
    expect(heard).toEqual([true, true, false]);
  });

  test("the frame is busy from the moment the backend may act for another company", async () => {
    let busy = false;
    const change = switcher((on) => {
      busy = on;
    });
    const server = backend();
    const library = later<string>();
    const entered = change(
      () => server.enter("ten_QINGHE"),
      () => library.promise,
    );
    await settle();
    // The backend acts for Qinghe while the screen still shows Hengyuan: nothing may be done there.
    expect([server.state.current, busy]).toEqual(["ten_QINGHE", true]);
    library.resolve("ten_QINGHE library");
    await entered;
    expect(busy).toBe(false);
  });

  test("a failed change leaves the frame busy no longer", async () => {
    let busy = false;
    const change = switcher((on) => {
      busy = on;
    });
    await expect(
      change(
        () => Promise.reject(new Error("not a company of this account")),
        async () => "",
      ),
    ).rejects.toThrow();
    expect(busy).toBe(false);
  });

  test("what was read for a member of one company is not kept for the same member ID in another", () => {
    const read = { tenant: "ten_HENGYUAN", member: SAME, library: "Hengyuan library" };
    expect(keptFor(read, { tenant_id: "ten_HENGYUAN", member_id: SAME })).toBe(read);
    expect(keptFor(read, { tenant_id: "ten_QINGHE", member_id: SAME })).toBeUndefined();
    expect(keptFor(read, { tenant_id: "ten_HENGYUAN", member_id: "mem_01SOMEONEELSE" })).toBeUndefined();
    expect(keptFor(undefined, { tenant_id: "ten_HENGYUAN", member_id: SAME })).toBeUndefined();
  });
});
