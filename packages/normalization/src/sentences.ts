/**
 * Splitting a block's text into citable passages. A passage is a sentence or, in Chinese
 * regulations, a clause ended by a full-width semicolon, since those enumerate the separate
 * rules of one article. Offsets are JavaScript string indices into the block text.
 *
 * What ends a sentence, what closes one and where a long one may be cut come from the
 * language packs in languages/, all of them at once (see the kernel's languages.ts).
 */

import { loadLanguages } from "@inspiration/kernel";

export interface Passage {
  start: number;
  end: number;
  text: string;
}

/** Longest passage, in UTF-16 units, before it is cut at a comma. */
export const MAX_PASSAGE = 400;
/** Pieces shorter than this, such as a list number standing alone, join the next passage. */
const MIN_PASSAGE = 4;

const PACKS = loadLanguages(new URL("../languages/", import.meta.url).pathname);
const all = (key: string) => new Set(PACKS.flatMap((p) => p.list(key)));

const TERMINATORS = all("terminators");
const CLOSERS = all("closers");
const COMMAS = all("commas");
/** Full stops, which end a sentence only where endsSentence says so. */
const FULL_STOPS = all("full_stops");
const ABBREVIATIONS = all("abbreviations");

function isSpace(c: string | undefined): boolean {
  return c !== undefined && /\s/.test(c);
}

/**
 * A full stop ends a sentence where a space follows it and its closing quotes, unless it ends
 * a common abbreviation or a lowercase word follows ("2.1", "e.g. in", "said." Then").
 */
function endsSentence(text: string, i: number): boolean {
  let j = i + 1;
  while (j < text.length && CLOSERS.has(text[j] as string)) j++;
  if (j < text.length && !isSpace(text[j])) return false;
  const word = /[A-Za-z.]+$/.exec(text.slice(Math.max(0, i - 8), i))?.[0].toLowerCase() ?? "";
  if (ABBREVIATIONS.has(word)) return false;
  while (j < text.length && isSpace(text[j])) j++;
  return j === text.length || !/[a-z]/.test(text[j] as string);
}

/** End offsets of sentences: after a terminator and its closing quotes, or at a line break. */
function boundaries(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    const terminal = TERMINATORS.has(c) || (FULL_STOPS.has(c) && endsSentence(text, i));
    if (terminal) {
      let end = i + 1;
      while (end < text.length && (TERMINATORS.has(text[end] as string) || CLOSERS.has(text[end] as string))) end++;
      out.push(end);
      i = end - 1;
    } else if (c === "\n") out.push(i + 1);
  }
  if (out.at(-1) !== text.length) out.push(text.length);
  return out;
}

function trimmed(text: string, start: number, end: number): Passage | undefined {
  while (start < end && isSpace(text[start])) start++;
  while (end > start && isSpace(text[end - 1])) end--;
  return start < end ? { start, end, text: text.slice(start, end) } : undefined;
}

/** Cut an over-long passage at the last comma before the limit, else at the limit. */
function cut(text: string, p: Passage): Passage[] {
  const out: Passage[] = [];
  let start = p.start;
  while (p.end - start > MAX_PASSAGE) {
    let at = -1;
    for (let i = start + MAX_PASSAGE; i > start + MAX_PASSAGE / 2; i--) {
      if (COMMAS.has(text[i - 1] as string)) {
        at = i;
        break;
      }
    }
    if (at < 0) at = start + MAX_PASSAGE;
    const piece = trimmed(text, start, at);
    if (piece) out.push(piece);
    start = at;
  }
  const rest = trimmed(text, start, p.end);
  if (rest) out.push(rest);
  return out;
}

/** The passages of a block's text, in order, covering every non-space character. */
export function passages(text: string): Passage[] {
  const pieces: Passage[] = [];
  let start = 0;
  for (const end of boundaries(text)) {
    const p = trimmed(text, start, end);
    start = end;
    if (!p) continue;
    const last = pieces.at(-1);
    // A fragment too short to cite on its own joins its neighbour.
    if (last && last.end - last.start < MIN_PASSAGE) pieces[pieces.length - 1] = merge(text, last, p);
    else pieces.push(p);
  }
  const last = pieces.at(-1);
  const before = pieces.at(-2);
  if (last && before && last.end - last.start < MIN_PASSAGE) pieces.splice(-2, 2, merge(text, before, last));
  return pieces.flatMap((p) => cut(text, p));
}

function merge(text: string, a: Passage, b: Passage): Passage {
  return { start: a.start, end: b.end, text: text.slice(a.start, b.end) };
}
