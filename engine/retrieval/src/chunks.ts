/**
 * Chunks: a version's blocks in reading order, packed into retrieval units. A chunk starts
 * at a heading once the one before it holds MIN_TOKENS, and never grows past MAX_TOKENS; a
 * block longer than that is cut between its spans. Headings travel with the text below
 * them, and table containers are left out, since their rows carry the same text.
 *
 * A chunk's ID comes from its document, heading path and text, so an unchanged chunk keeps
 * its ID, its contextual header and its embedding in the document's next version.
 */

import { contentHash, type SourceBlock, type Span, stableId } from "@inspiration/contracts";
import { estimateTokens } from "@inspiration/model-gateway";

export const MIN_TOKENS = 400;
export const MAX_TOKENS = 800;

/** A chunk before the indexer adds its version, space, sensitivity, header and tokens. */
export interface ChunkDraft {
  id: string;
  ordinal: number;
  heading_path: string[];
  span_ids: [string, ...string[]];
  text: string;
  token_count: number;
  content_hash: string;
}

interface Piece {
  heading: boolean;
  path: string[];
  text: string;
  spanIds: string[];
  tokens: number;
}

function piecesOf(blocks: readonly SourceBlock[], spans: ReadonlyMap<string, Span>): Piece[] {
  const out: Piece[] = [];
  for (const b of [...blocks].sort((x, y) => x.ordinal - y.ordinal)) {
    const path = b.heading_path ?? [];
    if (b.kind === "heading") {
      if (b.text)
        out.push({ heading: true, path: [...path, b.text], text: b.text, spanIds: [], tokens: estimateTokens(b.text) });
      continue;
    }
    const own = b.span_ids.map((id) => spans.get(id)).filter((s): s is Span => s !== undefined);
    if (!own.length) continue;
    const whole = estimateTokens(b.text);
    if (whole <= MAX_TOKENS) {
      out.push({ heading: false, path, text: b.text, spanIds: own.map((s) => s.id), tokens: whole });
      continue;
    }
    // A block too long for one chunk is cut between its spans.
    for (const s of own)
      out.push({ heading: false, path, text: s.text, spanIds: [s.id], tokens: estimateTokens(s.text) });
  }
  return out;
}

export function chunk(
  doc: { tenantId: string; sourceId: string; externalId: string },
  blocks: readonly SourceBlock[],
  spans: ReadonlyMap<string, Span>,
): ChunkDraft[] {
  const drafts: ChunkDraft[] = [];
  const seen = new Map<string, number>();
  let current: Piece[] = [];
  const size = (extra: readonly Piece[] = []) => estimateTokens([...current, ...extra].map((p) => p.text).join("\n"));
  const flush = () => {
    const body = current.filter((p) => !p.heading);
    if (body.length) {
      const text = current.map((p) => p.text).join("\n");
      const path = (body[0] as Piece).path;
      const key = [path.join("\x1e"), text].join("\x1f");
      const n = seen.get(key) ?? 0;
      seen.set(key, n + 1);
      drafts.push({
        id: stableId("chunk", doc.tenantId, doc.sourceId, doc.externalId, key, String(n)),
        ordinal: drafts.length,
        heading_path: path,
        span_ids: body.flatMap((p) => p.spanIds) as [string, ...string[]],
        text,
        token_count: estimateTokens(text),
        content_hash: contentHash(text),
      });
      current = [];
    }
    // Headings with nothing under them yet stay for the next chunk.
  };
  for (const p of piecesOf(blocks, spans)) {
    const body = current.some((c) => !c.heading);
    if ((p.heading && body && size() >= MIN_TOKENS) || (body && size([p]) > MAX_TOKENS)) flush();
    current.push(p);
  }
  flush();
  return drafts;
}
