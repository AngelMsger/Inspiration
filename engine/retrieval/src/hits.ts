// What search makes of what it found: passages and statements as hits with their citations,
// marked with where each value stands, and the notes an answer gives on disputed and outdated
// values. Pure functions over what Retrieval read; Retrieval does the reading.

import type {
  AnswerNote,
  Chunk,
  Citation,
  Claim,
  FreshnessInfo,
  IndexFilter,
  SearchHit,
  SearchQuery,
  SensitivityLabel,
  SlotVerdict,
  SourceVersion,
  Span,
  Staleness,
} from "@inspiration/contracts";
import { slotOf, valueKeyOf } from "@inspiration/contracts";
import { estimateTokens } from "@inspiration/model-gateway";
import { fill, overlap, type packFor } from "./text.ts";

/** A chunk that passed the permission check, with its version and fused score. */
export interface Found {
  chunk: Chunk;
  version: SourceVersion;
  fused: number;
  spans: Span[];
}

/** A statement found through the chunks that quote it. */
export interface Statement {
  claim: Claim;
  base: number;
  citations: Citation[];
  title: string;
  version?: SourceVersion;
  verdict?: SlotVerdict;
}

export interface Searched {
  hits: SearchHit[];
  statements: Map<string, Statement>;
  verdicts: Map<string, SlotVerdict>;
  filter: IndexFilter;
  filters?: SearchQuery["filters"];
  /** The sensitivity of every unit found. */
  labels: Map<string, SensitivityLabel>;
}

/** An outdated value ranks as if it scored this share of its score. */
export const OUTDATED_WEIGHT = 0.5;

/** About how long a passage's snippet is. */
export const SNIPPET_TOKENS = 80;

export function titleOf(version: SourceVersion, path?: readonly string[]): string {
  const title = version.title ?? version.external_id;
  const last = path?.at(-1);
  return last && last !== title ? `${title} › ${last}` : title;
}

export function citationOf(span: Span, version: SourceVersion, quote: string): Citation {
  return {
    span_id: span.id,
    source_version_id: version.id,
    source_title: version.title ?? version.external_id,
    ...(version.uri && { uri: version.uri }),
    quote,
    locator: span.locator,
    fetched_at: version.fetched_at,
  };
}

/**
 * The spans of a found chunk that share most of the query, in reading order, up to about
 * SNIPPET_TOKENS; the first span when none shares a word.
 */
export function snippetOf(f: Found, words: ReadonlySet<string>): { text: string; spans: Span[] } {
  const ranked = f.spans
    .map((s, i) => ({ s, i, near: overlap(words, s.text) }))
    .sort((a, b) => b.near - a.near || a.i - b.i);
  const picked: typeof ranked = [];
  let size = 0;
  for (const r of ranked) {
    if (picked.length && (r.near === 0 || size + estimateTokens(r.s.text) > SNIPPET_TOKENS)) break;
    picked.push(r);
    size += estimateTokens(r.s.text);
  }
  const spans = picked.sort((a, b) => a.i - b.i).map((r) => r.s);
  return { text: spans.map((s) => s.text).join(" "), spans };
}

/** A passage as a hit, quoting the spans given. */
export function passageHit(f: Found, spans: readonly Span[], score: number, freshness: FreshnessInfo): SearchHit {
  return {
    unit_id: f.chunk.id,
    kind: "chunk",
    title: titleOf(f.version, f.chunk.heading_path),
    snippet: spans.map((s) => s.text).join(" "),
    score,
    citations: spans.map((span) => citationOf(span, f.version, span.text)),
    freshness,
    review_status: "unreviewed",
    token_estimate: f.chunk.token_count + estimateTokens(f.chunk.contextual_header ?? ""),
    space_id: f.chunk.space_id,
    ...(f.version.language && { language: f.version.language }),
  };
}

/** A statement as a hit, marked with where its value stands and which value holds instead. */
export function statementHit(s: Statement, score: number, freshness: FreshnessInfo): SearchHit {
  const standing = standingOf(s.claim, s.verdict);
  const held = s.verdict && standing !== "holds" ? s.verdict.values[0]?.claim_ids[0] : undefined;
  const slot = slotOf(s.claim);
  // Both sides of an open contradiction are in dispute, the one that holds for now too.
  const disputed = s.verdict?.disputed && (standing === "holds" || standing === "disputed");
  return {
    unit_id: s.claim.id,
    kind: "claim",
    title: s.title,
    snippet: s.claim.statement,
    score: score * (standing === "outdated" ? OUTDATED_WEIGHT : 1),
    citations: s.citations,
    freshness,
    confidence: s.claim.confidence,
    review_status: disputed ? "disputed" : s.claim.status === "verified" ? "verified" : "unreviewed",
    ...(s.claim.owner_id && { owner_id: s.claim.owner_id }),
    token_estimate:
      estimateTokens(s.claim.statement) +
      s.citations.reduce((n: number, c: Citation) => n + estimateTokens(c.quote), 0),
    space_id: s.claim.space_id,
    ...(s.claim.language && { language: s.claim.language }),
    ...(slot && { slot_key: slot }),
    ...(standing && { standing }),
    ...(held && held !== s.claim.id && { held_unit_id: held }),
  };
}

/**
 * The hits an answer reads. A passage's sentence that states a value of a fact slot other
 * than the one that holds brings its statement along, marked, so the value that holds joins
 * too; a sentence that only states replaced values is left out of the passage, and a
 * passage with nothing left is left out.
 */
