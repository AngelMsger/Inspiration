import { createHash } from "node:crypto";
import {
  type Claim,
  type ClaimEvidence,
  contentHash,
  type KnowledgeStore,
  levelOf,
  type ModelGateway,
  type SensitivityLabel,
  type SourceBlock,
  type SourceVersion,
  slotOf,
} from "@inspiration/contracts";
import { cleanHeading } from "./headings.ts";
import { batched, COMPONENT, documentOf, entry, normalized, recordKey, type Section } from "./records.ts";

/** Characters of a section's text that go into its embedding. */
export const EMBED_CHARS = 1000;
/** Texts per embedding call. */
const EMBED_BATCH = 64;

const RETIRED = new Set(["archived", "retired"]);
const LIVE_STATUSES = new Set(["active", "verified", "disputed"]);

export interface BuiltSection {
  section: Section;
  /** For clustered sections: the deepest heading, and the text the embedding is made from. */
  heading?: string;
  text?: string;
}

interface BlockGroup {
  path: string[];
  blocks: SourceBlock[];
}

function groupBlocks(blocks: readonly SourceBlock[], title: string) {
  const groups = new Map<string, BlockGroup>();
  const rank = new Map<string, number>();
  const groupOf = new Map<string, string>();
  for (const b of blocks) {
    const path = b.heading_path?.length ? b.heading_path : [title];
    const k = JSON.stringify(path);
    entry(groups, k, () => ({ path, blocks: [] as SourceBlock[] })).blocks.push(b);
    for (const s of b.span_ids) {
      rank.set(s, rank.size);
      groupOf.set(s, k);
    }
  }
  return { groups, rank, groupOf };
}

function claimsByGroup(
  claims: readonly Claim[],
  evidence: readonly ClaimEvidence[],
  rank: ReadonlyMap<string, number>,
  groupOf: ReadonlyMap<string, string>,
): Map<string, Claim[]> {
  const first = new Map<string, number>();
  for (const e of evidence) {
    const r = rank.get(e.span_id);
    if (e.role === "supports" && r !== undefined && r < (first.get(e.claim_id) ?? Number.POSITIVE_INFINITY)) {
      first.set(e.claim_id, r);
    }
  }
  const byGroup = new Map<string, Claim[]>();
  const inOrder = claims
    .filter((c) => first.has(c.id))
    .sort((a, b) => (first.get(a.id) as number) - (first.get(b.id) as number));
  const spanAt = [...rank.keys()];
  for (const c of inOrder) {
    const g = groupOf.get(spanAt[first.get(c.id) as number] as string) as string;
    byGroup.set(g, [...(byGroup.get(g) ?? []), c]);
  }
  return byGroup;
}

/**
 * A version's sections: its blocks grouped by heading path, each with the current claims
 * that rest on its spans (a claim citing several sections belongs to the first). Search-only
 * and deleted versions have none, and neither has a section without current claims.
 */
export async function sectionsOf(store: KnowledgeStore, version: SourceVersion): Promise<BuiltSection[]> {
  const level = levelOf(version);
  if (version.deleted || level === "search_only") return [];
  const title = version.title ?? version.external_id;
  // Headings are read as the paths of the blocks under them; a table is read as its rows.
  const blocks = (await store.blocksOf(version.id))
    .filter((b) => b.kind !== "heading" && b.kind !== "table" && b.span_ids.length)
    .sort((a, b) => a.ordinal - b.ordinal);
  if (!blocks.length) return [];
  const spanIds = blocks.flatMap((b) => b.span_ids);
  const claims = (await batched(await store.claimsCiting(spanIds), (ids) => store.getClaims(ids))).filter(
    (c) => c.superseded_at === undefined && LIVE_STATUSES.has(c.status),
  );
  if (!claims.length) return [];
  const evidence = await batched(
    claims.map((c) => c.id),
    (ids) => store.evidenceOf(ids),
  );

  const { groups, rank, groupOf } = groupBlocks(blocks, title);
  const byGroup = claimsByGroup(claims, evidence, rank, groupOf);
  const archived = RETIRED.has(version.approval_state);
  const texts =
    level === "governed" && !archived ? new Map((await store.getSpans(spanIds)).map((s) => [s.id, s.text])) : undefined;
  const document = documentOf(version);
  const out: BuiltSection[] = [];
  for (const [k, g] of groups) {
    const stated = byGroup.get(k);
    if (!stated?.length) continue;
    const section: Section = {
      key: `s-${createHash("sha256")
        .update(recordKey(version.tenant_id, document, ...g.path))
        .digest("hex")
        .slice(0, 24)}`,
      tenant_id: version.tenant_id,
      space_id: version.space_id,
      document,
      source_version_id: version.id,
      title,
      heading_path: g.path,
      level,
      sensitivity: version.sensitivity,
      claims: stated.map((c) => {
        const slot = slotOf(c);
        return slot ? { id: c.id, slot } : { id: c.id };
      }),
    };
    if (archived) section.archived = true;
    if (version.language) section.language = version.language;
    if (!texts) {
      out.push({ section });
      continue;
    }
    const heading = cleanHeading(g.path.at(-1) as string);
    const body = g.blocks.flatMap((b) => b.span_ids.map((id) => texts.get(id) ?? "")).join("\n");
    const text = `${g.path.map(cleanHeading).join(" / ")}\n${body}`.slice(0, EMBED_CHARS);
    section.text_hash = contentHash(`${heading}\x1f${text}`);
    out.push({ section, heading, text });
  }
  return out;
}

/**
 * One vector per section: its heading's embedding plus its text's, normalized, so sections
 * under the same heading stay together even when their passages differ.
 */
export async function embedSections(
  models: ModelGateway,
  tenantId: string,
  spaceId: string,
  sensitivity: SensitivityLabel,
  built: readonly BuiltSection[],
  totals: { embedded: number; embed_calls: number },
): Promise<Float32Array[]> {
  const texts = built.flatMap((b) => [b.heading as string, b.text as string]);
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH) as [string, ...string[]];
    const result = await models.embed({
      texts: batch,
      input_type: "document",
      sensitivity,
      budget_key: `tenant:${tenantId}/${COMPONENT}`,
      tenant_id: tenantId,
      space_id: spaceId,
    });
    vectors.push(...result.vectors);
    totals.embed_calls++;
  }
  totals.embedded += built.length;
  return built.map((_, i) => {
    const heading = vectors[2 * i] as number[];
    const text = vectors[2 * i + 1] as number[];
    return normalized(Float32Array.from(heading, (x, j) => x + (text[j] as number)));
  });
}
