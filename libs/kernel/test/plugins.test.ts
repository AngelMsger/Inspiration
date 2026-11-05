import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { declaredPlugins, PluginError, Registry, registry } from "../src/index.ts";

/** A throwaway install: node_modules/@acme/widgets declares two connectors. */
function fakeInstall(): string {
  const root = mkdtempSync(join(tmpdir(), "inspiration-plugins-"));
  const pkg = join(root, "node_modules", "@acme", "widgets");
  mkdirSync(join(pkg, "src"), { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({
      name: "@acme/widgets",
      inspiration: {
        plugins: { connectors: { "acme.sheet": "./src/sheet.js#SheetConnector", "acme.wiki": "./src/wiki.js" } },
      },
    }),
  );
  writeFileSync(join(pkg, "src", "sheet.js"), 'export class SheetConnector { type = "acme.sheet"; }\n');
  writeFileSync(join(pkg, "src", "wiki.js"), 'export default { type: "acme.wiki" };\n');
  mkdirSync(join(root, "node_modules", "left-pad"));
  writeFileSync(join(root, "node_modules", "left-pad", "package.json"), '{"name":"left-pad"}');
  return root;
}

describe("plugin registry", () => {
  test("finds plugins declared in installed packages", async () => {
    const root = fakeInstall();
    const connectors = new Registry("connectors", { root });
    expect(connectors.names()).toEqual(["acme.sheet", "acme.wiki"]);
    expect(connectors.plugins()[0]?.origin).toBe("package:@acme/widgets");
    const Sheet = await connectors.get<new () => { type: string }>("acme.sheet");
    expect(new Sheet().type).toBe("acme.sheet");
    expect(await connectors.get("acme.wiki")).toEqual({ type: "acme.wiki" });
    expect(new Registry("parsers", { root }).names()).toEqual([]);
    expect(declaredPlugins(root)).toHaveLength(2);
  });

  test("an explicit registration wins over a declared plugin", async () => {
    const connectors = new Registry("connectors", { root: fakeInstall() });
    connectors.register("acme.sheet", "replacement");
    expect(await connectors.get("acme.sheet")).toBe("replacement");
    expect(() => connectors.register("acme.sheet", "again")).toThrow(PluginError);
    connectors.register("acme.sheet", "again", { replace: true });
    expect(await connectors.get("acme.sheet")).toBe("again");
  });

  test("unknown groups and names are errors", async () => {
    expect(() => new Registry("widgets")).toThrow(/unknown plugin group widgets/);
    await expect(new Registry("connectors", { root: fakeInstall() }).get("acme.none")).rejects.toThrow(
      "connectors: no plugin named acme.none (registered: acme.sheet, acme.wiki)",
    );
  });

  test("the workspace declares its own plugins", () => {
    expect(registry("migrations").names()).toEqual([
      "agents",
      "authz",
      "bus",
      "collaboration",
      "extraction",
      "freshness",
      "gateway",
      "governance",
      "kb",
      "normalization",
      "page-compiler",
      "retrieval",
      "sync",
      "tenancy",
    ]);
    expect(registry("event_transports").names()).toEqual(["memory", "valkey"]);
    expect(registry("model_providers").names()).toEqual(["anthropic", "fake", "openai_compatible"]);
  });
});
