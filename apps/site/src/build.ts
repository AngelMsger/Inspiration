/**
 * The product website: one static page per language, built from the language packs in
 * `apps/site/languages/`. Each page is a single HTML file with its styles and its script
 * inlined, so it can be served from any static host. The page for the root language is
 * `index.html`; every other language is `<tag>/index.html`.
 *
 * The page carries a scripted demo of the product (the hotel cap story of the demo corpus),
 * drawn in the product's own look; it is an illustration, not the product. While the product
 * is in active development the site offers early access by mail and no download.
 *
 * Usage (`pnpm site` runs this file):
 *
 *   node apps/site/src/build.ts                    write the pages to apps/site/dist
 *   node apps/site/src/build.ts --out <dir>        somewhere else
 *   node apps/site/src/build.ts --root zh          put another language at the root
 *   node apps/site/src/build.ts --preview          root page without its document shell and
 *                                                  links ending in index.html, for an Artifact
 *   node apps/site/src/build.ts --serve [--port n] serve, rebuilding on every request
 *
 * A pack with a missing or extra key, or a key of another type than in `en.yaml`, fails the
 * build with a RangeError naming it.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parse } from "yaml";
import { type Pack, renderPage } from "./page.ts";

const SITE = fileURLToPath(new URL("../", import.meta.url));
/** The pack every other pack must match key for key. */
const REFERENCE = "en";
/** Lists whose length is up to each language: the fonts a script needs. */
const FREE_LENGTH = new Set(["meta.fonts"]);

export interface BuildOptions {
  /** The language whose page is `index.html`. */
  root: string;
  /** Links end in `index.html`, for hosts that do not serve a folder's index. */
  explicitIndex: boolean;
  /** The root page without its document shell. */
  fragment: boolean;
}

/** The shape of a value, for comparing packs: its key paths, with the length of each list. */
function shape(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) {
    if (FREE_LENGTH.has(path)) return [`${path}[]`];
    return [`${path}[${value.length}]`, ...value.flatMap((v, i) => shape(v, `${path}[${i}]`))];
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => shape(v, path ? `${path}.${k}` : k));
  }
  return [`${path}:${typeof value}`];
}

/** Every pack in `languages/`, checked against the reference pack, sorted by tag. */
export function loadPacks(dir = join(SITE, "languages")): { tag: string; pack: Pack }[] {
  const packs = readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .map((f) => ({ tag: f.slice(0, -".yaml".length), pack: parse(readFileSync(join(dir, f), "utf8")) as Pack }));
  const reference = packs.find((p) => p.tag === REFERENCE);
  if (!reference) throw new RangeError(`site: no ${REFERENCE}.yaml in ${dir}`);
  const expected = new Set(shape(reference.pack));
  for (const { tag, pack } of packs) {
    const found = new Set(shape(pack));
    const missing = [...expected].filter((k) => !found.has(k));
    const extra = [...found].filter((k) => !expected.has(k));
    if (missing.length || extra.length) {
      throw new RangeError(
        `site: languages/${tag}.yaml differs from ${REFERENCE}.yaml: ${[...missing, ...extra].join(", ")}`,
      );
    }
  }
  return packs;
}

/** Where the contact address and other settings of the build live. */
function settings(): { contact: string } {
  const s = parse(readFileSync(join(SITE, "site.yaml"), "utf8")) as { contact?: unknown };
  if (typeof s.contact !== "string" || !s.contact.includes("@"))
    throw new RangeError("site.yaml: contact is not an address");
  return { contact: s.contact };
}

/** The page of each language as a path relative to the output folder, with its HTML. */
export function build(options: BuildOptions): Map<string, string> {
  const packs = loadPacks();
  if (!packs.some((p) => p.tag === options.root))
    throw new RangeError(`site: no language pack for root ${options.root}`);
  const css = readFileSync(join(SITE, "src/site.css"), "utf8");
  const script = stripTypeScriptTypes(readFileSync(join(SITE, "src/client/demo.ts"), "utf8"));
  const { contact } = settings();
  const pages = new Map<string, string>();
  for (const { tag, pack } of packs) {
    const depth = tag === options.root ? 0 : 1;
    const href = (to: string) =>
      `${"../".repeat(depth)}${to === options.root ? "" : `${to}/`}${options.explicitIndex ? "index.html" : ""}` ||
      "./";
    const path = tag === options.root ? "index.html" : `${tag}/index.html`;
    const fragment = options.fragment && tag === options.root;
    pages.set(path, renderPage({ tag, pack, packs, href, contact, css, script, fragment }));
  }
  return pages;
}

function write(pages: Map<string, string>, out: string): void {
  rmSync(out, { recursive: true, force: true });
  for (const [path, html] of pages) {
    mkdirSync(dirname(join(out, path)), { recursive: true });
    writeFileSync(join(out, path), html);
  }
}

function serve(options: BuildOptions, port: number): void {
  createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/^\//, "").replace(/(^|\/)$/, "$1index.html");
    try {
      const html = build(options).get(path);
      res.writeHead(html ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
      res.end(html ?? "Not found");
    } catch (error) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(String(error));
    }
  }).listen(port, () => console.log(`site: http://localhost:${port}/`));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { values } = parseArgs({
    options: {
      out: { type: "string", default: join(SITE, "dist") },
      root: { type: "string" },
      preview: { type: "boolean", default: false },
      serve: { type: "boolean", default: false },
      port: { type: "string", default: "4321" },
    },
  });
  const options: BuildOptions = {
    root: values.root ?? REFERENCE,
    explicitIndex: values.preview,
    fragment: values.preview,
  };
  if (values.serve) serve(options, Number(values.port));
  else {
    const pages = build(options);
    write(pages, values.out);
    console.log(`site: ${[...pages.keys()].join(", ")} in ${values.out}`);
  }
}
