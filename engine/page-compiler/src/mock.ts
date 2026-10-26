/**
 * The stand-in for a model on page-compiler.name_topics, registered as a model_mocks plugin
 * so the fake provider names topics deterministically.
 *
 * A topic is named after the heading most of its sections share, without numbering
 * ("Chapter 3", "1.2") or the FAQ frame ("Questions about ..."). The sections of one
 * document that share no heading are named after the document, those of several after what
 * their headings have in common ("Hotel rates" and "Hotel standards": "Hotel"), and a topic
 * without headings after the start of its first statement. An area, or a topic split into
 * subtopics, is named after what the titles below it share ("Travel lodging" and "Travel
 * allowances": "Travel"), and never like one of them ("Expenses" and "Expenses deadlines":
 * "Expenses in general"); an area whose topics share nothing takes its most frequent
 * document title, without the parts in brackets. A model will name what the sections share
 * rather than the commonest heading, and will not repeat a sibling's title.
 *
 * Names and summaries are written in the language the request names, with the words of its
 * pack in languages/, or else in the language of the topic's headings and titles. Han and
 * kana share names character by character, languages that separate words with spaces word
 * by word.
 */

import type { ChatMessage } from "@inspiration/contracts";
import { languageOf } from "@inspiration/kernel";
import type { MockResponder } from "@inspiration/model-gateway";
import { cleanHeading, PACKS } from "./headings.ts";
import { type NamedTopic, nameInputOf, type TopicInput } from "./protocol.ts";

const BRACKETS = PACKS.flatMap((p) => p.list("brackets").map((source) => new RegExp(source, "giu")));

/** How a language names topics. */
interface Naming {
  spaced: boolean;
  related: string;
  untitled: string;
  summary: string;
  summaryFrom: string;
  listMark: string;
  titleLength: number;
  sharedLength: number;
}

const NAMING = new Map<string, Naming>(
  PACKS.map((p) => [
    p.tag,
    {
      spaced: p.flag("spaced"),
      related: p.text("related"),
      untitled: p.text("untitled"),
      summary: p.text("summary"),
      summaryFrom: p.text("summary_from"),
      listMark: p.text("list_mark"),
      titleLength: p.number("title_length"),
      sharedLength: p.number("shared_length"),
    },
  ]),
);

const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? "");

/** The longest text both contain. */
function sharedChars(a: string, b: string): string {
  let best = "";
  for (let i = 0; i < a.length; i++) {
    for (let j = i + best.length + 1; j <= a.length && b.includes(a.slice(i, j)); j++) best = a.slice(i, j);
  }
  return best;
}

/** The longest run of words both contain, in any case. */
function sharedWords(a: string, b: string): string {
  const [x, y] = [a, b].map((t) => t.split(/\s+/).filter(Boolean)) as [string[], string[]];
  let best: string[] = [];
  for (let i = 0; i < x.length; i++) {
    for (let j = 0; j < y.length; j++) {
      let n = 0;
      while (i + n < x.length && j + n < y.length && x[i + n]?.toLowerCase() === y[j + n]?.toLowerCase()) n++;
      if (n > best.length) best = x.slice(i, i + n);
    }
  }
  return best.join(" ");
}

/** What all the texts share, when it is long enough to be a name. */
function common(texts: readonly string[], naming: Naming): string | undefined {
  const [first, ...rest] = texts;
  const shared = naming.spaced ? sharedWords : sharedChars;
  const found = first === undefined ? "" : rest.reduce(shared, first).trim();
  const size = naming.spaced ? found.split(/\s+/).filter(Boolean).length : found.length;
  return size >= naming.sharedLength ? found : undefined;
}

function fromHeadings(topic: TopicInput, documents: readonly string[], naming: Naming): string | undefined {
  const counts = new Map<string, number>();
  for (const h of topic.headings) {
    const text = cleanHeading(h.text);
    if (text) counts.set(text, (counts.get(text) ?? 0) + h.sections);
  }
  const ranked = [...counts].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1));
  const [top] = ranked;
  if (top && (top[1] > 1 || ranked.length === 1)) return top[0];
  if (documents.length === 1) return documents[0];
  // Headings of several documents, none shared: what they have in common.
  const texts = ranked.map(([text]) => text);
  return common(texts, naming) ?? top?.[0];
}

function nameOf(topic: TopicInput, language: string): NamedTopic {
  const below = topic.topics ?? [];
  const written = [...topic.headings.map((h) => h.text), ...topic.documents, ...below, ...topic.statements.slice(0, 1)];
  const naming = (NAMING.get(language.split("-")[0]?.toLowerCase() ?? "") ??
    NAMING.get(languageOf(written.join("\n"))) ??
    NAMING.get("en")) as Naming;
  const documents = topic.documents.map((d) => BRACKETS.reduce((t, b) => t.replace(b, ""), d).trim()).filter(Boolean);
  let title = common(below, naming) ?? (topic.level === 1 ? documents[0] : fromHeadings(topic, documents, naming));
  if (title !== undefined && below.includes(title)) title = fill(naming.related, { title });
  title = (title ?? topic.statements[0] ?? naming.untitled).slice(0, naming.titleLength);
  const from = documents.slice(0, 2).join(naming.listMark);
  return {
    ref: topic.ref,
    title,
    summary: from ? fill(naming.summaryFrom, { title, documents: from }) : fill(naming.summary, { title }),
  };
}

export const mockNameTopics: MockResponder = (messages: readonly ChatMessage[]) => {
  const input = nameInputOf(messages.map((m) => m.content).join("\n"));
  return JSON.stringify({ topics: input ? input.topics.map((t) => nameOf(t, input.language)) : [] });
};
