import {
  type ChatMessage,
  GatewayException,
  type KnowledgeStore,
  type ModelGateway,
  maxLabel,
  type SensitivityLabel,
  type TaxonomyNode,
} from "@inspiration/contracts";
import { languageOf, logger } from "@inspiration/kernel";
import type { PromptRegistry } from "@inspiration/model-gateway";
import type { Topic } from "./cluster.ts";
import {
  NAME_PROMPT_VERSION,
  NAME_SCHEMA,
  NAME_TASK,
  NAMES_PER_CALL,
  type NamedTopic,
  type NameInput,
  type NameOutput,
  SUMMARY_MAX,
  TITLE_MAX,
  type TopicInput,
} from "./protocol.ts";
import { batched, bump, byCount, COMPONENT, type Section } from "./records.ts";

const log = logger("page-compiler");

/** What naming a topic takes, and the sensitivity and language of the call it goes in. */
type NameRequest = Omit<TopicInput, "ref"> & { sensitivity: SensitivityLabel; language: string };

interface PendingName {
  topic: Topic;
  input: NameRequest;
}

export interface NamingDeps {
  store: KnowledgeStore;
  models: ModelGateway;
  prompts: PromptRegistry;
}

/** A few statements of each new topic, from its largest sections, for naming it. */
async function statementsForNaming(
  store: KnowledgeStore,
  topics: readonly Topic[],
  sections: ReadonlyMap<string, Section>,
): Promise<Map<string, string>> {
  const ids = topics.flatMap((t) =>
    t.units
      .map((k) => sections.get(k) as Section)
      .sort((a, b) => b.claims.length - a.claims.length || (a.key < b.key ? -1 : 1))
      .slice(0, 5)
      .flatMap((s) => (s.claims[0] ? [s.claims[0].id] : [])),
  );
  const claims = await batched([...new Set(ids)], (x) => store.getClaims(x));
  return new Map(claims.map((c) => [c.id, c.statement]));
}

function buildNameInput(
  topic: Topic,
  sections: ReadonlyMap<string, Section>,
  statements: ReadonlyMap<string, string>,
  titleOf: (key: string) => string | undefined,
  live: readonly Topic[],
): NameRequest {
  const below = topic.units.map((k) => sections.get(k) as Section);
  const headings = new Map<string, number>();
  const documents = new Map<string, number>();
  const languages = new Map<string, number>();
  for (const s of below) {
    bump(headings, s.heading_path.at(-1) ?? s.title);
    bump(documents, s.title);
    bump(languages, s.language);
  }
  const largest = [...below].sort((a, b) => b.claims.length - a.claims.length || (a.key < b.key ? -1 : 1));
  const children = live.filter((t) => t.parent === topic.key).sort((a, b) => b.statements - a.statements);
  return {
    level: topic.level,
    headings: byCount(headings)
      .slice(0, 10)
      .map(([text, n]) => ({ text, sections: n })),
    documents: byCount(documents)
      .slice(0, 5)
      .map(([title]) => title),
    statements: largest.slice(0, 5).flatMap((s) => {
      const text = s.claims[0] && statements.get(s.claims[0].id);
      return text ? [text.slice(0, 200)] : [];
    }),
    ...(children.length > 0 && {
      topics: children.flatMap((t) => {
        const title = titleOf(t.key);
        return title ? [title] : [];
      }),
    }),
    sensitivity: maxLabel("public", ...below.map((s) => s.sensitivity)),
    // Until documents carry a language tag, the language their headings and titles look to be in.
    language: byCount(languages)[0]?.[0] ?? languageOf([...headings.keys(), ...documents.keys()].join("\n")),
  };
}

async function requestNameBatch(
  deps: NamingDeps,
  tenantId: string,
  sensitivity: SensitivityLabel,
  request: NameInput,
): Promise<NameOutput | undefined> {
  try {
    const completion = await deps.models.complete({
      task: NAME_TASK,
      prompt_version: NAME_PROMPT_VERSION,
      messages: deps.prompts.render(NAME_TASK, NAME_PROMPT_VERSION, { input: JSON.stringify(request) }) as [
        ChatMessage,
        ...ChatMessage[],
      ],
      response_schema: NAME_SCHEMA,
      tier: "flash",
      sensitivity,
      budget_key: `tenant:${tenantId}/${COMPONENT}`,
      tenant_id: tenantId,
      temperature: 0,
    });
    return completion.json as NameOutput;
  } catch (e) {
    if (!(e instanceof GatewayException && e.code === "invalid_output")) throw e;
    log.warn("no valid names for topics", { tenant: tenantId, error: e.message });
    return undefined;
  }
}

