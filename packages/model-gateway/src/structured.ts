/** Structured output: extract JSON from model text and validate it against a schema. */

import { schemaErrors } from "@inspiration/contracts";

export class InvalidOutput extends Error {
  override name = "InvalidOutput";
}

const FENCE = /```(?:json)?\s*([\s\S]*?)```/g;

/** The end (exclusive) of the JSON object or array starting at text[start], or -1. */
function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** The first JSON value in text, tolerating code fences and surrounding prose. */
export function extractJson(text: string): unknown {
  const candidates = [...[...text.matchAll(FENCE)].map((m) => m[1] as string), text];
  for (const raw of candidates) {
    const c = raw.trim();
    try {
      return JSON.parse(c);
    } catch {
      // fall through to the first object or array inside the text
    }
    const starts = [c.indexOf("{"), c.indexOf("[")].filter((i) => i >= 0);
    if (!starts.length) continue;
    const start = Math.min(...starts);
    const end = balancedEnd(c, start);
    if (end < 0) continue;
    try {
      return JSON.parse(c.slice(start, end));
    } catch {
      // not JSON after all
    }
  }
  throw new InvalidOutput("no JSON value found in the model output");
}

/** Throws InvalidOutput with up to five problems when the value does not match the schema. */
export function validateOutput(schema: object, value: unknown): void {
  const errors = schemaErrors(schema, value);
  if (errors.length) throw new InvalidOutput(errors.slice(0, 5).join("; "));
}

export const SCHEMA_MARKER = "It must validate against this JSON Schema:\n";

/** The system message that asks a model without native JSON Schema support for conforming JSON. */
export function schemaInstruction(schema: object): string {
  return `Reply with one JSON value only, no prose and no code fences. ${SCHEMA_MARKER}${JSON.stringify(schema)}`;
}
