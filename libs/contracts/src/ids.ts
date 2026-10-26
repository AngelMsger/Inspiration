/** Identifier and hash helpers shared by every component. */

import { createHash, getRandomValues } from "node:crypto";
import type { Version } from "./generated.ts";

/** Prefix of every ID kind, as used in schema/common.yaml. */
export const PREFIXES = {
  tenant: "ten",
  space: "spc",
  source: "src",
  source_version: "sv",
  source_block: "blk",
  span: "spn",
  chunk: "chk",
  claim: "clm",
  entity: "ent",
  relation: "rel",
  sop: "sop",
  knowledge_model: "kmd",
  page: "pg",
  comment: "cmt",
  override: "ovr",
  proposal: "prp",
  todo: "todo",
  conflict: "cfl",
  publish_request: "pub",
  view: "view",
  event: "evt",
  run: "run",
  request: "req",
  member: "mem",
  group: "grp",
  department: "dep",
  agent: "agt",
  service: "svc",
} as const;

export type IdKind = keyof typeof PREFIXES;

const KIND_OF_PREFIX = new Map<string, IdKind>(
  Object.entries(PREFIXES).map(([kind, prefix]) => [prefix, kind as IdKind]),
);
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ID = /^(?<prefix>[a-z]+)_(?<suffix>[0-9A-Za-z]{8,64})$/;

/** A 26-character ULID: 48-bit millisecond timestamp plus 80 random bits. */
export function ulid(timestampMs: number = Date.now()): string {
  let value = BigInt(timestampMs);
  for (const byte of getRandomValues(new Uint8Array(10))) value = (value << 8n) | BigInt(byte);
  const chars: string[] = [];
  for (let i = 0; i < 26; i++) {
    chars.push(CROCKFORD[Number(value % 32n)] as string);
    value /= 32n;
  }
  return chars.reverse().join("");
}

/** New time-ordered ID for a kind, for example newId("claim") -> "clm_01J...". */
export function newId(kind: IdKind): string {
  return `${PREFIXES[kind]}_${ulid()}`;
}

/** Deterministic ID derived from content, for units that must keep their ID across rebuilds. */
export function stableId(kind: IdKind, ...parts: string[]): string {
  const digest = createHash("sha256").update(parts.join("\x1f"), "utf8").digest("hex").slice(0, 32);
  return `${PREFIXES[kind]}_${digest}`;
}

/** The kind of an ID ("claim" for "clm_..."). Throws for malformed IDs. */
export function kindOf(id: string): IdKind {
  const prefix = ID.exec(id)?.groups?.prefix;
  const kind = prefix === undefined ? undefined : KIND_OF_PREFIX.get(prefix);
  if (kind === undefined) throw new RangeError(`not an Inspiration ID: ${JSON.stringify(id)}`);
  return kind;
}

/** ContentHash of bytes or UTF-8 text: "sha256:<hex>". */
export function contentHash(data: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

/** Order-sensitive hash of other hashes and version strings (for inputs_hash). */
export function combineHashes(...parts: string[]): string {
  return contentHash(parts.join("\x1f"));
}

/**
 * Whether two versions of a source item are the same: equal content, metadata and ACL
 * hashes, or, when either side has no content hash, an equal source revision.
 */
export function sameVersion(a: Version | undefined, b: Version | undefined): boolean {
  if (!a || !b) return false;
  if (a.content_hash && b.content_hash) {
    return a.content_hash === b.content_hash && a.metadata_hash === b.metadata_hash && a.acl_hash === b.acl_hash;
  }
  return a.external_version !== undefined && a.external_version === b.external_version;
}
