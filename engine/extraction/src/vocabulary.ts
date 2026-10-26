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
import { type ClaimValueKind, schemaErrors } from "@inspiration/contracts";
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

const SCHEMA = {
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

export function parseVocabulary(value: unknown): Vocabulary {
  const errors = schemaErrors(SCHEMA, value);
  if (errors.length) throw new VocabularyError(`invalid predicate catalogue: ${errors.join("; ")}`);
  return value as Vocabulary;
}

export async function loadVocabulary(file: string): Promise<Vocabulary> {
  return parseVocabulary(parse(await readFile(file, "utf8")));
}
