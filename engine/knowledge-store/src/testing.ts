/**
 * Builders for knowledge-store test data, for this package's tests and for every component
 * that tests against MemoryStore. Each builder fills the required fields with plausible
 * values; pass overrides to change any of them.
 *
 *     const kb = new Sample();
 *     const [sv, spans] = kb.sourceVersion(["Hotels: at most 600 yuan a night in tier-1 cities."]);
 *     const [claim, evidence] = kb.claim("The tier-1 hotel cap is 600 yuan a night", spans[0], { quote: "at most 600 yuan a night" });
 */

import {
  type Chunk,
  type Claim,
  type ClaimEvidence,
  contentHash,
  newId,
  type PageSnapshot,
  type Placement,
  type SourceBlock,
  type SourceVersion,
  type Span,
  type TaxonomyNode,
} from "@inspiration/contracts";

export const T0 = new Date("2026-01-01T00:00:00Z");

export interface SampleOptions {
  tenantId?: string;
  spaceId?: string;
  sourceId?: string;
  now?: Date;
}

export class Sample {
  readonly tenantId: string;
  readonly spaceId: string;
  readonly sourceId: string;
  now: Date;

  constructor(options: SampleOptions = {}) {
    this.tenantId = options.tenantId ?? "ten_01JC0000000000000000TENANT";
    this.spaceId = options.spaceId ?? "spc_01JC00000000000000000SPACE";
    this.sourceId = options.sourceId ?? "src_01JC0000000000000000SOURCE";
    this.now = options.now ?? T0;
  }

  /** Move the clock forward (one minute by default) and return the new time. */
  tick(ms = 60_000): Date {
    this.now = new Date(this.now.getTime() + ms);
    return this.now;
  }

  sourceVersion(texts: readonly string[], overrides: Partial<SourceVersion> = {}): [SourceVersion, [Span, ...Span[]]] {
    const version: SourceVersion = {
      id: newId("source_version"),
      tenant_id: this.tenantId,
      source_id: this.sourceId,
      space_id: this.spaceId,
      external_id: "doc-1",
      version: { content_hash: contentHash(texts.join("\n")) },
      title: "Travel policy",
      mime_type: "text/markdown",
      approval_state: "approved",
      authority: 0.9,
      sensitivity: "internal",
      fetched_at: this.tick().toISOString(),
      ...overrides,
    };
    const spans = texts.map((text, i) => this.span(version, text, i));
    return [version, spans as [Span, ...Span[]]];
  }

  span(version: SourceVersion, text: string, ordinal = 0): Span {
    return {
      id: newId("span"),
      tenant_id: version.tenant_id,
      source_version_id: version.id,
      locator: { block_anchor: `b${ordinal}`, kind: "block" },
      text,
      text_hash: contentHash(text),
      ordinal,
    };
  }

  /** A paragraph of the version listing these spans by ID; they may come from earlier versions. */
  block(version: SourceVersion, spans: readonly Span[], overrides: Partial<SourceBlock> = {}): SourceBlock {
    const text = spans.map((s) => s.text).join("");
    const ordinal = overrides.ordinal ?? spans[0]?.ordinal ?? 0;
    return {
      id: newId("source_block"),
      tenant_id: version.tenant_id,
      source_version_id: version.id,
      kind: "paragraph",
      anchor: `b${ordinal}`,
      text,
      text_hash: contentHash(text),
      ordinal,
      span_ids: spans.map((s) => s.id),
      ...overrides,
    };
  }

  chunk(version: SourceVersion, spans: readonly [Span, ...Span[]], overrides: Partial<Chunk> = {}): Chunk {
    const text = spans.map((s) => s.text).join("\n");
    return {
      id: newId("chunk"),
      tenant_id: version.tenant_id,
      source_version_id: version.id,
      space_id: version.space_id,
      ordinal: spans[0].ordinal,
      span_ids: spans.map((s) => s.id) as [string, ...string[]],
      heading_path: [version.title],
      text,
      token_count: text.length,
      content_hash: contentHash(text),
      sensitivity: version.sensitivity,
      acl_tokens: [`tenant:${version.tenant_id}`],
      ...overrides,
    };
  }

  /** A claim and, when span is given, evidence quoting options.quote (default: the whole span). */
  claim(statement: string, span?: Span, overrides: Partial<Claim> & { quote?: string } = {}): [Claim, ClaimEvidence[]] {
    const { quote, ...fields } = overrides;
    const claim: Claim = {
      id: newId("claim"),
      tenant_id: this.tenantId,
      space_id: this.spaceId,
      statement,
      claim_type: "rule",
      knowledge_class: "policy",
      valid_time: {},
      recorded_at: this.tick().toISOString(),
      confidence: 0.9,
      authority: 0.9,
      weight: 1,
      status: "active",
      origin: "extracted",
      sensitivity: "internal",
      inputs_hash: contentHash(statement),
      ...fields,
    };
    if (!span) return [claim, []];
    const q = quote ?? span.text;
    const start = span.text.indexOf(q);
    const evidence: ClaimEvidence = {
      claim_id: claim.id,
      span_id: span.id,
      source_version_id: span.source_version_id,
      role: "supports",
      quote: q,
      ...(start >= 0 && { quote_start: start, quote_end: start + q.length }),
    };
    return [claim, [evidence]];
  }

  topic(key: string, overrides: Partial<TaxonomyNode> = {}): TaxonomyNode {
    return {
      key,
      tenant_id: this.tenantId,
      space_id: this.spaceId,
      title: "Travel lodging",
      ordinal: 0,
      status: "proposed",
      ...overrides,
    };
  }

  /** The claim's placement in a topic, by clustering unless overridden. */
  placement(claim: Claim, taxonomyKey: string, overrides: Partial<Placement> = {}): Placement {
    return {
      tenant_id: claim.tenant_id,
      claim_id: claim.id,
      space_id: claim.space_id,
      taxonomy_key: taxonomyKey,
      placed_by: "clustering",
      confirmed: false,
      placed_at: this.tick().toISOString(),
      ...overrides,
    };
  }

  page(
    pageId: string,
    version: number,
    claimIds: readonly string[] = [],
    overrides: Partial<PageSnapshot> = {},
  ): PageSnapshot {
    return {
      page_id: pageId,
      version,
      spec: {
        page_id: pageId,
        tenant_id: this.tenantId,
        space_id: this.spaceId,
        version,
        inputs_hash: contentHash(`${pageId}@${version}`),
        title: "Hotel standards",
        kind: "policy",
        locale: "en",
        sensitivity: "internal",
        blocks: [
          {
            key: "b_intro",
            type: "paragraph",
            sentences: [{ text: "At most 600 yuan a night in tier-1 cities.", claim_ids: [...claimIds] }],
          },
        ],
        renderer: { component: "page-compiler", name: "default", version: "0.1.0" },
        rendered_at: this.tick().toISOString(),
      },
      cause: { kind: version === 1 ? "initial" : "source_change" },
      created_at: this.now.toISOString(),
      ...overrides,
    };
  }
}
