/**
 * The words retrieval compares a question with: words of scripts that separate them, and
 * single characters and pairs of Han and kana, lower-cased, without the packs' stopwords.
 * It picks snippets and orders statements before the reranker sees them; it ranks nothing
 * on its own.
 */

import { type LanguagePack, loadLanguages } from "@inspiration/kernel";

export const PACKS: readonly LanguagePack[] = loadLanguages(new URL("../languages/", import.meta.url));
export const PACK_OF = new Map(PACKS.map((p) => [p.tag, p]));

const STOPWORDS = new Set(PACKS.flatMap((p) => p.list("stopwords")).map((w) => w.toLowerCase()));
const STEMS = PACKS.flatMap((p) => (p.text("stem") ? [new RegExp(p.text("stem"), "u")] : []));
const CJK = "\\p{scx=Han}\\p{scx=Hiragana}\\p{scx=Katakana}";
/** A letter or digit of a script that separates words. */
const NARROW = `(?:(?![${CJK}])[\\p{L}\\p{N}])`;
/** A run of Han and kana, or a word or number ("5,000", "1.25"). */
const RUN = new RegExp(`[${CJK}]+|${NARROW}(?:(?:${NARROW}|[.,](?=${NARROW}))*)`, "gu");
const WIDE = new RegExp(`^[${CJK}]`, "u");

export function terms(text: string): Set<string> {
  const out = new Set<string>();
  for (const run of text.toLowerCase().match(RUN) ?? []) {
    if (!WIDE.test(run)) {
      const word = run.replace(/,/g, "");
      // A letter alone ("a", "I") says nothing; a digit alone may be the answer.
      if (STOPWORDS.has(word) || (word.length < 2 && !/\d/.test(word))) continue;
      out.add(STEMS.reduce((w, stem) => w.replace(stem, ""), word));
      continue;
    }
    const chars = [...run];
    chars.forEach((c, i) => {
      if (!STOPWORDS.has(c)) out.add(c);
      const pair = c + (chars[i + 1] ?? "");
      if (i + 1 < chars.length && !STOPWORDS.has(pair)) out.add(pair);
    });
  }
  return out;
}

/** The share of the question's words the text has, from 0 to 1. */
export function overlap(question: ReadonlySet<string>, text: string): number {
  if (!question.size) return 0;
  const have = terms(text);
  let n = 0;
  for (const t of question) if (have.has(t)) n++;
  return n / question.size;
}

export const fill = (template: string, values: Readonly<Record<string, string>>): string =>
  template.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? "");

/** The pack for a language tag ("zh-CN" takes zh), English when there is none. */
export function packFor(language: string | undefined): LanguagePack {
  const base = language?.split("-")[0]?.toLowerCase() ?? "";
  return (PACK_OF.get(base) ?? PACK_OF.get("en")) as LanguagePack;
}
