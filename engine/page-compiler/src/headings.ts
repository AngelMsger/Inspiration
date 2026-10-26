/**
 * Headings without their numbering ("Chapter 3", "1.2", "(a)") or a FAQ frame ("Questions
 * about ..."), which say where a section is, not what it is about. Sections are embedded and
 * topics named by what is left. The patterns of each language come from the packs in
 * languages/, all of them at once.
 */

import { loadLanguages } from "@inspiration/kernel";

export const PACKS = loadLanguages(new URL("../languages/", import.meta.url));

const patterns = (key: string) => PACKS.flatMap((p) => p.list(key).map((source) => new RegExp(source, "iu")));

const NUMBERING = patterns("numbering").map((p) => new RegExp(`^(?:${p.source})`, "iu"));
const FAQ = patterns("faq");

/** The heading without its numbering or FAQ frame; the heading itself when nothing is left. */
export function cleanHeading(text: string): string {
  // The longest numbering any pack sees, so that a number and an ideographic comma is not read
  // as the number alone by a pack without that comma.
  const numbering = NUMBERING.reduce((n, p) => Math.max(n, p.exec(text)?.[0].length ?? 0), 0);
  const bare = text.slice(numbering).trim();
  const about = FAQ.map((p) => p.exec(bare)?.[1]).find((t) => t !== undefined);
  return (about ?? bare).trim() || text.trim();
}
