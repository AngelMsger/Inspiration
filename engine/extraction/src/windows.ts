/**
 * What one model call reads, a window of a version's blocks in reading order, and the claims
 * built from what the model says about it.
 */

import {
  type Claim,
  type ClaimEvidence,
  contentHash,
  type KnowledgeStore,
  type ProducerInfo,
  type SourceBlock,
  type SourceVersion,
  type Span,
  slotOf,
  stableId,
} from "@inspiration/contracts";
import { type ExtractedClaim, PROMPT_VERSION, type WindowBlock } from "./protocol.ts";

/** A claim read from a window, with its evidence. */
export interface Built {
  claim: Claim;
  evidence: ClaimEvidence[];
  /** The blocks of the spans it cites. */
  blocks: Set<string>;
}

/** The blocks one model call reads. */
export interface Window {
  blocks: WindowBlock[];
  /** Local span reference to span. */
  spans: Map<string, Span>;
  text: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The start of a YYYY-MM-DD day, in UTC: the engine knows no tenant time zone yet. */
export function dayStart(day: unknown): string | undefined {
  return typeof day === "string" && DAY.test(day) && !Number.isNaN(Date.parse(day)) ? `${day}T00:00:00Z` : undefined;
}

/**
 * Target blocks in reading order, cut into windows of about windowChars characters. Given
 * touches, only the blocks whose text, headings or table header it accepts.
 */
export async function windowsOf(
  store: KnowledgeStore,
  version: SourceVersion,
  targets: ReadonlySet<string>,
  windowChars: number,
  touches?: (text: string) => boolean,
): Promise<Window[]> {
  const blocks = (await store.blocksOf(version.id)).sort((a, b) => a.ordinal - b.ordinal);
  // A table row is read with its table's header row, which is never sent on its own; a
  // changed header changes how every row of its table reads.
  const headerRows = new Map<string, SourceBlock>();
  for (const b of blocks) {
    if (b.kind !== "table_row" || !b.parent_id || headerRows.has(b.parent_id)) continue;
    const table = blocks.find((t) => t.id === b.parent_id);
    if (Number(table?.attrs?.header_rows ?? 0) > 0) headerRows.set(b.parent_id, b);
  }
  const headerIds = new Set([...headerRows.values()].map((b) => b.id));
  const rereadTables = new Set([...headerRows].filter(([, h]) => targets.has(h.id)).map(([table]) => table));
  const named = (b: SourceBlock) => {
    const header = b.kind === "table_row" && b.parent_id ? headerRows.get(b.parent_id) : undefined;
    return [b.text, ...(b.heading_path ?? []), header?.text ?? ""].some((t) => touches?.(t));
  };
  const wanted = blocks.filter(
    (b) =>
      (targets.has(b.id) || (b.parent_id !== undefined && rereadTables.has(b.parent_id))) &&
      b.span_ids.length &&
      (!touches || named(b)),
  );
  const needed = [...new Set([...wanted, ...headerRows.values()].flatMap((b) => b.span_ids))];
  const spans = new Map((await store.getSpans(needed)).map((s) => [s.id, s]));
  const textOf = (b: SourceBlock) => b.span_ids.map((id) => spans.get(id)?.text ?? "");

  const windows: Window[] = [];
  let current: Window = { blocks: [], spans: new Map(), text: "" };
  for (const b of wanted) {
    if (headerIds.has(b.id)) continue;
    const length = textOf(b).join("").length;
    if (current.blocks.length && current.text.length + length > windowChars) {
      windows.push(current);
      current = { blocks: [], spans: new Map(), text: "" };
    }
    const block: WindowBlock = { kind: b.kind, heading_path: b.heading_path ?? [], spans: [] };
    const header = b.kind === "table_row" && b.parent_id ? headerRows.get(b.parent_id) : undefined;
    if (b.kind === "table_row") block.header = header ? textOf(header).map((t) => t.trim()) : [];
    for (const id of b.span_ids) {
      const span = spans.get(id);
      if (!span) continue;
      const ref = `s${current.spans.size + 1}`;
      current.spans.set(ref, span);
      block.spans.push({ ref, text: span.text });
    }
    current.blocks.push(block);
    current.text += `${[...block.heading_path, ...(block.header ?? []), ...block.spans.map((s) => s.text)].join("\n")}\n`;
  }
  if (current.blocks.length) windows.push(current);
  return windows;
}

/** The claim and its evidence, or undefined when no quote is verbatim from a given span. */
export function buildClaim(
  version: SourceVersion,
  window: Window,
  extracted: ExtractedClaim,
  producer: ProducerInfo,
  now: string,
): Built | undefined {
  const cited = extracted.evidence.flatMap((e) => {
    const span = window.spans.get(e.span);
    const start = span?.text.indexOf(e.quote) ?? -1;
    return span && start >= 0 ? [{ span, quote: e.quote, start }] : [];
  });
  if (!cited.length) return undefined;
  const spanIds = [...new Set(cited.map((c) => c.span.id))].sort();
  const statement = extracted.statement.trim();
  // What the claim says, not only its words: under a renamed heading the same sentence
  // can have another subject.
  const says = JSON.stringify([
    statement,
    extracted.claim_type,
    extracted.knowledge_class ?? "general",
    extracted.subject ?? null,
    extracted.predicate ?? null,
    extracted.value ?? null,
    extracted.qualifiers ?? [],
  ]);
  const id = stableId("claim", version.tenant_id, PROMPT_VERSION, says, ...spanIds);
  const confidence = extracted.confidence ?? 0.7;
  const authority = version.authority ?? 0.5;
  const claim: Claim = {
    id,
    tenant_id: version.tenant_id,
    space_id: version.space_id,
    statement,
    claim_type: extracted.claim_type,
    knowledge_class: extracted.knowledge_class ?? "general",
    valid_time: {},
    recorded_at: now,
    confidence,
    authority,
    weight: Number((authority * confidence).toFixed(4)),
    status: "active",
    origin: "extracted",
    sensitivity: version.sensitivity,
    producer,
    inputs_hash: contentHash(JSON.stringify([PROMPT_VERSION, statement, cited.map((c) => [c.span.id, c.quote])])),
    created_at: now,
    updated_at: now,
  };
  const start = dayStart(extracted.valid_from) ?? dayStart(version.metadata?.extra?.effective_from);
  if (start) claim.valid_time = { start };
  if (version.language) claim.language = version.language;
  if (extracted.subject) claim.subject_text = extracted.subject;
  if (extracted.predicate) claim.predicate = extracted.predicate;
  if (extracted.value) claim.value = extracted.value;
  if (extracted.qualifiers?.length) claim.qualifiers = extracted.qualifiers;
  const slot = slotOf(claim);
  if (slot) claim.slot_key = slot;
  const evidence = cited.map(
    (c): ClaimEvidence => ({
      claim_id: id,
      span_id: c.span.id,
      source_version_id: c.span.source_version_id,
      role: "supports",
      quote: c.quote,
      quote_start: c.start,
      quote_end: c.start + c.quote.length,
    }),
  );
  const blocks = new Set(cited.flatMap((c) => (c.span.block_id ? [c.span.block_id] : [])));
  return { claim, evidence, blocks };
}
