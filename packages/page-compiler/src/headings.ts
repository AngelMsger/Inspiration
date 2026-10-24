/**
 * Headings without their numbering ("第三章", "一、", "1.2") or a FAQ frame ("关于…的问题"),
 * which say where a section is, not what it is about. Sections are embedded and topics named
 * by what is left.
 */

const NUMBERING =
  /^(第[一二三四五六七八九十百零\d]+[章节条部分篇]|[一二三四五六七八九十]+[、.]|[（(][一二三四五六七八九十\d]+[）)]|\d+(\.\d+)*[.、]?)\s*/;
const FAQ = /^关于(.+)的问题$/;

/** The heading without its numbering or FAQ frame; the heading itself when nothing is left. */
export function cleanHeading(text: string): string {
  const bare = text.replace(NUMBERING, "").trim();
  return (FAQ.exec(bare)?.[1] ?? bare).trim() || text.trim();
}
