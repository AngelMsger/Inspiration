import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contractErrors, type NormalizedDocument, type Source } from "@inspiration/contracts";
import { LocalBlobStore, registry } from "@inspiration/kernel";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  type FeishuApproval,
  FeishuApprovalConnector,
  type FeishuDocument,
  FeishuDocxConnector,
  FixtureFeishuApi,
  FolderConnector,
  globToRegExp,
  parseEntry,
  translationOf,
} from "../src/index.ts";

const T0 = "2026-01-01T00:00:00.000Z";

function source(type: string, options: Record<string, unknown>): Source {
  return {
    id: "src_01JC0000000000000000SOURCE",
    tenant_id: "ten_01JC0000000000000000TENANT",
    space_id: "spc_01JC00000000000000000SPACE",
    type,
    name: "test",
    scope: { kind: type, options },
    status: "active",
    created_at: T0,
  };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "inspiration-connectors-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function put(path: string, text: string): Promise<void> {
  await mkdir(join(dir, ...path.split("/").slice(0, -1)), { recursive: true });
  await writeFile(join(dir, ...path.split("/")), text);
}

function asDocument(result: unknown): NormalizedDocument {
  expect(contractErrors("NormalizedDocument", result)).toEqual([]);
  return result as NormalizedDocument;
}

