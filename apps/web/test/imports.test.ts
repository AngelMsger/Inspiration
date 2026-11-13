// Import explains access without mounting upload controls for a reader, a sample or a recording.
import type { SpaceEntry } from "@inspiration/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Library } from "../src/api.ts";
import { ImportScreen } from "../src/imports.tsx";
import { Sources } from "../src/sources.tsx";

vi.mock("../src/words.ts", () => ({
  useWords: () => ({
    tag: "en",
    say: (key: string, params?: Record<string, string>) => `${key}${params?.space ? `: ${params.space}` : ""}`,
  }),
}));
vi.mock("../src/upload.tsx", () => ({
  Uploader: (props: { space: SpaceEntry }) => createElement("input", { type: "file", "data-space": props.space.id }),
}));

const space = (id: string, name: string, role: SpaceEntry["role"]): SpaceEntry => ({
  id,
  name,
  role,
  tenant_id: "ten_COMPANY",
  kind: "team",
  owner_id: "mem_OWNER",
  default_sensitivity: "internal",
  created_at: "2026-11-13T00:00:00Z",
  owner_ids: ["mem_OWNER"],
});

function render(role: SpaceEntry["role"], options: { sampled?: boolean; space?: string } = {}) {
  const spaces = [space("spc_FINANCE", "Finance", role), space("spc_PEOPLE", "People", "viewer")];
  const library = { spaces, trees: new Map(), topics: new Map() } as Library;
  return renderToStaticMarkup(
    createElement(ImportScreen, {
      space: options.space ?? "spc_FINANCE",
      library,
      sampled: options.sampled ?? false,
      onSourcesChanged: () => {},
    }),
  );
}

beforeEach(() => vi.stubGlobal("document", { documentElement: { dataset: {} } }));
afterEach(() => vi.unstubAllGlobals());

test.each(["viewer", "commenter"] as const)("%s can discover import but cannot upload", (role) => {
  const html = render(role);
  expect(html).toContain("import.upload_required");
  expect(html).toContain("source.confluence");
  expect(html).toContain("source.feishu.docx");
  expect(html).not.toContain('type="file"');
});

test.each(["editor", "steward", "owner"] as const)("%s uploads into the named space", (role) => {
  const html = render(role);
  expect(html).toContain("import.destination: Finance");
  expect(html).toContain('data-space="spc_FINANCE"');
  expect(html).not.toContain('data-space="spc_PEOPLE"');
});

test("sample and recorded pages explain why import is unavailable even for an owner", () => {
  expect(render("owner", { sampled: true })).toContain("sample.banner");
  expect(render("owner", { sampled: true })).not.toContain('type="file"');
  vi.stubGlobal("document", { documentElement: { dataset: { routes: "hash" } } });
  expect(render("owner")).toContain("import.recorded");
  expect(render("owner")).not.toContain('type="file"');
});

test("an inaccessible destination never falls back to another space", () => {
  const html = render("owner", { space: "spc_HIDDEN" });
  expect(html).toContain("folder.not_found");
  expect(html).not.toContain('type="file"');
});

test("Confluence starts with an explicit page selection and names the whole-space alternative", () => {
  const html = renderToStaticMarkup(
    createElement(Sources, { space: "spc_FINANCE", kind: "confluence", onChanged: () => {} }),
  );
  expect(html).toContain('<option value="pages" selected="">');
  expect(html).toContain('<option value="space">');
  expect(html).toContain("connections.page_ids");
  expect(html).toContain('<textarea required="" rows="3">');
});

test("Feishu asks for page URLs without Confluence page IDs or a whole-space choice", () => {
  const html = renderToStaticMarkup(
    createElement(Sources, { space: "spc_FINANCE", kind: "feishu.docx", onChanged: () => {} }),
  );
  expect(html).toContain("connections.links");
  expect(html).not.toContain("connections.page_ids");
  expect(html).not.toContain('<option value="space">');
});
