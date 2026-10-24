/**
 * Reads built on the primitive reads: lineage graphs and DataRef resolution. Shared by the
 * Postgres and in-memory stores.
 */

import {
  type AclSnapshot,
  type Chunk,
  type Claim,
  type ClaimDerivation,
  type ClaimEvidence,
  type ClaimQuery,
  canonicalJson,
  contentHash,
  type DataColumn,
  type DataProvider,
  type DataRef,
  type DataTable,
  type DependencyEdge,
  type EvidenceRole,
  type KnowledgeStore,
  kindOf,
  type LineageEdge,
  type LineageGraph,
  type LineageNode,
  type LineageRelation,
  type PageSnapshot,
  type PageVersionInfo,
  type SourceBlock,
  type SourceVersion,
  type Span,
  type StoreTx,
} from "@inspiration/contracts";
import { IntegrityError } from "./rules.ts";

export const LABEL_CHARS = 80;

export interface StoreOptions {
  /** Providers for QueryData, by their name. */
  dataProviders?: readonly DataProvider[];
  clock?: () => Date;
}

/** The value of one ClaimsData column for a claim (see ClaimsData.columns). */
export function claimField(claim: Claim, field: string): unknown {
  const v = claim.value;
  switch (field) {
    case "claim_id":
      return claim.id;
    case "statement":
      return claim.statement;
    case "subject":
      return claim.subject_text ?? claim.subject_entity_id ?? null;
    case "predicate":
      return claim.predicate ?? null;
    case "value_number":
      return v?.number ?? null;
    case "value_text":
      return v?.text ?? v?.normalized ?? null;
    case "value_unit":
      return v?.unit ?? null;
    case "value_min":
      return v?.min ?? null;
    case "value_max":
      return v?.max ?? null;
    case "currency":
      return v?.currency ?? null;
    case "value_date":
      return v?.date ?? null;
    case "valid_from":
      return claim.valid_time.start ?? null;
    case "valid_to":
      return claim.valid_time.end ?? null;
    case "confidence":
      return claim.confidence;
    case "status":
      return claim.status;
    case "knowledge_class":
      return claim.knowledge_class;
    case "recorded_at":
      return claim.recorded_at;
    default:
      return null;
  }
}

/** Hash of a table's column fields and rows, so a view can tell whether its data changed. */
export function rowsHash(columns: readonly DataColumn[], rows: readonly (readonly unknown[])[]): string {
  return contentHash(canonicalJson([columns.map((c) => c.field), rows]));
}

/** Lineage and resolveData in terms of the primitive reads each backend implements. */
export abstract class BaseStore implements KnowledgeStore {
  readonly dataProviders: ReadonlyMap<string, DataProvider>;
  readonly clock: () => Date;

  constructor(options: StoreOptions = {}) {
    this.dataProviders = new Map((options.dataProviders ?? []).map((p) => [p.name, p]));
    this.clock = options.clock ?? (() => new Date());
  }

  abstract transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T>;
  abstract getSourceVersion(versionId: string): Promise<SourceVersion | undefined>;
  abstract latestSourceVersion(sourceId: string, externalId: string): Promise<SourceVersion | undefined>;
  abstract getSpans(spanIds: readonly string[]): Promise<Span[]>;
  abstract spansOf(sourceVersionId: string): Promise<Span[]>;
  abstract blocksOf(sourceVersionId: string): Promise<SourceBlock[]>;
  abstract getChunks(chunkIds: readonly string[]): Promise<Chunk[]>;
  abstract chunksOf(sourceVersionId: string): Promise<Chunk[]>;
  abstract getClaims(claimIds: readonly string[]): Promise<Claim[]>;
  abstract evidenceOf(claimIds: readonly string[]): Promise<ClaimEvidence[]>;
  abstract claimsCiting(spanIds: readonly string[]): Promise<string[]>;
  abstract asOf(query: ClaimQuery, options?: { validAt?: Date; knownAt?: Date }): Promise<Claim[]>;
  abstract dependents(artifactIds: readonly string[]): Promise<string[]>;
  abstract getPage(pageId: string, version?: number): Promise<PageSnapshot | undefined>;
  abstract pageHistory(pageId: string): Promise<PageVersionInfo[]>;
  abstract getAclSnapshot(sourceId: string, externalId: string, aclHash?: string): Promise<AclSnapshot | undefined>;
  abstract derivationsOf(claimIds: readonly string[]): Promise<ClaimDerivation[]>;
  /** The recorded inputs of each artifact. */
  abstract inputsOf(artifactIds: readonly string[]): Promise<DependencyEdge[]>;

