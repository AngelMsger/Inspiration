/**
 * Write rules every KnowledgeStore implementation enforces, so the in-memory store used in
 * component tests rejects exactly what Postgres rejects.
 */

import {
  type Chunk,
  type Claim,
  type ClaimDerivation,
  type ClaimEvidence,
  contentHash,
  type PageSnapshot,
  type SourceVersion,
  type Span,
} from "@inspiration/contracts";

/** A write that breaks a knowledge-store rule. The whole transaction is rolled back. */
export class IntegrityError extends Error {
  override name = "IntegrityError";
}

export function checkSourceVersion(version: SourceVersion, spans: readonly Span[]): void {
  for (const s of spans) {
    if (s.source_version_id !== version.id) {
      throw new IntegrityError(`span ${s.id} belongs to ${s.source_version_id}, not ${version.id}`);
    }
    if (s.tenant_id !== version.tenant_id) {
      throw new IntegrityError(`span ${s.id} has tenant ${s.tenant_id}, the version has ${version.tenant_id}`);
    }
    if (s.text_hash !== contentHash(s.text))
      throw new IntegrityError(`span ${s.id}: text_hash does not match its text`);
  }
}

export function checkEmbeddings(
  embeddings: Readonly<Record<string, readonly number[]>>,
  model: string | undefined,
): void {
  const vectors = Object.values(embeddings);
  if (!vectors.length) return;
  if (!model) throw new IntegrityError("embeddings need the embedding model name");
  const sizes = new Set(vectors.map((v) => v.length));
  if (sizes.size !== 1 || sizes.has(0))
    throw new IntegrityError("embeddings in one write must share one non-zero size");
}

export function checkChunks(
  chunks: readonly Chunk[],
  versions: ReadonlySet<string>,
  embeddings: Readonly<Record<string, readonly number[]>> | undefined,
  model: string | undefined,
): void {
  for (const c of chunks) {
    if (!versions.has(c.source_version_id)) {
      throw new IntegrityError(`chunk ${c.id} cites unknown source version ${c.source_version_id}`);
    }
  }
  if (!embeddings) return;
  checkEmbeddings(embeddings, model);
  const ids = new Set(chunks.map((c) => c.id));
  const unknown = Object.keys(embeddings)
    .filter((id) => !ids.has(id))
    .sort();
  if (unknown.length) throw new IntegrityError(`embeddings for chunks not in this write: ${unknown.join(", ")}`);
}

export function checkEvidence(ev: ClaimEvidence, span: Span | undefined): void {
  if (!span) throw new IntegrityError(`evidence for ${ev.claim_id} cites unknown span ${ev.span_id}`);
  if (span.source_version_id !== ev.source_version_id) {
    throw new IntegrityError(`span ${span.id} belongs to ${span.source_version_id}, not ${ev.source_version_id}`);
  }
  if (!span.text.includes(ev.quote)) {
    throw new IntegrityError(`evidence for ${ev.claim_id}: the quote is not in span ${span.id}`);
  }
  if (
    (ev.quote_start !== undefined || ev.quote_end !== undefined) &&
    span.text.slice(ev.quote_start ?? 0, ev.quote_end) !== ev.quote
  ) {
    throw new IntegrityError(`evidence for ${ev.claim_id}: quote offsets do not match span ${span.id}`);
  }
}

/**
 * existing: IDs of stored claims among those referenced. alreadySupported: stored claims in
 * this batch that already have supporting evidence or a derivation.
 */
export function checkClaims(
  claims: readonly Claim[],
  evidence: readonly ClaimEvidence[],
  derivations: readonly ClaimDerivation[],
  options: { existing: ReadonlySet<string>; alreadySupported: ReadonlySet<string> },
): void {
  const batch = new Set(claims.map((c) => c.id));
  if (batch.size !== claims.length) throw new IntegrityError("duplicate claim IDs in one write");
  const known = (id: string) => batch.has(id) || options.existing.has(id);
  for (const e of evidence) {
    if (!known(e.claim_id)) throw new IntegrityError(`evidence for unknown claim ${e.claim_id}`);
  }
  for (const d of derivations) {
    if (!known(d.claim_id)) throw new IntegrityError(`derivation for unknown claim ${d.claim_id}`);
    if (d.from_claim_ids.includes(d.claim_id)) {
      throw new IntegrityError(`claim ${d.claim_id} cannot be derived from itself`);
    }
    const missing = d.from_claim_ids.filter((f) => !known(f));
    if (missing.length) {
      throw new IntegrityError(`claim ${d.claim_id} is derived from unknown claims ${missing.join(", ")}`);
    }
  }
  const supported = new Set([
    ...evidence.filter((e) => e.role === "supports").map((e) => e.claim_id),
    ...derivations.map((d) => d.claim_id),
    ...options.alreadySupported,
  ]);
  for (const c of claims) {
    if (!supported.has(c.id)) throw new IntegrityError(`claim ${c.id} has no supporting evidence or derivation`);
    const { start, end } = c.valid_time;
    if (start && end && Date.parse(end) <= Date.parse(start)) {
      throw new IntegrityError(`claim ${c.id}: valid_time ends before it starts`);
    }
  }
}

export function checkSupersede(
  claim: Claim | undefined,
  by: Claim | undefined,
  claimId: string,
  byId: string,
): asserts claim is Claim {
  if (!claim) throw new IntegrityError(`unknown claim ${claimId}`);
  if (!by) throw new IntegrityError(`unknown superseding claim ${byId}`);
  if (claimId === byId) throw new IntegrityError("a claim cannot supersede itself");
  if (claim.superseded_at !== undefined) {
    throw new IntegrityError(`claim ${claimId} is already superseded by ${claim.superseded_by}`);
  }
}

export function checkPageSnapshot(snapshot: PageSnapshot, latest: number | undefined): void {
  const expected = (latest ?? 0) + 1;
  if (snapshot.version !== expected) {
    throw new IntegrityError(`page ${snapshot.page_id}: next version is ${expected}, got ${snapshot.version}`);
  }
  if (snapshot.spec.page_id !== snapshot.page_id || snapshot.spec.version !== snapshot.version) {
    throw new IntegrityError("the snapshot's spec must carry the same page_id and version");
  }
}
