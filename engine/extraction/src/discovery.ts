/** Evidence-backed, space-local predicate discovery for companies with no supplied catalogue.
 * This only proposes normalization vocabulary; the ordinary extractor must still cite every claim.
 */
import {
  type ChatMessage,
  canonicalJson,
  contentHash,
  GatewayException,
  type ModelGateway,
  type SensitivityLabel,
  type SourceVersion,
} from "@inspiration/contracts";
import { defineTable, type Records } from "@inspiration/eventbus";
import { loadLanguages } from "@inspiration/kernel";
import type { MockResponder, PromptRegistry } from "@inspiration/model-gateway";
import { type PredicateEntry, parseVocabulary, VOCABULARY_SCHEMA } from "./vocabulary.ts";
import type { Window } from "./windows.ts";

const TASK = "extraction.discover_facts";
const VERSION = "discover_facts@1";
interface Catalogue {
  tenant_id: string;
  space_id: string;
  sensitivity: SensitivityLabel;
  predicates: PredicateEntry[];
  read: string[];
}
const CATALOGUES = defineTable<Catalogue>("extraction.catalogues", {
  key: (c) => `${c.tenant_id}:${c.space_id}:${c.sensitivity}`,
  columns: { tenant_id: (c) => c.tenant_id, space_id: (c) => c.space_id },
});
interface Proposal extends PredicateEntry {
  evidence: { span: string; quote: string }[];
}
const SCHEMA = {
  ...VOCABULARY_SCHEMA,
  properties: {
    predicates: {
      type: "array",
      maxItems: 20,
      items: {
        ...VOCABULARY_SCHEMA.properties.predicates.items,
        required: [...VOCABULARY_SCHEMA.properties.predicates.items.required, "evidence"],
        properties: {
          ...VOCABULARY_SCHEMA.properties.predicates.items.properties,
          evidence: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["span", "quote"],
              properties: { span: { type: "string" }, quote: { type: "string", minLength: 1 } },
            },
          },
        },
      },
    },
  },
};

function vocabularyOf(discovered: PredicateEntry[], supplied: PredicateEntry[]): PredicateEntry[] {
  return [...new Map([...discovered, ...supplied].map((entry) => [entry.predicate, entry])).values()];
}

function mergeQualifiers(
  before: NonNullable<PredicateEntry["qualifiers"]>,
  added: NonNullable<PredicateEntry["qualifiers"]>,
) {
  const entries = new Map(before.map((q) => [q.name, q]));
  for (const entry of added) {
    const previous = entries.get(entry.name);
    entries.set(entry.name, { ...entry, aliases: [...new Set([...(previous?.aliases ?? []), ...entry.aliases])] });
  }
  return [...entries.values()];
}

export class FactDiscovery {
  readonly #records: Records;
  readonly #models: ModelGateway;
  readonly #prompts: PromptRegistry;
  readonly #pending = new Map<string, Promise<unknown>>();
  constructor(records: Records, models: ModelGateway, prompts: PromptRegistry) {
    this.#records = records;
    this.#models = models;
    this.#prompts = prompts;
  }

