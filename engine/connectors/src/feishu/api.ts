/**
 * The slice of the Feishu (Lark) open platform the connectors use, as an interface, so the
 * same connector code runs on recorded fixtures now and on the HTTP API with app credentials. Shapes follow the API's JSON (docx/v1 blocks, drive permission
 * members, approval/v4 definitions and instances), trimmed to the fields we read.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface TextElement {
  text_run?: { content: string };
  mention_user?: { user_id: string };
  mention_doc?: { title?: string; url?: string };
}

export interface TextBody {
  elements: TextElement[];
}

/** One docx block. block_type: 1 page, 2 text, 3-11 heading1-9, 12 bullet, 13 ordered, 14 code,
 * 15 quote, 17 todo, 19 callout, 22 divider, 27 image, 31 table, 32 table cell. */
export interface FeishuBlock {
  block_id: string;
  block_type: number;
  parent_id?: string;
  children?: string[];
  page?: TextBody;
  text?: TextBody;
  heading1?: TextBody;
  heading2?: TextBody;
  heading3?: TextBody;
  heading4?: TextBody;
  heading5?: TextBody;
  heading6?: TextBody;
  heading7?: TextBody;
  heading8?: TextBody;
  heading9?: TextBody;
  bullet?: TextBody;
  ordered?: TextBody;
  code?: TextBody;
  quote?: TextBody;
  todo?: TextBody;
  table?: { cells: string[]; property: { row_size: number; column_size: number } };
}

export interface PermissionMember {
  /** openid (a user), openchat (a group chat), opendepartmentid (a department). */
  member_type: "openid" | "openchat" | "opendepartmentid";
  member_id: string;
  perm: "view" | "edit" | "full_access";
}

export interface DocumentMeta {
  document_id: string;
  revision_id: number;
  title: string;
  modified_at?: string;
  url?: string;
  /** Wiki path from the space root. */
  path?: string[];
  owner_id?: string;
}

export interface FeishuDocument {
  meta: DocumentMeta;
  blocks: FeishuBlock[];
  members: PermissionMember[];
  /** tenant_readable, anyone_readable or closed. */
  link_share_entity?: string;
  /** Fields a tenant keeps in document properties: approval state, classification, governance level. */
  properties?: Record<string, unknown>;
}

export interface ApprovalNode {
  node_id: string;
  name: string;
  node_type: string;
  approver?: string;
}

export interface ApprovalDefinitionData {
  approval_code: string;
  approval_name: string;
  version?: string;
  form: { id: string; name: string; type?: string; required?: boolean; options?: string[] }[];
  node_list: ApprovalNode[];
}

export interface ApprovalInstanceData {
  instance_code: string;
  status: string;
  start_time: string;
  end_time?: string;
  form: Record<string, unknown>;
  timeline: { type: string; node_id?: string; user_id?: string; create_time: string; comment?: string }[];
}

export interface FeishuApproval {
  definition: ApprovalDefinitionData;
  instances: ApprovalInstanceData[];
  modified_at: string;
  viewers?: PermissionMember[];
  properties?: Record<string, unknown>;
}

export interface FeishuApi {
  readonly connectionScoped?: boolean;
  listDocuments(): Promise<DocumentMeta[]>;
  document(documentId: string): Promise<FeishuDocument>;
  listApprovals(): Promise<{ approval_code: string; approval_name: string; modified_at: string }[]>;
  approval(approvalCode: string): Promise<FeishuApproval>;
}

/**
 * Feishu content recorded as JSON files: docs/<document_id>.json (a FeishuDocument) and
 * approvals/<approval_code>.json (a FeishuApproval).
 */
export class FixtureFeishuApi implements FeishuApi {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async #json<T>(...parts: string[]): Promise<T> {
    return JSON.parse(await readFile(join(this.root, ...parts), "utf8")) as T;
  }

  async #names(dir: string): Promise<string[]> {
    try {
      return (await readdir(join(this.root, dir))).filter((f) => f.endsWith(".json")).sort();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  }

  async listDocuments(): Promise<DocumentMeta[]> {
    const out: DocumentMeta[] = [];
    for (const f of await this.#names("docs")) out.push((await this.#json<FeishuDocument>("docs", f)).meta);
    return out;
  }

  document(documentId: string): Promise<FeishuDocument> {
    return this.#json("docs", `${documentId}.json`);
  }

  async listApprovals(): Promise<{ approval_code: string; approval_name: string; modified_at: string }[]> {
    const out = [];
    for (const f of await this.#names("approvals")) {
      const a = await this.#json<FeishuApproval>("approvals", f);
      out.push({
        approval_code: a.definition.approval_code,
        approval_name: a.definition.approval_name,
        modified_at: a.modified_at,
      });
    }
    return out;
  }

  approval(approvalCode: string): Promise<FeishuApproval> {
    return this.#json("approvals", `${approvalCode}.json`);
  }
}

/** The API for a source: recorded fixtures when scope.options.fixtures is set. */
export function feishuApi(options: Readonly<Record<string, unknown>> | undefined): FeishuApi {
  const fixtures = options?.fixtures;
  if (typeof fixtures === "string") return new FixtureFeishuApi(fixtures);
  // Live sources use HttpFeishuApi through the connector factory, which supplies its secret context.
  throw new RangeError(
    "use scope.options.fixtures for recorded Feishu data, or the connector factory for a live connection",
  );
}
