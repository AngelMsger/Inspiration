/**
 * Plugin registries.
 *
 * Connectors, parsers, extractors, diagram compilers, index backends and model providers
 * register by name. A new source or model is a new plugin, not a core change. Packages
 * declare plugins in package.json, as "<module path>#<export>":
 *
 *     "inspiration": {
 *       "plugins": {
 *         "connectors": { "feishu.docx": "./src/docx.ts#FeishuDocxConnector" }
 *       }
 *     }
 *
 * Every package installed in the workspace's node_modules is scanned once, on first use.
 * Tests and in-process wiring can also call Registry.register directly; an explicit
 * registration wins over a declared plugin of the same name.
 */

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const GROUPS = [
  "connectors",
  "parsers",
  "extractors",
  "diagram_compilers",
  "vector_indexes",
  "keyword_indexes",
  "model_providers",
  "data_providers",
  "view_templates",
  "agent_tools",
  "event_transports",
  "migrations",
] as const;

export type PluginGroup = (typeof GROUPS)[number];

export class PluginError extends Error {
  override name = "PluginError";
}

/** A plugin as declared by a package, before its module is loaded. */
export interface PluginDeclaration {
  readonly group: PluginGroup;
  readonly name: string;
  /** "package:<name>" or "register". */
  readonly origin: string;
  load(): Promise<unknown>;
}

interface PackageJson {
  name?: string;
  inspiration?: { plugins?: Record<string, Record<string, string>> };
}

/**
 * Where installed packages are scanned: INSPIRATION_ROOT when set, else the pnpm workspace
 * root at or above start (every workspace package is linked there), else the nearest
 * directory with a node_modules directory (a deployed application).
 */
export function workspaceRoot(start: string = process.cwd()): string {
  if (process.env.INSPIRATION_ROOT) return resolve(process.env.INSPIRATION_ROOT);
  let nearest: string | undefined;
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    if (nearest === undefined && existsSync(join(dir, "node_modules"))) nearest = dir;
    if (dirname(dir) === dir) return nearest ?? resolve(start);
  }
}

function packageDirs(root: string): string[] {
  const modules = join(root, "node_modules");
  if (!existsSync(modules)) return [];
  const dirs: string[] = [];
  for (const entry of readdirSync(modules)) {
    if (entry.startsWith(".")) continue;
    if (entry.startsWith("@")) {
      for (const sub of readdirSync(join(modules, entry))) dirs.push(join(modules, entry, sub));
    } else {
      dirs.push(join(modules, entry));
    }
  }
  return dirs;
}

function declaration(group: PluginGroup, name: string, pkgName: string, pkgDir: string, spec: string) {
  const [path, exportName = "default"] = spec.split("#");
  if (!path) throw new PluginError(`${pkgName}: plugin ${group}/${name} has no module path`);
  // The real path, not the node_modules symlink: every importer must see one module instance,
  // and Node only strips TypeScript types outside node_modules.
  const url = pathToFileURL(resolve(realpathSync(pkgDir), path)).href;
  return {
    group,
    name,
    origin: `package:${pkgName}`,
    async load() {
      const mod = (await import(url)) as Record<string, unknown>;
      if (!(exportName in mod)) throw new PluginError(`${pkgName}: ${path} has no export ${exportName}`);
      return mod[exportName];
    },
  } satisfies PluginDeclaration;
}

const scans = new Map<string, PluginDeclaration[]>();

/** Every plugin declared by the packages installed under root, in package order. */
export function declaredPlugins(root: string = workspaceRoot()): PluginDeclaration[] {
  const known = scans.get(root);
  if (known) return known;
  const found: PluginDeclaration[] = [];
  for (const dir of packageDirs(root)) {
    const manifest = join(dir, "package.json");
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, "utf8")) as PackageJson;
    for (const [group, entries] of Object.entries(pkg.inspiration?.plugins ?? {})) {
      if (!(GROUPS as readonly string[]).includes(group)) {
        throw new PluginError(`${pkg.name}: unknown plugin group ${group}; known: ${GROUPS.join(", ")}`);
      }
      for (const [name, spec] of Object.entries(entries)) {
        found.push(declaration(group as PluginGroup, name, pkg.name ?? dir, dir, spec));
      }
    }
  }
  scans.set(root, found);
  return found;
}

/** Name to plugin object (usually a class or factory) for one group. */
export class Registry {
  readonly group: PluginGroup;
  readonly #registered = new Map<string, unknown>();
  readonly #declared: () => PluginDeclaration[];

  constructor(group: string, options: { root?: string } = {}) {
    if (!(GROUPS as readonly string[]).includes(group)) {
      throw new PluginError(`unknown plugin group ${group}; known: ${GROUPS.join(", ")}`);
    }
    this.group = group as PluginGroup;
    this.#declared = () => declaredPlugins(options.root).filter((p) => p.group === this.group);
  }

  register(name: string, target: unknown, options: { replace?: boolean } = {}): void {
    if (this.#registered.has(name) && !options.replace) {
      throw new PluginError(`${this.group}: ${name} is already registered`);
    }
    this.#registered.set(name, target);
  }

  /** The plugins of this group by name. A registration hides a declared plugin of the same name. */
  plugins(): PluginDeclaration[] {
    const out = new Map<string, PluginDeclaration>();
    for (const [name, target] of this.#registered) {
      out.set(name, { group: this.group, name, origin: "register", load: async () => target });
    }
    for (const p of this.#declared()) {
      const other = out.get(p.name);
      if (other?.origin === "register") continue;
      if (other) throw new PluginError(`${this.group}: ${p.name} is declared by both ${other.origin} and ${p.origin}`);
      out.set(p.name, p);
    }
    return [...out.keys()].sort().map((n) => out.get(n) as PluginDeclaration);
  }

  names(): string[] {
    return this.plugins().map((p) => p.name);
  }

  async get<T = unknown>(name: string): Promise<T> {
    const plugin = this.plugins().find((p) => p.name === name);
    if (!plugin) {
      throw new PluginError(
        `${this.group}: no plugin named ${name} (registered: ${this.names().join(", ") || "none"})`,
      );
    }
    return (await plugin.load()) as T;
  }
}

const registries = new Map<string, Registry>();

/** The process-wide registry for a group. */
export function registry(group: PluginGroup): Registry {
  let r = registries.get(group);
  if (!r) {
    r = new Registry(group);
    registries.set(group, r);
  }
  return r;
}
