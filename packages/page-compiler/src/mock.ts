/**
 * The stand-in for a model on page-compiler.name_topics, registered as a model_mocks plugin
 * so the fake provider names topics deterministically.
 *
 * A topic is named after the heading most of its sections share, without numbering ("第三章",
 * "一、", "1.2") or the FAQ frame ("关于…的问题"). The sections of one document that share
 * no heading are named after the document, those of several after what their headings have
 * in common ("住宿费" and "住宿标准": "住宿"), and a topic without headings after the start
 * of its first statement. An area, or a topic split into subtopics, is named after what the
 * titles below it share, two characters or more ("差旅住宿" and "差旅补助": "差旅"), and
 * never like one of them ("报销" and "报销时限": "报销相关"); an area whose topics share
 * nothing takes its most frequent document title, without the parts in brackets. A model
 * will name what the sections share rather than the commonest heading, and will not repeat
 * a sibling's title.
 */

import type { ChatMessage } from "@inspiration/contracts";
import type { MockResponder } from "@inspiration/model-gateway";
import { cleanHeading } from "./headings.ts";
import { type NamedTopic, nameInputOf, type TopicInput } from "./protocol.ts";

const BRACKETS = /[（(][^）)]*[）)]/g;
const TITLE_CHARS = 16;

/** The longest text both contain. */
function shared(a: string, b: string): string {
  let best = "";
  for (let i = 0; i < a.length; i++) {
    for (let j = i + best.length + 1; j <= a.length && b.includes(a.slice(i, j)); j++) best = a.slice(i, j);
  }
  return best;
}

/** What all the texts share, when it is two characters or more. */
function common(texts: readonly string[]): string | undefined {
  const [first, ...rest] = texts;
  const found = first === undefined ? "" : rest.reduce(shared, first).trim();
  return found.length >= 2 ? found : undefined;
}

function fromHeadings(topic: TopicInput, documents: readonly string[]): string | undefined {
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
  return common(ranked.map(([text]) => text)) ?? top?.[0];
}

function nameOf(topic: TopicInput): NamedTopic {
  const documents = topic.documents.map((d) => d.replace(BRACKETS, "").trim()).filter(Boolean);
  const below = topic.topics ?? [];
  let title = common(below) ?? (topic.level === 1 ? documents[0] : fromHeadings(topic, documents));
  if (title !== undefined && below.includes(title)) title = `${title}相关`;
  title = (title ?? topic.statements[0] ?? "未命名").slice(0, TITLE_CHARS);
  const from = documents.slice(0, 2).join("、");
  return {
    ref: topic.ref,
    title,
    summary: from ? `${title}相关的规定与说明，见${from}等文档。` : `${title}相关的规定与说明。`,
  };
}

export const mockNameTopics: MockResponder = (messages: readonly ChatMessage[]) => {
  const input = nameInputOf(messages.map((m) => m.content).join("\n"));
  return JSON.stringify({ topics: input ? input.topics.map(nameOf) : [] });
};
