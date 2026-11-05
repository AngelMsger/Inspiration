/**
 * The product website: one static page per language, built from the language packs in
 * `apps/site/languages/`. Each page is a single HTML file with its styles and its scripts
 * inlined, so it can be served from any static host. The page for the root language is
 * `index.html`; every other language is `<tag>/index.html`.
 *
 * Beside the headline, a figure shows four kinds of source (a wiki, an approval flow, a code
 * repository, a research report) feeding one topic that answers people and agents; while it is
 * in view, a few changes run through it and then it rests. Further down, two scripted demos tell
 * the hotel cap story of the demo corpus in the product's own look: its search box, asked where
 * five documents disagree, and its window, as a new notice changes the answer. They repeat while
 * in view. All three are illustrations, not the product, and hold still on their result with
 * reduced motion or without script. While the product
 * is in active development the site offers no download and no sign-up, and says so once, in
 * its closing lines.
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
 * Every link is relative, so the pages work under any path. `.github/workflows/site.yml` builds
 * them on main and publishes them to GitHub Pages once the repository is public. The web fonts
 * load without blocking, so the page renders at once in system fonts where they are slow or
 * unreachable.
 *
 * A pack with a missing or extra key, or a key of another type than in `en.yaml`, fails the
 * build with a RangeError naming it.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
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

/** The page of each language as a path relative to the output folder, with its HTML. */
export function build(options: BuildOptions): Map<string, string> {
  const packs = loadPacks();
  if (!packs.some((p) => p.tag === options.root))
    throw new RangeError(`site: no language pack for root ${options.root}`);
  const css = readFileSync(join(SITE, "src/site.css"), "utf8");
  const client = (name: string) => stripTypeScriptTypes(readFileSync(join(SITE, `src/client/${name}.ts`), "utf8"));
  const scripts = { hero: client("hero"), ask: client("ask"), demo: client("demo") };
  const pages = new Map<string, string>();
  for (const { tag, pack } of packs) {
    const depth = tag === options.root ? 0 : 1;
    const href = (to: string) =>
      `${"../".repeat(depth)}${to === options.root ? "" : `${to}/`}${options.explicitIndex ? "index.html" : ""}` ||
      "./";
    const path = tag === options.root ? "index.html" : `${tag}/index.html`;
    const fragment = options.fragment && tag === options.root;
    pages.set(path, renderPage({ tag, pack, packs, href, css, scripts, fragment }));
  }
  return pages;
}

/**
 * Writes the pages built with `root` into `out`. The folder may hold other files, so only the
 * builder's own paths are touched: every page is overwritten, and the root language's
 * `<root>/index.html`, left by an earlier build with another root, is removed.
 */
export function write(pages: Map<string, string>, out: string, root: string): void {
  const stale = join(out, root);
  rmSync(join(stale, "index.html"), { force: true });
  if (existsSync(stale) && readdirSync(stale).length === 0) rmdirSync(stale);
  for (const [path, html] of pages) {
    mkdirSync(dirname(join(out, path)), { recursive: true });
    writeFileSync(join(out, path), html);
  }
}

/** The page a request target asks for, or undefined when the target is not a URL path. */
function pageFor(target: string): string | undefined {
  if (!URL.canParse(target, "http://localhost")) return undefined;
  const { pathname } = new URL(target, "http://localhost");
  return pathname.replace(/^\//, "").replace(/(^|\/)$/, "$1index.html");
}

/** A server for the pages that rebuilds them on every request, so an edit shows on reload. */
export function server(options: BuildOptions): Server {
  return createServer((req, res) => {
    const text = (status: number, body: string) => {
      res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
      res.end(body);
    };
    const path = pageFor(req.url ?? "/");
    if (path === undefined) return text(400, "Bad request");
    try {
      const html = build(options).get(path);
      if (!html) return text(404, "Not found");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (error) {
      text(500, String(error));
    }
  });
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
  if (values.serve) {
    const port = Number(values.port);
    server(options).listen(port, () => console.log(`site: http://localhost:${port}/`));
  } else {
    const pages = build(options);
    write(pages, values.out, options.root);
    console.log(`site: ${[...pages.keys()].join(", ")} in ${values.out}`);
  }
}