function collectBatchNames(
  answer: NameOutput | undefined,
  refs: ReadonlyMap<string, PendingName>,
  out: Map<string, NamedTopic>,
  counts: { named: number; calls: number },
): void {
  for (const named of answer?.topics ?? []) {
    const b = refs.get(named.ref);
    const title = named.title.trim();
    if (!b || !title || title.length > TITLE_MAX || out.has(b.topic.key)) continue;
    const summary = named.summary?.trim();
    out.set(b.topic.key, {
      ref: named.ref,
      title,
      ...(summary && summary.length <= SUMMARY_MAX && { summary }),
    });
    counts.named++;
  }
  for (const [ref, b] of refs) {
    if (out.has(b.topic.key)) continue;
    const title = b.input.headings[0]?.text ?? b.input.documents[0] ?? b.topic.key;
    out.set(b.topic.key, { ref, title: title.slice(0, TITLE_MAX) });
  }
}

/**
 * Titles and summaries for new topics, NAMES_PER_CALL per call, each call carrying the
 * highest sensitivity of the sections it shows. A topic the model leaves out or names at
 * more than TITLE_MAX characters, or a call that stays invalid, gets its commonest heading as
 * its title; a summary over SUMMARY_MAX is left out.
 */
async function nameLevel(
  deps: NamingDeps,
  tenantId: string,
  inputs: readonly PendingName[],
  counts: { named: number; calls: number },
): Promise<Map<string, NamedTopic>> {
  const out = new Map<string, NamedTopic>();
  const groups = new Map<string, PendingName[]>();
  for (const i of inputs) {
    const k = `${i.input.sensitivity}\x1f${i.input.language}`;
    groups.set(k, [...(groups.get(k) ?? []), i]);
  }
  for (const group of groups.values()) {
    for (let start = 0; start < group.length; start += NAMES_PER_CALL) {
      const batch = group.slice(start, start + NAMES_PER_CALL);
      const first = batch[0] as PendingName;
      const refs = new Map(batch.map((b, i) => [`t${i + 1}`, b]));
      const request: NameInput = {
        language: first.input.language,
        topics: [...refs].map(([ref, b]) => {
          const { sensitivity: _s, language: _l, ...input } = b.input;
          return { ref, ...input };
        }),
      };
      const answer = await requestNameBatch(deps, tenantId, first.input.sensitivity, request);
      counts.calls++;
      collectBatchNames(answer, refs, out, counts);
    }
  }
  return out;
}

/** Name the new topics from the bottom up, so a topic with topics below it is named after them. */
export async function nameNewTopics(
  deps: NamingDeps,
  tenantId: string,
  live: readonly Topic[],
  nodes: ReadonlyMap<string, TaxonomyNode>,
  sections: readonly Section[],
): Promise<{ names: Map<string, NamedTopic>; created: Topic[]; named: number; calls: number }> {
  const created = live.filter((t) => t.created);
  const sectionByKey = new Map(sections.map((s) => [s.key, s]));
  const statementOf = await statementsForNaming(deps.store, created, sectionByKey);
  const names = new Map<string, NamedTopic>();
  const titleOf = (k: string) => names.get(k)?.title ?? nodes.get(k)?.title;
  const counts = { named: 0, calls: 0 };
  for (const level of [3, 2, 1]) {
    const inputs = created
      .filter((t) => t.level === level)
      .map((t) => ({
        topic: t,
        input: buildNameInput(t, sectionByKey, statementOf, titleOf, live),
      }));
    for (const [k, named] of await nameLevel(deps, tenantId, inputs, counts)) names.set(k, named);
  }
  return { names, created, named: counts.named, calls: counts.calls };
}
