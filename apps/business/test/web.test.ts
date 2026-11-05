import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { type Backend, startBackend } from "./fixtures.ts";

let site: Backend;
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "inspiration-web-"));
  await mkdir(join(dir, "assets"));
  await writeFile(join(dir, "index.html"), "<!doctype html><title>Inspiration</title>");
  await writeFile(join(dir, "assets", "app-1a2b.js"), "console.log(1)");
  await writeFile(join(dir, "favicon.svg"), "<svg/>");
  site = await startBackend({ webDir: dir });
});
afterAll(async () => {
  await site.close();
  await rm(dir, { recursive: true, force: true });
});

const get = (path: string, method = "GET") => fetch(`${site.url}${path}`, { method });

test("answers every page of the app with index.html, never kept", async () => {
  for (const path of ["/", "/spaces/spc_1", "/join/abc"]) {
    const res = await get(path);
    expect([res.status, res.headers.get("content-type"), res.headers.get("cache-control")]).toEqual([
      200,
      "text/html; charset=utf-8",
      "no-cache",
    ]);
    expect(await res.text()).toContain("<title>Inspiration</title>");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  }
});

test("keeps hashed assets for a year, and answers 404 for one that is not there", async () => {
  const res = await get("/assets/app-1a2b.js");
  expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  expect(await res.text()).toBe("console.log(1)");
  expect((await get("/assets/app-0000.js")).status).toBe(404);
  expect((await get("/favicon.svg")).headers.get("content-type")).toBe("image/svg+xml");
  expect(await (await get("/assets/app-1a2b.js", "HEAD")).text()).toBe("");
});

test("serves nothing outside its folder, and leaves /api/ to the API", async () => {
  expect(await (await get("/%2e%2e/%2e%2e/package.json")).text()).toContain("<title>Inspiration</title>");
  expect(await (await get("/..%2f..%2fpackage.json")).text()).not.toContain("inspiration-workspace");
  expect((await get("/api/nothing")).status).toBe(404);
  expect((await get("/.well-known/nothing")).status).toBe(404);
  expect((await get("/", "POST")).status).toBe(404);
});
