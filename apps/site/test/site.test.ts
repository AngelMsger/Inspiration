import { describe, expect, test } from "vitest";
import { build, loadPacks } from "../src/build.ts";

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
});