describe("folder connector", () => {
  async function folder(options: Record<string, unknown> = {}) {
    const root = join(dir, "corpus");
    const blobs = new LocalBlobStore(join(dir, "blobs"));
    const connector = new FolderConnector(source("folder", { root, ...options }), {
      blobs,
      secret: async () => "",
    });
    return { connector, blobs };
  }

  test("lists files with version hashes, skipping hidden and unknown files", async () => {
    await put("corpus/hr/travel.md", "# Travel policy\n\nArticle 3 Hotel standards.");
    await put("corpus/hr/.acl.yaml", "readers: [group:hr]\n");
    await put("corpus/notes.txt", "plain");
    await put("corpus/tool.exe", "binary");
    await put("corpus/.git/config", "x");
    const { connector } = await folder();
    const page = await connector.list({ kind: "folder" });
    expect(page.items.map((i) => i.ref.external_id)).toEqual(["hr/travel.md", "notes.txt"]);
    const [first] = page.items;
    expect(first?.version?.content_hash).toMatch(/^sha256:/);
    expect(first?.ref.parent_external_id).toBe("hr");
    expect(page.next_cursor).toBeUndefined();

    const scoped = await connector.list({ kind: "folder", include: ["hr/**"], exclude: ["**/*.txt"] });
    expect(scoped.items.map((i) => i.ref.external_id)).toEqual(["hr/travel.md"]);
  });

  test("fetch returns the file, metadata and ACL, and Unchanged for a known version", async () => {
    await put("corpus/.meta.yaml", "governance_level: governed\nsensitivity: internal\n");
    await put("corpus/finance/.meta.yaml", "sensitivity: confidential\n");
    await put("corpus/finance/.acl.yaml", "readers: [group:finance, tenant]\neditors: [user:li.na]\ninherit: true\n");
    await put("corpus/.acl.yaml", "owners: [user:admin]\n");
    await put(
      "corpus/finance/expenses.md",
      "---\ntitle: Expense policy\napproval_state: approved\nowner: li.na\ntags: [finance]\nknowledge_class: policy\n---\n# Expenses\n\nThe text",
    );
    const { connector, blobs } = await folder();
    const [item] = (await connector.list({ kind: "folder" })).items;
    const doc = asDocument(await connector.fetch(item?.ref ?? { source_id: "", external_id: "" }));
    expect(doc.title).toBe("Expense policy");
    expect(doc.mime_type).toBe("text/markdown");
    expect(doc.approval_state).toBe("approved");
    expect(doc.sensitivity).toBe("confidential");
    expect(doc.governance_level).toBe("governed");
    expect(doc.metadata).toMatchObject({
      path: ["finance"],
      author_external_id: "li.na",
      tags: ["finance"],
      extra: { knowledge_class: "policy" },
    });
    expect(
      new TextDecoder().decode(await blobs.get(doc.file ?? { uri: "", sha256: "", size_bytes: 0, mime_type: "" })),
    ).toContain("The text");
    expect(doc.acl?.entries).toEqual([
      { principal_kind: "anyone_in_tenant", role: "viewer" },
      { principal_kind: "group", external_id: "finance", role: "viewer" },
      { principal_kind: "user", external_id: "admin", role: "owner" },
      { principal_kind: "user", external_id: "li.na", role: "editor" },
    ]);
    expect(doc.acl?.acl_hash).toBe(item?.version?.acl_hash);
    expect(await connector.fetch(doc.ref, doc.version)).toEqual({ unchanged: true });

    // An ACL change alone changes only the ACL hash.
    await put("corpus/finance/.acl.yaml", "readers: [group:finance]\n");
    const { connector: again } = await folder();
    const changed = asDocument(await again.fetch(doc.ref, doc.version));
    expect(changed.version.content_hash).toBe(doc.version.content_hash);
    expect(changed.version.acl_hash).not.toBe(doc.version.acl_hash);
  });

  test("titles fall back to the first heading, then the file name", async () => {
    await put("corpus/a.md", "intro\n\n## Chapter 2 General provisions\n");
    await put("corpus/b.txt", "no title");
    await put("corpus/c.html", "<html><head><title> Notice </title></head></html>");
    const { connector } = await folder();
    const titles = [];
    for (const item of (await connector.list({ kind: "folder" })).items) {
      titles.push(asDocument(await connector.fetch(item.ref)).title);
    }
    expect(titles).toEqual(["Chapter 2 General provisions", "b", "Notice"]);
  });

  test("a file named for its language is in it and translates the file without it; front matter says otherwise", async () => {
    await put("corpus/.meta.yaml", "language: en\n");
    await put("corpus/hr/leave.md", "# Leave policy\n\nTwenty days.");
    await put("corpus/hr/leave.zh.md", "# Leave policy\n\nIn Chinese.");
    await put("corpus/hr/leave.zh-Hant-TW.md", "# Leave policy\n\nIn traditional Chinese.");
    await put(
      "corpus/hr/travel.ja.md",
      "---\nlanguage: ja-JP\ntranslation_of: hr/travel-policy.md\n---\n# Travel\n\nIn Japanese.",
    );
    // Named for its language, but nothing it could translate.
    await put("corpus/hr/faq.ja.md", "# FAQ\n\nIn Japanese.");
    await put("corpus/hr/notes.new.md", "# Notes\n\nNot a language.");
    const { connector } = await folder();
    const docs: Record<string, [string | undefined, string | undefined]> = {};
    for (const item of (await connector.list({ kind: "folder" })).items) {
      const doc = asDocument(await connector.fetch(item.ref));
      docs[item.ref.external_id] = [doc.language, doc.metadata?.translation_of?.external_id];
    }
    expect(docs).toEqual({
      "hr/faq.ja.md": ["ja", undefined],
      "hr/leave.md": ["en", undefined],
      "hr/leave.zh.md": ["zh", "hr/leave.md"],
      "hr/leave.zh-Hant-TW.md": ["zh-Hant-TW", "hr/leave.md"],
      "hr/notes.new.md": ["en", undefined],
      "hr/travel.ja.md": ["ja-JP", "hr/travel-policy.md"],
    });
  });

  test("a translation changes when the original it is named for appears or goes", async () => {
    await put("corpus/hr/leave.zh.md", "# Leave policy\n\nIn Chinese.");
    const { connector } = await folder();
    const ref = { source_id: "src_x", external_id: "hr/leave.zh.md" };
    const alone = asDocument(await connector.fetch(ref));
    expect(alone.metadata?.translation_of).toBeUndefined();
    await put("corpus/hr/leave.md", "# Leave policy\n\nTwenty days.");
    const linked = asDocument(await connector.fetch(ref, alone.version));
    expect(linked.metadata?.translation_of?.external_id).toBe("hr/leave.md");
    expect(linked.version.content_hash).toBe(alone.version.content_hash);
    const listed = (await connector.list({ kind: "folder" })).items.find((i) => i.ref.external_id === ref.external_id);
    expect(listed?.version?.metadata_hash).toBe(linked.version.metadata_hash);
    await rm(join(dir, "corpus/hr/leave.md"));
    expect(asDocument(await connector.fetch(ref, linked.version)).metadata?.translation_of).toBeUndefined();
  });

  test("refuses paths outside the root", async () => {
    await put("corpus/a.md", "x");
    const { connector } = await folder();
    await expect(connector.fetch({ source_id: "src_x", external_id: "../secret.md" })).rejects.toThrow(RangeError);
  });

  test("is registered as a plugin", async () => {
    expect(registry("connectors").names()).toEqual(
      expect.arrayContaining(["folder", "feishu.docx", "feishu.approval"]),
    );
  });
});

