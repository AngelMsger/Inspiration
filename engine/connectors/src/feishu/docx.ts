/**
 * Feishu documents (docx) with their native block IDs as anchors, so a block keeps its
 * identity across edits however the document moves around it. Permissions come from the
 * document's members and its link-sharing setting.
 *
 * Scope: `{ kind: "feishu.wiki_space", ids?: [document ids], options: { fixtures: "<dir>" } }`.
 */

import {
  type AclEntry,
  type AclRole,
  type AclSnapshot,
  type ApprovalState,
  type Connector,
  type ConnectorCapabilities,
  type ConnectorContext,
  type Cursor,
  canonicalJson,
  contentHash,
  type DocBlock,
  type DocBlockKind,
  isGovernanceLevel,
  type ListPage,
  type NormalizedDocument,
  type ScopeSpec,
  type SensitivityLabel,
  type Source,
  type SourceRef,
  sameVersion,
  type Unchanged,
  type Version,
} from "@inspiration/contracts";
import { aclHash, aclSnapshot } from "../acl.ts";
import {
  type FeishuApi,
  type FeishuBlock,
  type FeishuDocument,
  feishuApi,
  type PermissionMember,
  type TextBody,
} from "./api.ts";

const ROLE: Record<PermissionMember["perm"], AclRole> = { view: "viewer", edit: "editor", full_access: "owner" };
const KIND: Record<PermissionMember["member_type"], AclEntry["principal_kind"]> = {
  openid: "user",
  openchat: "group",
  opendepartmentid: "department",
};

export function memberEntries(members: readonly PermissionMember[], linkShare?: string): AclEntry[] {
  const entries: AclEntry[] = members.map((m) => ({
    principal_kind: KIND[m.member_type],
    external_id: m.member_id,
    role: ROLE[m.perm],
  }));
  if (linkShare === "tenant_readable") entries.push({ principal_kind: "anyone_in_tenant", role: "viewer" });
  if (linkShare === "anyone_readable") entries.push({ principal_kind: "anyone_with_link", role: "viewer" });
  return entries;
}

export function plainText(body: TextBody | undefined): string {
  return (body?.elements ?? [])
    .map((e) => e.text_run?.content ?? e.mention_doc?.title ?? (e.mention_user ? `@${e.mention_user.user_id}` : ""))
    .join("");
}

function bodyOf(b: FeishuBlock): { kind: DocBlockKind; text?: string; level?: number } | undefined {
  if (b.block_type >= 3 && b.block_type <= 11) {
    const level = b.block_type - 2;
    return { kind: "heading", level, text: plainText(b[`heading${level}` as "heading1"]) };
  }
  switch (b.block_type) {
    case 2:
      return { kind: "paragraph", text: plainText(b.text) };
    case 12:
      return { kind: "list_item", text: plainText(b.bullet) };
    case 13:
      return { kind: "list_item", text: plainText(b.ordered) };
    case 14:
      return { kind: "code", text: plainText(b.code) };
    case 15:
      return { kind: "quote", text: plainText(b.quote) };
    case 17:
      return { kind: "list_item", text: plainText(b.todo) };
    case 27:
      return { kind: "image" };
    default:
      return undefined;
  }
}

/** The document's blocks as DocBlocks in reading order, anchored by Feishu block_id. */
export function docBlocks(doc: FeishuDocument): DocBlock[] {
  const byId = new Map(doc.blocks.map((b) => [b.block_id, b]));
  const textOf = (id: string): string => {
    const b = byId.get(id);
    if (!b) return "";
    const own = bodyOf(b)?.text ?? "";
    const children = (b.children ?? []).map(textOf).filter(Boolean);
    return [own, ...children].filter(Boolean).join("\n");
  };
  const convert = (b: FeishuBlock): DocBlock[] => {
    if (b.block_type === 31 && b.table) {
      const { row_size: rows, column_size: cols } = b.table.property;
      const rowBlocks: DocBlock[] = [];
      for (let r = 0; r < rows; r++) {
        const cells: DocBlock[] = [];
        for (let c = 0; c < cols; c++) {
          const cellId = b.table.cells[r * cols + c] as string;
          cells.push({ anchor: cellId, kind: "table_cell", text: textOf(cellId), cell: { row: r, col: c } });
        }
        rowBlocks.push({ anchor: `${b.block_id}:r${r}`, kind: "table_row", cell: { row: r }, children: cells });
      }
      return [{ anchor: b.block_id, kind: "table", children: rowBlocks }];
    }
    const body = bodyOf(b);
    const children = (b.children ?? []).flatMap((id) => {
      const child = byId.get(id);
      return child ? convert(child) : [];
    });
    if (!body) return children; // the page and containers pass their children through
    const out: DocBlock = { anchor: b.block_id, kind: body.kind };
    if (body.text !== undefined) out.text = body.text;
    if (body.level !== undefined) out.level = body.level;
    if (body.kind === "list_item" && b.block_type === 13) out.attrs = { ordered: true };
    // Nested list items stay children, so the list keeps its shape.
    if (children.length) out.children = children;
    return [out];
  };
  const root = doc.blocks.find((b) => b.block_type === 1) ?? doc.blocks.find((b) => !b.parent_id);
  return root ? convert(root) : [];
}

