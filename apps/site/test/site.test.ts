import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { build, loadPacks, server, write } from "../src/build.ts";

const LANGUAGES = ["en", "ja", "zh"];

describe("site", () => {
  test("every language the product serves has a pack with the same keys as English", () => {
    expect(loadPacks().map((p) => p.tag)).toEqual(LANGUAGES);
  });

  test("builds one complete page per language, the root language at index.html", () => {
    const pages = build({ root: "en", explicitIndex: false, fragment: false });
    expect([...pages.keys()].sort()).toEqual(["index.html", "ja/index.html", "zh/index.html"]);
    for (const [path, html] of pages) {
      expect(html.startsWith("<!doctype html>"), path).toBe(true);
      const markup = html.replace(/<script>[\s\S]*?<\/script>/g, "");
      expect(markup, path).not.toMatch(/undefined|\[object Object\]/);
      // Without script the demo shows its result.
      expect(html, path).toContain('class="stage is-changed is-todo is-confirmed"');
      // No download or sign-up is offered while the product is in development.
      expect(html, path).not.toMatch(/download=|\.dmg|\.exe|\.zip|mailto:|<form/);
    }
    expect(pages.get("zh/index.html")).toContain('<html lang="zh-CN">');
    expect(pages.get("ja/index.html")).toContain('href="../zh/"');
    expect(pages.get("index.html")).toContain('href="ja/"');
  });

  test("the inlined demo script is valid JavaScript", () => {
    const html = build({ root: "en", explicitIndex: false, fragment: false }).get("index.html") ?? "";
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
    expect(script.length).toBeGreaterThan(0);
    expect(() => new Function(script)).not.toThrow();
  });

  test("a preview puts another language at the root, without its shell, with explicit links", () => {
    const pages = build({ root: "zh", explicitIndex: true, fragment: true });
    const root = pages.get("index.html") ?? "";
    expect(root.startsWith("<!doctype")).toBe(false);
    expect(root).toContain('lang="zh-CN"');
    expect(root).toContain('href="en/index.html"');
    expect(pages.get("en/index.html")).toContain('href="../index.html"');
  });

  test("writing into a folder keeps its other files and drops a page from a build with another root", () => {
    const out = mkdtempSync(join(tmpdir(), "site-"));
    try {
      mkdirSync(join(out, "assets"));
      writeFileSync(join(out, "assets/logo.svg"), "<svg/>");
      writeFileSync(join(out, "CNAME"), "example.com");
      write(build({ root: "zh", explicitIndex: false, fragment: false }), out, "zh");
      expect(existsSync(join(out, "en/index.html"))).toBe(true);
      write(build({ root: "en", explicitIndex: false, fragment: false }), out, "en");
      expect(readFileSync(join(out, "assets/logo.svg"), "utf8")).toBe("<svg/>");
      expect(readFileSync(join(out, "CNAME"), "utf8")).toBe("example.com");
      expect(existsSync(join(out, "en"))).toBe(false);
      expect(readFileSync(join(out, "index.html"), "utf8")).toContain('<html lang="en">');
      expect(existsSync(join(out, "zh/index.html"))).toBe(true);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  test("the preview server answers a target that is not a URL path with 400 and keeps serving", async () => {
    const s = server({ root: "en", explicitIndex: false, fragment: false }).listen(0, "127.0.0.1");
    await once(s, "listening");
    const { port } = s.address() as AddressInfo;
    const status = (path: string) =>
      new Promise<number | undefined>((resolve, reject) => {
        get({ host: "127.0.0.1", port, path }, (res) => {
          res.resume();
          resolve(res.statusCode);
        }).on("error", reject);
      });
    try {
      expect(await status("//[")).toBe(400);
      expect(await status("/")).toBe(200);
      expect(await status("/ja/")).toBe(200);
      expect(await status("/fr/")).toBe(404);
    } finally {
      s.close();
    }
  });
});