test("a language suffix is a two-letter code known to Intl, with an optional script and region", () => {
  expect(translationOf("a/b.zh-cn.md")).toEqual({ original: "a/b.md", language: "zh-CN" });
  expect(translationOf("x.ja.html")).toEqual({ original: "x.html", language: "ja" });
  // Not languages: unknown codes, three letters, a dot file, no extension.
  for (const rel of ["a.qq.md", "a.fin.md", "a/.en.md", "a.en", "a.md"])
    expect(translationOf(rel), rel).toBeUndefined();
});

test("globs", () => {
  expect(globToRegExp("**/*.md").test("a/b/c.md")).toBe(true);
  expect(globToRegExp("**/*.md").test("c.md")).toBe(true);
  expect(globToRegExp("hr/*.md").test("hr/x/c.md")).toBe(false);
  expect(globToRegExp("hr/?.md").test("hr/a.md")).toBe(true);
  expect(() => parseEntry("robot:x", "viewer")).toThrow(RangeError);
});

const DOC: FeishuDocument = {
  meta: {
    document_id: "doxcnPolicy",
    revision_id: 7,
    title: "Travel policy",
    modified_at: T0,
    path: ["Administration", "Policies"],
  },
  blocks: [
    { block_id: "doxcnPolicy", block_type: 1, children: ["h1", "p1", "l1", "t1"] },
    {
      block_id: "h1",
      block_type: 3,
      parent_id: "doxcnPolicy",
      heading1: { elements: [{ text_run: { content: "Article 3 Hotels" } }] },
    },
    {
      block_id: "p1",
      block_type: 2,
      parent_id: "doxcnPolicy",
      text: {
        elements: [
          { text_run: { content: "Tier-1 cities: at most " } },
          { text_run: { content: "600 yuan a night." } },
        ],
      },
    },
    {
      block_id: "l1",
      block_type: 13,
      parent_id: "doxcnPolicy",
      ordered: { elements: [{ text_run: { content: "Submit the request" } }] },
      children: ["l2"],
    },
    {
      block_id: "l2",
      block_type: 12,
      parent_id: "l1",
      bullet: { elements: [{ text_run: { content: "Attach the invoices" } }] },
    },
    {
      block_id: "t1",
      block_type: 31,
      parent_id: "doxcnPolicy",
      table: { cells: ["c1", "c2", "c3", "c4"], property: { row_size: 2, column_size: 2 } },
    },
    { block_id: "c1", block_type: 32, children: ["c1t"] },
    { block_id: "c1t", block_type: 2, text: { elements: [{ text_run: { content: "City" } }] } },
    { block_id: "c2", block_type: 32, children: ["c2t"] },
    { block_id: "c2t", block_type: 2, text: { elements: [{ text_run: { content: "Cap" } }] } },
    { block_id: "c3", block_type: 32, children: ["c3t"] },
    { block_id: "c3t", block_type: 2, text: { elements: [{ text_run: { content: "Beijing" } }] } },
    { block_id: "c4", block_type: 32, children: ["c4t"] },
    { block_id: "c4t", block_type: 2, text: { elements: [{ text_run: { content: "600" } }] } },
  ],
  members: [
    { member_type: "openchat", member_id: "oc_finance", perm: "view" },
    { member_type: "openid", member_id: "ou_lina", perm: "edit" },
  ],
  link_share_entity: "tenant_readable",
  properties: {
    approval_state: "approved",
    sensitivity: "internal",
    governance_level: "governed",
    owner_team: "Administration",
  },
};

