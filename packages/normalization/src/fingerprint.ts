/**
 * Document fingerprints for duplicate detection. Exact duplicates share the hash of their
 * normalized text; near duplicates (a copy with a changed date, a reformatted export) have
 * 64-bit SimHashes over character 4-grams within a few bits of each other. Eight 8-bit
 * bands index the SimHash, so candidates are the documents sharing at least one band: two
 * hashes within seven bits always do. Unrelated texts differ in about 32 bits.
 *
 * Short texts move many bits for one edit (a changed number in a 100-character notice
 * moves about 7), so only documents of MIN_NEAR_TEXT or more are compared for near
 * duplicates; shorter ones only for exact ones.
 */

import { contentHash } from "@inspiration/contracts";

/** Documents with less normalized text than this are never reported as duplicates. */
export const MIN_TEXT = 40;
/** Documents with less normalized text than this are only reported as exact duplicates. */
export const MIN_NEAR_TEXT = 200;
/** Largest Hamming distance between SimHashes of near duplicates. */
export const NEAR = 6;
const SHINGLE = 4;
const BANDS = 8;

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

/** Band keys of a SimHash: "<band>:<2 hex digits>". */
export function bands(simhash: string): string[] {
  const width = simhash.length / BANDS;
  return Array.from({ length: BANDS }, (_, i) => `${i}:${simhash.slice(i * width, (i + 1) * width)}`);
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
