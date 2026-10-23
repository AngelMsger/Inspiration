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
    await put("corpus/hr/差旅制度.md", "# 差旅管理制度\n\n第三条 住宿标准。");
    await put("corpus/hr/.acl.yaml", "readers: [group:hr]\n");
    await put("corpus/notes.txt", "plain");
    await put("corpus/tool.exe", "binary");
    await put("corpus/.git/config", "x");
    const { connector } = await folder();
    const page = await connector.list({ kind: "folder" });
    expect(page.items.map((i) => i.ref.external_id)).toEqual(["hr/差旅制度.md", "notes.txt"]);
    const [first] = page.items;
    expect(first?.version?.content_hash).toMatch(/^sha256:/);
    expect(first?.ref.parent_external_id).toBe("hr");
    expect(page.next_cursor).toBeUndefined();

    const scoped = await connector.list({ kind: "folder", include: ["hr/**"], exclude: ["**/*.txt"] });
    expect(scoped.items.map((i) => i.ref.external_id)).toEqual(["hr/差旅制度.md"]);
  });

  test("fetch returns the file, metadata and ACL, and Unchanged for a known version", async () => {
    await put("corpus/.meta.yaml", "governance: governed\nsensitivity: internal\n");
    await put("corpus/finance/.meta.yaml", "sensitivity: confidential\n");
    await put("corpus/finance/.acl.yaml", "readers: [group:finance, tenant]\neditors: [user:li.na]\ninherit: true\n");
    await put("corpus/.acl.yaml", "owners: [user:admin]\n");
    await put(
      "corpus/finance/报销.md",
      "---\ntitle: 费用报销办法\napproval_state: approved\nowner: li.na\ntags: [财务]\nknowledge_class: policy\n---\n# 报销\n\n正文",
    );
    const { connector, blobs } = await folder();
    const [item] = (await connector.list({ kind: "folder" })).items;
    const doc = asDocument(await connector.fetch(item?.ref ?? { source_id: "", external_id: "" }));
    expect(doc.title).toBe("费用报销办法");
    expect(doc.mime_type).toBe("text/markdown");
    expect(doc.approval_state).toBe("approved");
    expect(doc.sensitivity).toBe("confidential");
    expect(doc.metadata).toMatchObject({
      path: ["finance"],
      author_external_id: "li.na",
      tags: ["财务"],
      extra: { governance: "governed", knowledge_class: "policy" },
    });
    expect(
      new TextDecoder().decode(await blobs.get(doc.file ?? { uri: "", sha256: "", size_bytes: 0, mime_type: "" })),
    ).toContain("正文");
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
    await put("corpus/a.md", "intro\n\n## 第二章 总则\n");
    await put("corpus/b.txt", "no title");
    await put("corpus/c.html", "<html><head><title> 公告 </title></head></html>");
    const { connector } = await folder();
    const titles = [];
    for (const item of (await connector.list({ kind: "folder" })).items) {
      titles.push(asDocument(await connector.fetch(item.ref)).title);
    }
    expect(titles).toEqual(["第二章 总则", "b", "公告"]);
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

test("globs", () => {
  expect(globToRegExp("**/*.md").test("a/b/c.md")).toBe(true);
  expect(globToRegExp("**/*.md").test("c.md")).toBe(true);
  expect(globToRegExp("hr/*.md").test("hr/x/c.md")).toBe(false);
  expect(globToRegExp("hr/?.md").test("hr/a.md")).toBe(true);
  expect(() => parseEntry("robot:x", "viewer")).toThrow(RangeError);
});

const DOC: FeishuDocument = {
  meta: { document_id: "doxcnPolicy", revision_id: 7, title: "差旅管理制度", modified_at: T0, path: ["行政", "制度"] },
  blocks: [
    { block_id: "doxcnPolicy", block_type: 1, children: ["h1", "p1", "l1", "t1"] },
    {
      block_id: "h1",
      block_type: 3,
      parent_id: "doxcnPolicy",
      heading1: { elements: [{ text_run: { content: "第三条 住宿" } }] },
    },
    {
      block_id: "p1",
      block_type: 2,
      parent_id: "doxcnPolicy",
      text: { elements: [{ text_run: { content: "一线城市每晚不超过" } }, { text_run: { content: "600元。" } }] },
    },
    {
      block_id: "l1",
      block_type: 13,
      parent_id: "doxcnPolicy",
      ordered: { elements: [{ text_run: { content: "提交申请" } }] },
      children: ["l2"],
    },
    { block_id: "l2", block_type: 12, parent_id: "l1", bullet: { elements: [{ text_run: { content: "附发票" } }] } },
    {
      block_id: "t1",
      block_type: 31,
      parent_id: "doxcnPolicy",
      table: { cells: ["c1", "c2", "c3", "c4"], property: { row_size: 2, column_size: 2 } },
    },
    { block_id: "c1", block_type: 32, children: ["c1t"] },
    { block_id: "c1t", block_type: 2, text: { elements: [{ text_run: { content: "城市" } }] } },
    { block_id: "c2", block_type: 32, children: ["c2t"] },
    { block_id: "c2t", block_type: 2, text: { elements: [{ text_run: { content: "上限" } }] } },
    { block_id: "c3", block_type: 32, children: ["c3t"] },
    { block_id: "c3t", block_type: 2, text: { elements: [{ text_run: { content: "北京" } }] } },
    { block_id: "c4", block_type: 32, children: ["c4t"] },
    { block_id: "c4t", block_type: 2, text: { elements: [{ text_run: { content: "600" } }] } },
  ],
  members: [
    { member_type: "openchat", member_id: "oc_finance", perm: "view" },
    { member_type: "openid", member_id: "ou_lina", perm: "edit" },
  ],
  link_share_entity: "tenant_readable",
  properties: { approval_state: "approved", sensitivity: "internal", governance: "governed" },
};

const APPROVAL: FeishuApproval = {
  definition: {
    approval_code: "CONTRACT-01",
    approval_name: "合同审批",
    form: [{ id: "amount", name: "合同金额", type: "number", required: true }],
    node_list: [
      { node_id: "start", name: "发起", node_type: "START" },
      { node_id: "legal", name: "法务审核", node_type: "APPROVAL", approver: "法务部" },
      { node_id: "end", name: "结束", node_type: "END" },
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
      ["h1", "heading", "第三条 住宿"],
      ["p1", "paragraph", "一线城市每晚不超过600元。"],
      ["l1", "list_item", "提交申请"],
      ["t1", "table", undefined],
    ]);
    expect(doc.blocks?.[2]?.children?.map((b) => b.text)).toEqual(["附发票"]);
    const table = doc.blocks?.[3];
    expect(table?.children?.[1]?.children?.map((c) => [c.anchor, c.text])).toEqual([
      ["c3", "北京"],
      ["c4", "600"],
    ]);
    expect(doc.metadata?.path).toEqual(["行政", "制度"]);
    expect(doc.metadata?.extra).toEqual({ governance: "governed" });
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
