/**
 * Document fingerprints for duplicate detection. Exact duplicates share the hash of their
 * normalized text; near duplicates (a copy with a changed date, an older version kept in an
 * archive, a reformatted export) have 64-bit SimHashes over character 4-grams within a few
 * bits of each other, where unrelated texts differ in about 32.
 *
 * The index stores four 16-bit bands per document. A lookup probes every band value within
 * two bits of the document's own (137 per band), so it finds every stored hash within 11
 * bits: some band then differs in at most two. Candidates are verified by full distance.
 *
 * Short texts move many bits for one edit (a changed number in a 100-character notice
 * moves about 7), so only documents of MIN_NEAR_TEXT or more are compared for near
 * duplicates; shorter ones only for exact ones.
 *
 * Documents written from one template (weekly reports, meeting minutes) also come close in
 * SimHash while saying different things, so a near candidate is confirmed by its sentences:
 * the share of the two texts in sentences both contain (sharedText) must reach NEAR_SHARE.
 * An older edition with a few changed figures shares nine tenths; two weekly reports of
 * one template share their headings, which have no spans, and little else.
 */

import { contentHash } from "@inspiration/contracts";

/** Documents with less normalized text than this are never reported as duplicates. */
export const MIN_TEXT = 40;
/** Documents with less normalized text than this are only reported as exact duplicates. */
export const MIN_NEAR_TEXT = 200;
/**
 * Largest Hamming distance between SimHashes of near duplicates. A 650-character policy and
 * its previous edition with five changed figures are 9 apart; two unrelated texts fall
 * within 9 bits with a chance of about 2 in a billion.
 */
export const NEAR = 9;
/** Share of text in common sentences at which a SimHash candidate is a near duplicate. */
export const NEAR_SHARE = 0.6;
const SHINGLE = 4;
const BANDS = 4;
const BAND_BITS = 16;

export interface Fingerprint {
  /** Hash of the normalized text. */
  text_hash: string;
  /** 16 hex digits. */
  simhash: string;
  /** Normalized length, in code points. */
  length: number;
}

/** Text without whitespace, punctuation, symbols or case, so formatting does not count. */
export function normalizedText(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

/** FNV-1a over a string's UTF-16 units, with a seed, as an unsigned 32-bit number. */
function fnv(text: string, seed: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // A final mix, since FNV's high bits are weak for short inputs.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  return h >>> 0;
}

export function fingerprint(text: string): Fingerprint {
  const norm = normalizedText(text);
  const chars = [...norm];
  const weights = new Int32Array(64);
  const add = (shingle: string) => {
    const halves = [fnv(shingle, 0), fnv(shingle, 0x9e3779b9)];
    for (let half = 0; half < 2; half++) {
      const h = halves[half] as number;
      for (let bit = 0; bit < 32; bit++) {
        const at = half * 32 + bit;
        weights[at] = (weights[at] as number) + ((h >>> bit) & 1 ? 1 : -1);
      }
    }
  };
  if (chars.length < SHINGLE) add(norm);
  else for (let i = 0; i + SHINGLE <= chars.length; i++) add(chars.slice(i, i + SHINGLE).join(""));
  let hex = "";
  for (let half = 1; half >= 0; half--) {
    let word = 0;
    for (let bit = 31; bit >= 0; bit--) word = (word << 1) | ((weights[half * 32 + bit] as number) > 0 ? 1 : 0);
    hex += (word >>> 0).toString(16).padStart(8, "0");
  }
  return { text_hash: contentHash(norm), simhash: hex, length: chars.length };
}

const bandKey = (band: number, value: number) => `${band}:${value.toString(16).padStart(BAND_BITS / 4, "0")}`;

/** The band keys a document is stored under: "<band>:<4 hex digits>". */
export function bands(simhash: string): string[] {
  const width = BAND_BITS / 4;
  return Array.from({ length: BANDS }, (_, i) =>
    bandKey(i, Number.parseInt(simhash.slice(i * width, (i + 1) * width), 16)),
  );
}

/**
 * The band keys to look up for a document: each of its bands with up to two bits flipped. Two
 * hashes within 11 bits differ by at most two in some band, so they always share a key.
 */
export function probes(simhash: string): string[] {
  const out: string[] = [];
  const width = BAND_BITS / 4;
  for (let i = 0; i < BANDS; i++) {
    const v = Number.parseInt(simhash.slice(i * width, (i + 1) * width), 16);
    out.push(bandKey(i, v));
    for (let a = 0; a < BAND_BITS; a++) {
      out.push(bandKey(i, v ^ (1 << a)));
      for (let b = a + 1; b < BAND_BITS; b++) out.push(bandKey(i, v ^ (1 << a) ^ (1 << b)));
    }
  }
  return out;
}

export function hamming(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < a.length; i += 8) {
    let x = (Number.parseInt(a.slice(i, i + 8), 16) ^ Number.parseInt(b.slice(i, i + 8), 16)) >>> 0;
    while (x) {
      x &= x - 1;
      d++;
    }
  }
  return d;
}

/**
 * Dice share of two documents' text that sits in sentences both contain, weighted by
 * length and compared after normalizedText: 1 for the same sentences, 0 for none in common.
 */
export function sharedText(a: readonly { text: string }[], b: readonly { text: string }[]): number {
  const count = (spans: readonly { text: string }[]) => {
    const out = new Map<string, number>();
    for (const s of spans) {
      const t = normalizedText(s.text);
      if (t) out.set(t, (out.get(t) ?? 0) + 1);
    }
    return out;
  };
  const x = count(a);
  const y = count(b);
  let total = 0;
  let shared = 0;
  for (const [t, n] of x) total += n * t.length;
  for (const [t, n] of y) {
    total += n * t.length;
    shared += Math.min(n, x.get(t) ?? 0) * t.length;
  }
  return total ? (2 * shared) / total : 0;
}
