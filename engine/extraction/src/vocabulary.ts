/**
 * A tenant's predicate catalogue: the single-valued facts extraction may normalize, each
 * with the words that name it, its qualifiers and its value's kind and unit. A claim that
 * fits an entry gets its predicate, qualifiers and value, which put it in a slot (one
 * subject, predicate and qualifiers) where governance compares values across documents.
 *
 * Provisional: the catalogue is configuration the business layer or the taxonomy gardener
 * will maintain. Until that has a contract, extraction reads it from YAML.
 */

import { readFile } from "node:fs/promises";
import { type ClaimValue, type ClaimValueKind, schemaErrors } from "@inspiration/contracts";
import { parse } from "yaml";

export interface PredicateQualifier {
  name: string;
  /** Words that select this qualifier, as written in documents. */
  aliases: string[];
}

export interface PredicateEntry {
  predicate: string;
  label: string;
  description?: string;
  knowledge_class?: string;
  /** Words that name the fact in documents. */
  aliases: string[];
  qualifiers?: PredicateQualifier[];
  value: {
    kind: ClaimValueKind;
    /** Canonical unit, for example "CNY/night" or "day". */
    unit?: string;
    currency?: string;
    /** Unit words that follow a number in documents, for example ["yuan"] or ["days", "day"]. */
    words?: string[];
    /** The known values of an enum, as written. */
    values?: string[];
  };
}

export interface Vocabulary {
  predicates: PredicateEntry[];
}

export class VocabularyError extends Error {
  override name = "VocabularyError";
}

export const VOCABULARY_SCHEMA = {
  type: "object",
  required: ["predicates"],
  properties: {
    predicates: {
      type: "array",
      items: {
        type: "object",
        required: ["predicate", "label", "aliases", "value"],
        properties: {
          predicate: { type: "string", pattern: "^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)*$" },
          label: { type: "string", minLength: 1 },
          description: { type: "string" },
          knowledge_class: { type: "string", pattern: "^[a-z][a-z0-9_]*$" },
          aliases: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
          qualifiers: {
            type: "array",
            items: {
              type: "object",
              required: ["name", "aliases"],
              properties: {
                name: { type: "string", minLength: 1 },
                aliases: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
              },
            },
          },
          value: {
            type: "object",
            required: ["kind"],
            properties: {
              kind: { enum: ["text", "number", "money", "percent", "date", "duration", "boolean", "enum", "range"] },
              unit: { type: "string" },
              currency: { type: "string", pattern: "^[A-Z]{3}$" },
              words: { type: "array", items: { type: "string", minLength: 1 } },
              values: { type: "array", items: { type: "string", minLength: 1 } },
            },
          },
        },
      },
    },
  },
};

/** The words a text names, in any case: a catalogue writes "hotel" and a document "Hotels". */
export function mentioned(text: string, words: readonly string[]): string[] {
  const folded = text.toLowerCase();
  return words.filter((w) => folded.includes(w.toLowerCase()));
}

/** What a claim says about its catalogue fact. */
export interface Fitted {
  predicate?: string;
  qualifiers?: string[];
  value?: ClaimValue;
}

const LEADING_NUMBER = /^\s*[$€£¥]?\s*(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/;
const NUMERIC: readonly ClaimValueKind[] = ["number", "money", "percent", "duration"];
const fold = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
/** "days" is "day", "USD/night" is "usd/night". */
const sameUnit = (a: string, b: string) => fold(a).replace(/s$/, "") === fold(b).replace(/s$/, "");

/**
 * A model's fit to the catalogue, held to it and written the one way governance compares
 * values, as the stand-in writes it ("300 USD/night"): a model writes one value many ways
 * ("$300", "300 USD", "300 per night"), and each way would be a value of its own in the slot.
 * A qualifier may be given by one of its words ("US team members" for "us"). A fit to an
 * entry the catalogue lacks, with a qualifier the entry lacks, in another unit or currency,
 * without a number for a numeric entry, or with a value an enum does not list is dropped, and
 * the claim stays a statement without a slot: a wrong slot asks a person about a conflict
 * that is not one, a missing slot only leaves the claim ungoverned. Returns the claim as it
 * came when it fits as written, so a stand-in's claims keep their IDs.
 */
export function fitToCatalogue<T extends Fitted>(claim: T, entries: readonly PredicateEntry[]): T {
  if (claim.predicate === undefined) return claim;
  const { predicate, qualifiers, value, ...rest } = claim;
  const entry = entries.find((e) => e.predicate === predicate);
  const names = qualifiers?.map((q) => {
    const named = entry?.qualifiers?.find((e) => e.name === q || e.aliases.some((a) => fold(a) === fold(q)));
    return named?.name;
  });
  if (!entry || names?.some((n) => n === undefined)) return rest as T;
  const fitted = value === undefined ? undefined : valueFor(entry, value);
  if (value !== undefined && fitted === undefined) return rest as T;
  if (fitted === value && names?.every((n, i) => n === qualifiers?.[i])) return claim;
  const named = [...new Set(names as string[])];
  return { ...rest, predicate, ...(named.length && { qualifiers: named }), ...(fitted && { value: fitted }) } as T;
}

function valueFor(entry: PredicateEntry, value: ClaimValue): ClaimValue | undefined {
  const v = entry.value;
  if (!NUMERIC.includes(v.kind)) {
    if (v.kind !== "enum" && v.kind !== "text" && v.kind !== "boolean") return value;
    const said = value.normalized ?? value.text;
    const listed = said === undefined ? undefined : v.values?.find((x) => fold(x) === fold(said));
    if (v.values?.length && listed === undefined) return undefined;
    const normalized = listed ?? said?.trim();
    if (normalized === undefined) return undefined;
    const kind = v.kind === "boolean" ? "enum" : v.kind;
    if (value.kind === kind && value.normalized === normalized) return value;
    return { kind, text: value.text ?? normalized, normalized };
  }
  if (value.unit && v.unit && !sameUnit(value.unit, v.unit) && !(v.currency && sameUnit(value.unit, v.currency))) {
    return undefined;
  }
  if (value.currency && v.currency && value.currency !== v.currency) return undefined;
  const leading = value.normalized?.match(LEADING_NUMBER)?.[1];
  const number = value.number ?? (leading === undefined ? undefined : Number(leading.replaceAll(",", "")));
  if (number === undefined || !Number.isFinite(number)) return undefined;
  const normalized = v.unit ? `${number} ${v.unit}` : String(number);
  if (
    value.kind === v.kind &&
    value.number === number &&
    value.unit === v.unit &&
    value.currency === v.currency &&
    value.normalized === normalized
  ) {
    return value;
  }
  return {
    kind: v.kind,
    ...(value.text && { text: value.text }),
    number,
    ...(v.unit && { unit: v.unit }),
    ...(v.currency && { currency: v.currency }),
    normalized,
  };
}

export function parseVocabulary(value: unknown): Vocabulary {
  const errors = schemaErrors(VOCABULARY_SCHEMA, value);
  if (errors.length) throw new VocabularyError(`invalid predicate catalogue: ${errors.join("; ")}`);
  return value as Vocabulary;
}

export async function loadVocabulary(file: string): Promise<Vocabulary> {
  return parseVocabulary(parse(await readFile(file, "utf8")));
}
