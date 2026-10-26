/**
 * What extraction sends the model for one window of blocks and what it expects back. The
 * mock reads the same input, so both sides of the prompt share these types.
 */

import type { ClaimType, ClaimValue } from "@inspiration/contracts";
import type { PredicateEntry } from "./vocabulary.ts";

export const TASK = "extraction.extract_claims";
export const PROMPT_VERSION = "extract_claims@4";

export interface WindowSpan {
  /** A reference local to the window ("s1"), so the model never sees or invents span IDs. */
  ref: string;
  text: string;
}

export interface WindowBlock {
  kind: string;
  heading_path: string[];
  /** For a table row: the cells of its table's header row. */
  header?: string[];
  spans: WindowSpan[];
}

export interface WindowInput {
  /** date: the day the document was written, YYYY-MM-DD, when its metadata says (`date`). */
  document: { title: string; language?: string; date?: string };
  /** The catalogue entries whose aliases occur in the window. */
  vocabulary: PredicateEntry[];
  blocks: WindowBlock[];
}

export interface ExtractedClaim {
  statement: string;
  claim_type: ClaimType;
  knowledge_class?: string;
  subject?: string;
  predicate?: string;
  qualifiers?: string[];
  value?: ClaimValue;
  /** The day the statement takes effect, when the passage says ("from 1 October 2026"). */
  valid_from?: string;
  confidence?: number;
  evidence: { span: string; quote: string }[];
}

export interface WindowOutput {
  claims: ExtractedClaim[];
}

const NAME = "^[a-z][a-z0-9_]*$";

export const CLAIM_TYPES: readonly ClaimType[] = [
  "fact",
  "rule",
  "definition",
  "metric",
  "procedure_step",
  "assumption",
  "conclusion",
  "plan",
  "opinion",
];

/** One flat object per claim: strict json_schema modes on many servers reject oneOf. */
export const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["claims"],
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        required: ["statement", "claim_type", "evidence"],
        properties: {
          statement: { type: "string", minLength: 1 },
          claim_type: { enum: CLAIM_TYPES },
          knowledge_class: { type: "string", pattern: NAME },
          subject: { type: "string" },
          predicate: { type: "string", pattern: "^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)*$" },
          qualifiers: { type: "array", items: { type: "string" } },
          value: {
            type: "object",
            required: ["kind"],
            properties: {
              kind: { enum: ["text", "number", "money", "percent", "date", "duration", "boolean", "enum", "range"] },
              text: { type: "string" },
              number: { type: "number" },
              unit: { type: "string" },
              currency: { type: "string", pattern: "^[A-Z]{3}$" },
              normalized: { type: "string" },
            },
          },
          valid_from: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
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

const INPUT = /<input>\s*([\s\S]*?)\s*<\/input>/;

/** The window input inside a rendered prompt, or undefined when the prompt has none. */
export function inputOf(text: string): WindowInput | undefined {
  const found = INPUT.exec(text)?.[1];
  if (found === undefined) return undefined;
  try {
    return JSON.parse(found) as WindowInput;
  } catch {
    return undefined;
  }
}