const APPROVAL: FeishuApproval = {
  definition: {
    approval_code: "CONTRACT-01",
    approval_name: "Contract approval",
    form: [{ id: "amount", name: "Contract amount", type: "number", required: true }],
    node_list: [
      { node_id: "start", name: "Start", node_type: "START" },
      { node_id: "legal", name: "Legal review", node_type: "APPROVAL", approver: "Legal" },
      { node_id: "end", name: "End", node_type: "END" },
    ],
  },
  instances: [
    {
      instance_code: "i1",
      status: "APPROVED",
      start_time: "2025-12-01T01:00:00.000Z",
      end_time: "2025-12-02T01:00:00.000Z",
      form: { amount: 120000 },
      timeline: [
        { type: "START", user_id: "ou_zhang", create_time: "2025-12-01T01:00:00.000Z" },
        { type: "PASS", node_id: "legal", user_id: "ou_wang", create_time: "2025-12-02T01:00:00.000Z" },
      ],
    },
  ],
  modified_at: T0,
  viewers: [{ member_type: "opendepartmentid", member_id: "od_legal", perm: "view" }],
};

describe("feishu connectors on fixtures", () => {
  beforeEach(async () => {
    await put("feishu/docs/doxcnPolicy.json", JSON.stringify(DOC));
    await put("feishu/approvals/CONTRACT-01.json", JSON.stringify(APPROVAL));
  });

  test("docx blocks keep native IDs, tables and nesting", async () => {
    const api = new FixtureFeishuApi(join(dir, "feishu"));
    const connector = new FeishuDocxConnector(source("feishu.docx", {}), api);
    const [item] = (await connector.list({ kind: "feishu.wiki_space" })).items;
    expect(item?.version?.external_version).toBe("7");
    const doc = asDocument(await connector.fetch(item?.ref ?? { source_id: "", external_id: "" }));
    expect(doc.blocks?.map((b) => [b.anchor, b.kind, b.text])).toEqual([
      ["h1", "heading", "Article 3 Hotels"],
      ["p1", "paragraph", "Tier-1 cities: at most 600 yuan a night."],
      ["l1", "list_item", "Submit the request"],
      ["t1", "table", undefined],
    ]);
    expect(doc.blocks?.[2]?.children?.map((b) => b.text)).toEqual(["Attach the invoices"]);
    const table = doc.blocks?.[3];
    expect(table?.children?.[1]?.children?.map((c) => [c.anchor, c.text])).toEqual([
      ["c3", "Beijing"],
      ["c4", "600"],
    ]);
    expect(doc.metadata?.path).toEqual(["Administration", "Policies"]);
    expect(doc.governance_level).toBe("governed");
    expect(doc.metadata?.extra).toEqual({ owner_team: "Administration" });
    expect(doc.acl?.entries.map((e) => [e.principal_kind, e.external_id ?? "", e.role])).toEqual([
      ["anyone_in_tenant", "", "viewer"],
      ["group", "oc_finance", "viewer"],
      ["user", "ou_lina", "editor"],
    ]);
    expect(await connector.fetch(doc.ref, doc.version)).toEqual({ unchanged: true });
  });

  test("approvals become a process snapshot with pseudonymous approvers", async () => {
    const api = new FixtureFeishuApi(join(dir, "feishu"));
    const connector = new FeishuApprovalConnector(source("feishu.approval", {}), api);
    const [item] = (await connector.list({ kind: "feishu.approvals" })).items;
    const doc = asDocument(await connector.fetch(item?.ref ?? { source_id: "", external_id: "" }));
    expect(doc.process?.definition?.nodes.map((n) => [n.key, n.node_type])).toEqual([
      ["start", "start"],
      ["legal", "approval"],
      ["end", "end"],
    ]);
    const [instance] = doc.process?.instances ?? [];
    expect(instance?.status).toBe("approved");
    expect(instance?.timeline.map((t) => t.action)).toEqual(["start", "approve"]);
    expect(instance?.timeline[1]?.actor_external_id).toMatch(/^actor-[0-9a-f]{12}$/);
    expect(doc.process?.window?.start).toBe("2025-12-01T01:00:00.000Z");
    expect(doc.acl?.fidelity).toBe("approximate");
  });
});