  /**
   * Walk from a unit down to source versions. Edges point from a unit to what it was built
   * from, except "contains", which points from a source version to its span.
   */
  async lineage(unitId: string, depth = 3): Promise<LineageGraph> {
    const nodes = new Map<string, LineageNode>();
    const edges: LineageEdge[] = [];
    const seenEdges = new Set<string>();
    const node = (id: string, label?: string) => {
      if (!nodes.has(id) || (label && !nodes.get(id)?.label)) nodes.set(id, label ? { id, label } : { id });
    };
    const edge = (fromId: string, toId: string, relation: LineageRelation, role?: EvidenceRole) => {
      const key = `${fromId}\x1f${toId}\x1f${relation}\x1f${role ?? ""}`;
      if (seenEdges.has(key)) return;
      seenEdges.add(key);
      edges.push({ from_id: fromId, to_id: toId, relation, ...(role && { role }) });
    };
    const labelVersions = async (ids: readonly string[]) => {
      for (const id of ids) {
        const sv = await this.getSourceVersion(id);
        if (sv) node(sv.id, sv.title);
      }
    };

    node(unitId);
    let frontier = [unitId];
    const expanded = new Set<string>();
    for (let level = 0; level < depth && frontier.length; level++) {
      const byKind = new Map<string, string[]>();
      for (const id of frontier) {
        expanded.add(id);
        const kind = kindOf(id);
        byKind.set(kind, [...(byKind.get(kind) ?? []), id]);
      }
      const next: string[] = [];
      const claimIds = byKind.get("claim") ?? [];
      const spanIds = byKind.get("span") ?? [];
      const versionIds = byKind.get("source_version") ?? [];
      const pageIds = byKind.get("page") ?? [];
      // Pages, SOPs, views and other built artifacts: their inputs are dependency edges.
      const others = [...byKind]
        .filter(([k]) => !["claim", "span", "source_version"].includes(k))
        .flatMap(([, v]) => v);

      if (claimIds.length) {
        for (const c of await this.getClaims(claimIds)) {
          node(c.id, c.statement.slice(0, LABEL_CHARS));
          if (c.superseded_by) {
            node(c.superseded_by);
            edge(c.superseded_by, c.id, "supersedes");
          }
        }
        for (const e of await this.evidenceOf(claimIds)) {
          node(e.span_id);
          edge(e.claim_id, e.span_id, "cites", e.role);
          next.push(e.span_id);
        }
        for (const d of await this.derivationsOf(claimIds)) {
          for (const f of d.from_claim_ids) {
            node(f);
            edge(d.claim_id, f, "derived_from");
            next.push(f);
          }
        }
      }
      if (spanIds.length) {
        for (const s of await this.getSpans(spanIds)) {
          node(s.id, s.text.slice(0, LABEL_CHARS));
          node(s.source_version_id);
          edge(s.source_version_id, s.id, "contains");
          next.push(s.source_version_id);
        }
      }
      await labelVersions(versionIds);
      for (const pageId of pageIds) {
        const page = await this.getPage(pageId);
        if (page) node(pageId, page.spec.title);
      }
      if (claimIds.length || others.length) {
        for (const dep of await this.inputsOf([...claimIds, ...others])) {
          node(dep.input_id);
          edge(dep.artifact_id, dep.input_id, "depends_on");
          next.push(dep.input_id);
        }
      }
      frontier = [...new Set(next)].filter((id) => !expanded.has(id));
    }

    // Source versions are leaves; anything else left unexpanded may have more provenance.
    const truncated = frontier.some((id) => kindOf(id) !== "source_version");
    await labelVersions(frontier.filter((id) => kindOf(id) === "source_version"));
    return { root_id: unitId, nodes: [...nodes.values()], edges, truncated };
  }

  async resolveData(ref: DataRef): Promise<DataTable> {
    const resolvedAt = this.clock().toISOString();
    switch (ref.kind) {
      case "inline":
        return {
          columns: ref.columns,
          rows: ref.rows,
          ...(ref.row_claim_ids && { row_claim_ids: ref.row_claim_ids }),
          resolved_at: resolvedAt,
          snapshot_hash: rowsHash(ref.columns, ref.rows),
        };
      case "claims": {
        let claims: Claim[];
        if (ref.claim_ids?.length) {
          const found = new Map((await this.getClaims(ref.claim_ids)).map((c) => [c.id, c]));
          claims = ref.claim_ids.flatMap((id) => found.get(id) ?? []);
        } else if (ref.query) {
          claims = await this.asOf(ref.query);
        } else {
          throw new IntegrityError("claims data needs claim_ids or a query");
        }
        const rows = claims.map((c) => ref.columns.map((col) => claimField(c, col.field)));
        return {
          columns: ref.columns,
          rows,
          row_claim_ids: claims.map((c) => [c.id]),
          resolved_at: resolvedAt,
          snapshot_hash: rowsHash(ref.columns, rows),
        };
      }
      case "query": {
        const provider = this.dataProviders.get(ref.provider);
        if (!provider) throw new RangeError(`no data provider ${JSON.stringify(ref.provider)} is configured`);
        const table = await provider.run(ref.query_id, ref.params ?? {}, ref.columns);
        const fields = (columns: readonly DataColumn[]) => columns.map((c) => c.field).join("\x1f");
        if (fields(table.columns) !== fields(ref.columns)) {
          throw new IntegrityError(`data provider ${ref.provider} returned other columns than requested`);
        }
        return table.snapshot_hash ? table : { ...table, snapshot_hash: rowsHash(table.columns, table.rows) };
      }
    }
  }
}
