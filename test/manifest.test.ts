// components.yaml must agree with the event catalogue, the plugin groups and the workspace.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { contractErrors, EVENT_TYPES } from "@inspiration/contracts";
import { GROUPS } from "@inspiration/kernel";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";

interface Component {
  title: string;
  layer: string;
  status: string;
  runtime: string;
  owns: string;
  owner?: string;
  plugins: string[];
  publishes: string[];
  subscribes: string[];
  calls: string[];
}

interface PackageJson {
  name: string;
  dependencies?: Record<string, string>;
  inspiration?: { plugins?: Record<string, unknown> };
}

const ROOT = new URL("../", import.meta.url);
const manifest = parse(readFileSync(new URL("components.yaml", ROOT), "utf8")) as {
  components: Record<string, Component>;
  libraries: Record<string, { owns: string }>;
};
const components = Object.entries(manifest.components);
const names = new Set(Object.keys(manifest.components));
const libraries = new Set(Object.keys(manifest.libraries));

function packageJson(name: string): PackageJson | undefined {
  const path = new URL(`packages/${name}/package.json`, ROOT);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as PackageJson) : undefined;
}

const internalDependencies = (p: PackageJson) =>
  Object.keys(p.dependencies ?? {})
    .filter((d) => d.startsWith("@inspiration/"))
    .map((d) => d.slice("@inspiration/".length));

describe("components", () => {
  test.each(components)("%s is well formed", (name, c) => {
    expect(contractErrors("ComponentName", name)).toEqual([]);
    expect(libraries.has(name)).toBe(false);
    expect(["ingest", "compile", "store", "serve", "control"]).toContain(c.layer);
    expect(["built", "planned", "in_progress"]).toContain(c.status);
    expect(["node", "python"]).toContain(c.runtime);
    expect(c.title && c.owns).toBeTruthy();
    expect(c.plugins.filter((g) => !(GROUPS as readonly string[]).includes(g))).toEqual([]);
    expect(c.calls.filter((d) => d !== "blobs" && !names.has(d))).toEqual([]);
    expect(c.calls).not.toContain(name);
  });

  test.each(components.filter(([, c]) => c.status === "built"))("%s matches its package", (name, c) => {
    const pkg = packageJson(name);
    expect(pkg?.name).toBe(`@inspiration/${name}`);
    expect(Object.keys(pkg?.inspiration?.plugins ?? {}).sort()).toEqual([...c.plugins].sort());
    // The package may depend on libraries and on the components it calls, nothing else.
    const allowed = new Set([...libraries, ...c.calls]);
    expect(internalDependencies(pkg as PackageJson).filter((d) => !allowed.has(d))).toEqual([]);
  });

  test("synchronous calls have no cycles", () => {
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (name: string, path: string[]): void => {
      if (done.has(name)) return;
      if (visiting.has(name)) throw new Error(`call cycle: ${[...path, name].join(" -> ")}`);
      visiting.add(name);
      for (const callee of manifest.components[name]?.calls ?? []) visit(callee, [...path, name]);
      visiting.delete(name);
      done.add(name);
    };
    for (const name of names) visit(name, []);
  });
});

test("every event has a producer and a consumer", () => {
  const catalogue = new Set<string>(EVENT_TYPES);
  const published = new Set(components.flatMap(([, c]) => c.publishes));
  const consumed = new Set(components.flatMap(([, c]) => c.subscribes));
  expect([...published, ...consumed].filter((e) => !catalogue.has(e))).toEqual([]);
  expect(EVENT_TYPES.filter((e) => !published.has(e))).toEqual([]); // events nobody publishes
  expect(EVENT_TYPES.filter((e) => !consumed.has(e))).toEqual([]); // events nobody consumes
});

test("libraries depend only on libraries", () => {
  for (const name of libraries) {
    const pkg = packageJson(name);
    expect(pkg?.name).toBe(`@inspiration/${name}`);
    expect(internalDependencies(pkg as PackageJson).filter((d) => !libraries.has(d))).toEqual([]);
  }
});

test("every workspace package is a component or a library", () => {
  const packages = readdirSync(new URL("packages/", ROOT)).filter((d) => packageJson(d));
  expect(packages.filter((p) => !names.has(p) && !libraries.has(p))).toEqual([]);
  const built = components.filter(([, c]) => c.status === "built").map(([n]) => n);
  expect(packages.filter((p) => names.has(p)).sort()).toEqual(built.sort());
});

test("the event table in docs/contracts.md matches the manifest", () => {
  const doc = readFileSync(new URL("docs/contracts.md", ROOT), "utf8");
  const rows = [...doc.matchAll(/^\| `([a-z_.]+)` \| ([^|]+) \| ([^|]+) \|$/gm)];
  const list = (cell: string) =>
    cell
      .split(",")
      .map((s) => s.trim())
      .sort();
  const documented = Object.fromEntries(rows.map(([, e, by, to]) => [e, [list(by ?? ""), list(to ?? "")]]));
  const expected = Object.fromEntries(
    EVENT_TYPES.map((e) => [
      e,
      [
        components
          .filter(([, c]) => c.publishes.includes(e))
          .map(([n]) => n)
          .sort(),
        components
          .filter(([, c]) => c.subscribes.includes(e))
          .map(([n]) => n)
          .sort(),
      ],
    ]),
  );
  expect(documented).toEqual(expected);
});