const APPROVAL_STATES = new Set(["draft", "in_review", "approved", "archived", "unknown"]);
const LABELS = new Set(["public", "internal", "confidential", "secret"]);

export class FeishuDocxConnector implements Connector {
  readonly type = "feishu.docx";
  readonly source: Source;
  readonly api: FeishuApi;

  constructor(source: Source, api: FeishuApi = feishuApi(source.scope.options)) {
    this.source = source;
    this.api = api;
  }

  capabilities(): ConnectorCapabilities {
    return { list: true, fetch: true, acl: true, acl_fidelity: "exact", structured_blocks: true };
  }

  #version(doc: FeishuDocument): Version {
    return {
      external_version: String(doc.meta.revision_id),
      modified_at: doc.meta.modified_at,
      content_hash: contentHash(canonicalJson(doc.blocks)),
      metadata_hash: contentHash(canonicalJson([doc.meta.title, doc.meta.path ?? [], doc.properties ?? {}])),
      acl_hash: aclHash(memberEntries(doc.members, doc.link_share_entity)),
    };
  }

  async list(scope: ScopeSpec, _cursor?: Cursor): Promise<ListPage> {
    const wanted = scope.ids?.length ? new Set(scope.ids) : undefined;
    const items = [];
    for (const meta of await this.api.listDocuments()) {
      if (wanted && !wanted.has(meta.document_id)) continue;
      // Listing reads each document for its hashes; the HTTP client will use revision IDs instead.
      const doc = await this.api.document(meta.document_id);
      items.push({ ref: this.#ref(doc), version: this.#version(doc) });
    }
    return { items };
  }

  #ref(doc: FeishuDocument): SourceRef {
    return {
      source_id: this.source.id,
      external_id: doc.meta.document_id,
      kind: "document",
      title: doc.meta.title,
      uri: `https://feishu.cn/docx/${doc.meta.document_id}`,
    };
  }

  async fetch(ref: SourceRef, known?: Version): Promise<NormalizedDocument | Unchanged> {
    const doc = await this.api.document(ref.external_id);
    const version = this.#version(doc);
    if (sameVersion(known, version)) return { unchanged: true };
    const { approval_state, sensitivity, governance_level, ...extra } = doc.properties ?? {};
    const out: NormalizedDocument = {
      ref: this.#ref(doc),
      version,
      title: doc.meta.title,
      mime_type: "application/vnd.feishu.docx+json",
      language: "zh-CN",
      blocks: docBlocks(doc),
      metadata: {
        modified_at: doc.meta.modified_at,
        path: doc.meta.path ?? [],
        url: `https://feishu.cn/docx/${doc.meta.document_id}`,
        ...(doc.meta.owner_id !== undefined && { author_external_id: doc.meta.owner_id }),
        ...(Object.keys(extra).length > 0 && { extra }),
      },
      acl: this.#snapshot(doc),
    };
    if (typeof approval_state === "string" && APPROVAL_STATES.has(approval_state)) {
      out.approval_state = approval_state as ApprovalState;
    }
    if (typeof sensitivity === "string" && LABELS.has(sensitivity)) out.sensitivity = sensitivity as SensitivityLabel;
    if (isGovernanceLevel(governance_level)) out.governance_level = governance_level;
    return out;
  }

  #snapshot(doc: FeishuDocument): AclSnapshot {
    return aclSnapshot(this.source.id, doc.meta.document_id, memberEntries(doc.members, doc.link_share_entity), {
      fidelity: "exact",
      capturedAt: new Date(),
    });
  }

  async acl(ref: SourceRef): Promise<AclSnapshot> {
    return this.#snapshot(await this.api.document(ref.external_id));
  }
}

export function feishuDocxConnector(source: Source, _ctx: ConnectorContext): Connector {
  return new FeishuDocxConnector(source);
}