export function passagesWithoutReplaced(searched: Searched): SearchHit[] {
  const quoting = new Map<string, Statement[]>();
  for (const s of searched.statements.values()) {
    if (!standingOf(s.claim, s.verdict)) continue;
    for (const c of s.citations) quoting.set(c.span_id, [...(quoting.get(c.span_id) ?? []), s]);
  }
  const have = new Set(searched.hits.map((h) => h.unit_id));
  const hits: SearchHit[] = [];
  const brought: SearchHit[] = [];
  for (const h of searched.hits) {
    if (h.kind !== "chunk") {
      hits.push(h);
      continue;
    }
    const kept = h.citations.filter((c) => {
      const by = quoting.get(c.span_id) ?? [];
      for (const s of by) {
        if (have.has(s.claim.id) || standingOf(s.claim, s.verdict) === "holds") continue;
        have.add(s.claim.id);
        brought.push(statementHit(s, 0, h.freshness));
      }
      return !by.length || by.some((s) => standingOf(s.claim, s.verdict) !== "outdated");
    });
    if (kept.length === h.citations.length) hits.push(h);
    else if (kept.length) hits.push({ ...h, citations: kept, snippet: kept.map((c) => c.quote).join(" ") });
  }
  return [...hits, ...brought];
}

/**
 * The open disagreements the hits take part in, by hit. A statement on one side of a slot
 * whose values are in dispute names the statements among the hits that state its other
 * values; a passage names the statements of such a disagreement that quote its lines. Only
 * what the asker may see is in dispute (visible verdicts), so a hidden side marks nothing.
 */
export function disputesOf(hits: readonly SearchHit[], searched: Searched): Map<string, string[]> {
  const sides = hits.filter((h) => h.kind === "claim" && h.review_status === "disputed" && h.slot_key);
  const value = (h: SearchHit) => valueKeyOf(searched.statements.get(h.unit_id)?.claim ?? {});
  const out = new Map<string, string[]>();
  for (const h of sides) {
    const others = sides.filter((o) => o.slot_key === h.slot_key && value(o) !== value(h));
    if (others.length)
      out.set(
        h.unit_id,
        others.map((o) => o.unit_id),
      );
  }
  const quoting = new Map<string, string[]>();
  for (const h of sides) {
    if (!out.has(h.unit_id)) continue;
    for (const c of h.citations) quoting.set(c.span_id, [...(quoting.get(c.span_id) ?? []), h.unit_id]);
  }
  for (const h of hits) {
    if (h.kind !== "chunk") continue;
    const stated = [...new Set(h.citations.flatMap((c) => quoting.get(c.span_id) ?? []))];
    if (stated.length) out.set(h.unit_id, stated);
  }
  return out;
}

/** Each span of the passages found, with the best fused score of a passage that holds it. */
export function spanScores(found: readonly Found[]): Map<string, number> {
  const scores = new Map<string, number>();
  for (const f of found) for (const s of f.spans) scores.set(s.id, Math.max(scores.get(s.id) ?? 0, f.fused));
  return scores;
}

export function standingOf(claim: Claim, verdict: SlotVerdict | undefined): SearchHit["standing"] {
  if (!verdict) return undefined;
  const value = valueKeyOf(claim);
  return verdict.values.find((v) => v.value === value)?.standing;
}

export function freshnessOf(s: Staleness | undefined, now: string): FreshnessInfo {
  if (!s) return { state: "fresh", as_of: now };
  return {
    state: s.state,
    as_of: s.computed_at,
    staleness: s.score,
    ...(s.review_due && { review_due: s.review_due }),
  };
}

/** Notes on the slots an answer gives a value of: disputed slots, and outdated values found. */
export function notesOf(
  slots: ReadonlySet<string>,
  hits: readonly SearchHit[],
  searched: Searched,
  pack: ReturnType<typeof packFor>,
): AnswerNote[] {
  const notes: AnswerNote[] = [];
  const mark = pack.text("list_mark");
  for (const slot of [...slots].sort()) {
    const verdict = searched.verdicts.get(slot);
    if (!verdict) continue;
    const mine = hits.filter((h) => h.slot_key === slot);
    if (verdict.disputed) {
      const disputed = verdict.values.filter((v) => v.standing === "holds" || v.standing === "disputed");
      notes.push({
        kind: "conflict",
        text: fill(pack.text("conflict"), {
          values: disputed.map((v) => v.value).join(mark),
          held: verdict.held_value,
        }),
        unit_ids: [...new Set(disputed.flatMap((v) => v.claim_ids))],
        ...(verdict.held_value !== undefined && { held_value: verdict.held_value }),
        values: disputed.map((v) => v.value),
      });
    }
    const outdated = mine.filter((h) => h.standing === "outdated");
    if (outdated.length) {
      const old = [...new Set(outdated.map((h) => valueKeyOf(searched.statements.get(h.unit_id)?.claim ?? {}) ?? ""))];
      const documents = [...new Set(outdated.map((h) => h.title))];
      notes.push({
        kind: "outdated",
        text: fill(pack.text("outdated"), {
          documents: documents.join(mark),
          old: old.join(mark),
          held: verdict.held_value,
        }),
        unit_ids: [...outdated.map((h) => h.unit_id), ...(verdict.values[0]?.claim_ids ?? [])],
        ...(verdict.held_value !== undefined && { held_value: verdict.held_value }),
        values: old,
        documents,
      });
    }
  }
  return notes;
}
