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
      // Links are relative, so the site works under a project path such as GitHub Pages gives.
      expect(markup, path).not.toMatch(/(href|src)="\/(?!\/)/);
      // Where the web fonts cannot be reached the page still renders at once, in system fonts.
      expect(markup, path).toMatch(/<link rel="stylesheet" href="https:\/\/fonts[^"]*" media="print" onload=/);
    }
    // The page says once, at its end, that the product is still being built.
    for (const { tag, pack } of loadPacks()) {
      const html = pages.get(tag === "en" ? "index.html" : `${tag}/index.html`) ?? "";
      expect(html.split(pack.closing.note).length - 1, tag).toBe(1);
      expect(html.indexOf(pack.closing.note), tag).toBeGreaterThan(html.indexOf('id="enterprise"'));
    }
    expect(pages.get("zh/index.html")).toContain('<html lang="zh-CN">');
    expect(pages.get("ja/index.html")).toContain('href="../zh/"');
    expect(pages.get("index.html")).toContain('href="ja/"');
  });

  test("the header offers every language in a menu, marks the current one, and links to the source", () => {
    const pages = build({ root: "en", explicitIndex: false, fragment: false });
    for (const [path, html] of pages) {
      const header = /<header class="top">[\s\S]*?<\/header>/.exec(html)?.[0] ?? "";
      const menu = /<details class="lang-menu">[\s\S]*?<\/details>/.exec(header)?.[0] ?? "";
      expect(menu.match(/<li>/g), path).toHaveLength(LANGUAGES.length);
      expect(menu.match(/aria-current="page"/g), path).toHaveLength(1);
      expect(header, path).toContain('class="gh" href="https://github.com/');
    }
    expect(pages.get("zh/index.html")).toMatch(/<a href="\.\.\/zh\/" aria-current="page" lang="zh-CN">/);
  });

  test("examples name products used where each language is read: Feishu only on the Chinese page", () => {
    const pages = build({ root: "en", explicitIndex: false, fragment: false });
    for (const path of ["index.html", "ja/index.html"])
      expect(pages.get(path), path).not.toMatch(/Feishu|\u98de\u4e66/);
    expect(pages.get("zh/index.html")).toMatch(/\u98de\u4e66/);
  });

  test("the inlined scripts, for the language menu, the hero figure, the search box and the demo, are valid JavaScript", () => {
    const html = build({ root: "en", explicitIndex: false, fragment: false }).get("index.html") ?? "";
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? "");
    expect(scripts).toHaveLength(4);
    for (const script of scripts) {
      expect(script.length).toBeGreaterThan(0);
      expect(() => new Function(script)).not.toThrow();
    }
  });

  test("the hero figure and the sources section show the same four kinds of source", () => {
    const html = build({ root: "en", explicitIndex: false, fragment: false }).get("index.html") ?? "";
    const figure = /<figure class="hero-fig"[\s\S]*?<\/figure>/.exec(html)?.[0] ?? "";
    expect(figure.match(/class="feed"/g)).toHaveLength(4);
    expect(figure.match(/class="flow"/g)).toHaveLength(4);
    expect(figure.match(/class="topic-fact"/g)).toHaveLength(4);
    const sources = /<section class="origins"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
    expect(sources.match(/class="kind"/g)).toHaveLength(4);
    expect(sources.match(/class="smp smp-/g)).toHaveLength(4);
  });

  test("the results show three measured figures, Inspiration's bar first, and link to their method", () => {
    const pages = build({ root: "en", explicitIndex: false, fragment: false });
    for (const [path, html] of pages) {
      const section = /<section class="results"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
      expect(section.match(/class="result"/g), path).toHaveLength(3);
      expect(section.match(/class="res-track"/g), path).toHaveLength(6);
      expect(section.match(/class="res-bar ours"/g), path).toHaveLength(3);
      // The research behind the mechanism is linked as support, not featured: no author named.
      expect(section, path).toContain('href="https://arxiv.org/abs/2611.04169v1"');
      expect(section, path).not.toContain("Liu");
    }
    const en = pages.get("index.html") ?? "";
    for (const shown of ["178 of 204", "164 of 204", "27 of 27", "16 of 27", "CNY 0.0012", "CNY 0.0083"])
      expect(en).toContain(shown);
    // Each language links to the method in its own copy where there is one, and the file exists.
    for (const { tag, pack } of loadPacks())
      expect(existsSync(new URL(`../../../${pack.results.methodPath}`, import.meta.url)), tag).toBe(true);
  });

  test("the search box lists every document of the story and is rendered answered", () => {
    for (const { tag, pack } of loadPacks()) {
      const html = build({ root: "en", explicitIndex: false, fragment: false }).get(
        tag === "en" ? "index.html" : `${tag}/index.html`,
      );
      const box = /<div class="palette"[\s\S]*?<\/ul>/.exec(html ?? "")?.[0] ?? "";
      expect(box.match(/<li class="pal-doc[ "]/g), tag).toHaveLength(pack.problem.documents.length);
      expect(box.match(/class="pill old mark"/g), tag).toHaveLength(
        pack.problem.documents.filter((d) => d.mark === "old").length,
      );
    }
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