  async catalogue(
    tenant: string,
    space: string,
    sensitivity: SensitivityLabel,
    supplied: PredicateEntry[] = [],
  ): Promise<PredicateEntry[]> {
    const discovered = (await this.#records.get(CATALOGUES, `${tenant}:${space}:${sensitivity}`))?.predicates ?? [];
    return vocabularyOf(discovered, supplied);
  }

  async discover(version: SourceVersion, window: Window, supplied: PredicateEntry[]): Promise<PredicateEntry[]> {
    const key = `${version.tenant_id}:${version.space_id}:${version.sensitivity}`;
    const run = (this.#pending.get(key) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.#read(version, window, supplied));
    this.#pending.set(key, run);
    try {
      return await run;
    } finally {
      if (this.#pending.get(key) === run) this.#pending.delete(key);
    }
  }

  async #read(version: SourceVersion, window: Window, supplied: PredicateEntry[]): Promise<PredicateEntry[]> {
    const state = (await this.#records.get(
      CATALOGUES,
      `${version.tenant_id}:${version.space_id}:${version.sensitivity}`,
    )) ?? {
      tenant_id: version.tenant_id,
      space_id: version.space_id,
      sensitivity: version.sensitivity,
      predicates: [],
      read: [],
    };
    // Explicit vocabulary remains configuration; discovery owns only evidence-backed entries.
    const configured = new Set(supplied.map((p) => p.predicate));
    const learned = new Map(state.predicates.filter((p) => !configured.has(p.predicate)).map((p) => [p.predicate, p]));
    const known = () => vocabularyOf([...learned.values()], supplied);
    const hash = contentHash(JSON.stringify([VERSION, version.id, window.blocks]));
    if (state.read.includes(hash) || learned.size >= 200) return known();
    let output: { predicates: Proposal[] };
    try {
      const completion = await this.#models.complete({
        task: TASK,
        prompt_version: VERSION,
        tier: "flash",
        sensitivity: version.sensitivity,
        budget_key: `tenant:${version.tenant_id}/extraction`,
        tenant_id: version.tenant_id,
        space_id: version.space_id,
        temperature: 0,
        response_schema: SCHEMA,
        messages: this.#prompts.render(TASK, VERSION, {
          input: JSON.stringify({ title: version.title, vocabulary: known(), blocks: window.blocks }),
        }) as [ChatMessage, ...ChatMessage[]],
        metadata: { source_version_id: version.id },
      });
      output = completion.json as { predicates: Proposal[] };
      parseVocabulary(output);
    } catch (error) {
      if (error instanceof GatewayException && error.code === "invalid_output") return known();
      throw error;
    }
    for (const proposal of output.predicates) {
      const quotes = proposal.evidence
        .filter((e) => e.quote && window.spans.get(e.span)?.text.includes(e.quote))
        .map((e) => e.quote);
      if (!quotes.length) continue;
      const text = quotes.join("\n").toLowerCase();
      const aliases = proposal.aliases.filter((a) => text.includes(a.toLowerCase()));
      if (!aliases.length) continue;
      const { evidence: _, ...entry } = proposal;
      if (configured.has(entry.predicate)) continue;
      const previous = learned.get(entry.predicate);
      // Established value kinds and units never change silently after claims have used them.
      if (previous && canonicalJson(previous.value) !== canonicalJson(entry.value)) continue;
      const qualifiers = (entry.qualifiers ?? [])
        .map((q) => ({ ...q, aliases: q.aliases.filter((a) => text.includes(a.toLowerCase())) }))
        .filter((q) => q.aliases.length);
      learned.set(
        entry.predicate,
        previous
          ? {
              ...previous,
              aliases: [...new Set([...previous.aliases, ...aliases])],
              qualifiers: mergeQualifiers(previous.qualifiers ?? [], qualifiers),
            }
          : { ...entry, aliases, ...(qualifiers.length ? { qualifiers } : { qualifiers: [] }) },
      );
      if (learned.size >= 200) break;
    }
    await this.#records.transaction((tx) =>
      tx.put(CATALOGUES, [{ ...state, predicates: [...learned.values()], read: [...state.read.slice(-1999), hash] }]),
    );
    return known();
  }
}

/** Rehearsal recognizes explicit label/number pairs; it makes no claim to semantic discovery. */
export const mockDiscoverFacts: MockResponder = (messages) => {
  const text = messages.map((m) => m.content).join("\n");
  const json = /<input>\s*([\s\S]*?)\s*<\/input>/.exec(text)?.[1];
  if (!json) return JSON.stringify({ predicates: [] });
  const input = JSON.parse(json) as {
    blocks: { spans: { ref: string; text: string }[] }[];
    vocabulary: PredicateEntry[];
  };
  const patterns = loadLanguages(new URL("../languages/", import.meta.url))
    .flatMap((p) => p.list("discovery_numeric"))
    .map((p) => new RegExp(p, "u"));
  const predicates: Proposal[] = [];
  for (const span of input.blocks.flatMap((b) => b.spans)) {
    const match = patterns.map((p) => p.exec(span.text)).find(Boolean);
    const label = match?.groups?.label?.trim();
    if (!label) continue;
    const unit = match?.groups?.unit?.trim();
    const existing = input.vocabulary.find((e) => e.aliases.includes(label));
    predicates.push({
      ...(existing ?? {
        predicate: `fact_${contentHash(label.toLowerCase()).slice(7, 23)}`,
        label,
        aliases: [label],
        value: { kind: "number", ...(unit && { unit, words: [unit] }) },
      }),
      evidence: [{ span: span.ref, quote: span.text }],
    });
  }
  return JSON.stringify({ predicates: predicates.slice(0, 20) });
};
