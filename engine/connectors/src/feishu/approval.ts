/**
 * Feishu approval definitions with a window of their instances, for SOP mining. Each
 * definition is one item; a new instance or a changed definition is a new version.
 * Approvers in instance timelines are pseudonymized unless scope.options.real_actor_ids.
 *
 * Scope: `{ kind: "feishu.approvals", ids?: [approval codes], options: { fixtures: "<dir>" } }`.
 */

import {
  type ApprovalAction,
  type ApprovalInstanceStatus,
  type ApprovalNodeType,
  type ApprovalState,
  type Connector,
  type ConnectorCapabilities,
  type ConnectorContext,
  type Cursor,
  canonicalJson,
  contentHash,
  isGovernanceLevel,
  type ListPage,
  type NormalizedDocument,
  type ProcessSnapshot,
  type ScopeSpec,
  type Source,
  type SourceRef,
  sameVersion,
  type Unchanged,
  type Version,
} from "@inspiration/contracts";
import { aclHash, aclSnapshot } from "../acl.ts";
import { type FeishuApi, type FeishuApproval, feishuApi } from "./api.ts";
import { memberEntries } from "./docx.ts";

const ACTIONS: Record<string, ApprovalAction> = {
  START: "start",
  PASS: "approve",
  REJECT: "reject",
  TRANSFER: "transfer",
  ROLLBACK: "return",
  ADD_APPROVER: "add_sign",
  CC: "cc",
  AUTO_PASS: "auto_pass",
  CANCEL: "withdraw",
};
const NODE_TYPES: Record<string, ApprovalNodeType> = {
  START: "start",
  APPROVAL: "approval",
  CC: "cc",
  CONDITION: "condition",
  HANDLER: "handler",
  END: "end",
};
const STATUSES: Record<string, ApprovalInstanceStatus> = {
  PENDING: "pending",
  APPROVED: "approved",
  REJECTED: "rejected",
  CANCELED: "canceled",
  DELETED: "deleted",
};

export function processSnapshot(a: FeishuApproval, options: { realActorIds?: boolean } = {}): ProcessSnapshot {
  const actor = (id: string | undefined) =>
    id === undefined ? undefined : options.realActorIds ? id : `actor-${contentHash(id).slice(7, 19)}`;
  const d = a.definition;
  const times = a.instances.map((i) => i.start_time).sort();
  const snapshot: ProcessSnapshot = {
    definition: {
      code: d.approval_code,
      name: d.approval_name,
      ...(d.version !== undefined && { definition_version: d.version }),
      form_fields: d.form.map((f) => ({
        key: f.id,
        label: f.name,
        ...(f.type !== undefined && { field_type: f.type }),
        ...(f.options !== undefined && { options: f.options }),
        ...(f.required !== undefined && { required: f.required }),
      })),
      nodes: d.node_list.map((n, order) => ({
        key: n.node_id,
        name: n.name,
        node_type: NODE_TYPES[n.node_type] ?? "other",
        ...(n.approver !== undefined && { approver_rule: n.approver }),
        order,
      })),
    },
    instances: a.instances.map((i) => ({
      instance_id: i.instance_code,
      definition_code: d.approval_code,
      status: STATUSES[i.status] ?? "other",
      started_at: i.start_time,
      ...(i.end_time !== undefined && { ended_at: i.end_time }),
      form: i.form,
      timeline: i.timeline.map((t) => {
        const who = actor(t.user_id);
        return {
          action: ACTIONS[t.type] ?? "other",
          at: t.create_time,
          ...(t.node_id !== undefined && { node_key: t.node_id }),
          ...(who !== undefined && { actor_external_id: who }),
          ...(t.comment !== undefined && { comment: t.comment }),
        };
      }),
    })),
  };
  if (times.length) snapshot.window = { start: times[0] as string, end: a.modified_at };
  return snapshot;
}

export class FeishuApprovalConnector implements Connector {
  readonly type = "feishu.approval";
  readonly source: Source;
  readonly api: FeishuApi;

  constructor(source: Source, api: FeishuApi = feishuApi(source.scope.options)) {
    this.source = source;
    this.api = api;
  }

  capabilities(): ConnectorCapabilities {
    return { list: true, fetch: true, acl: true, acl_fidelity: "approximate", process: true };
  }

  #version(a: FeishuApproval): Version {
    return {
      external_version: a.definition.version ?? a.modified_at,
      modified_at: a.modified_at,
      content_hash: contentHash(canonicalJson([a.definition, a.instances])),
      metadata_hash: contentHash(canonicalJson(a.properties ?? {})),
      acl_hash: aclHash(memberEntries(a.viewers ?? [])),
    };
  }

  #ref(a: FeishuApproval): SourceRef {
    return {
      source_id: this.source.id,
      external_id: a.definition.approval_code,
      kind: "approval_definition",
      title: a.definition.approval_name,
    };
  }

  async list(scope: ScopeSpec, _cursor?: Cursor): Promise<ListPage> {
    const wanted = scope.ids?.length ? new Set(scope.ids) : undefined;
    const items = [];
    for (const meta of await this.api.listApprovals()) {
      if (wanted && !wanted.has(meta.approval_code)) continue;
      const a = await this.api.approval(meta.approval_code);
      items.push({ ref: this.#ref(a), version: this.#version(a) });
    }
    return { items };
  }

  async fetch(ref: SourceRef, known?: Version): Promise<NormalizedDocument | Unchanged> {
    const a = await this.api.approval(ref.external_id);
    const version = this.#version(a);
    if (sameVersion(known, version)) return { unchanged: true };
    const realActorIds = this.source.scope.options?.real_actor_ids === true;
    const { approval_state, governance_level, ...extra } = a.properties ?? {};
    const doc: NormalizedDocument = {
      ref: this.#ref(a),
      version,
      title: a.definition.approval_name,
      mime_type: "application/vnd.inspiration.process+json",
      language: "zh-CN",
      process: processSnapshot(a, { realActorIds }),
      metadata: { modified_at: a.modified_at, ...(Object.keys(extra).length > 0 && { extra }) },
      acl: aclSnapshot(this.source.id, a.definition.approval_code, memberEntries(a.viewers ?? []), {
        fidelity: "approximate",
        capturedAt: new Date(),
      }),
    };
    if (typeof approval_state === "string") doc.approval_state = approval_state as ApprovalState;
    if (isGovernanceLevel(governance_level)) doc.governance_level = governance_level;
    return doc;
  }
}

export function feishuApprovalConnector(source: Source, _ctx: ConnectorContext): Connector {
  return new FeishuApprovalConnector(source);
}
