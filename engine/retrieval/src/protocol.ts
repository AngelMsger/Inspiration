/**
 * What retrieval sends the model and what it expects back, on its two tasks. The mocks
 * read the same inputs, so both sides of each prompt share these types.
 */

export const COMPONENT = "retrieval";

export const CONTEXT_TASK = "retrieval.write_context";
export const CONTEXT_PROMPT_VERSION = "write_context@1";
/** Chunks per write_context call. */
export const CONTEXTS_PER_CALL = 20;
/** How much of a chunk the model sees to situate it. */
export const CONTEXT_CHARS = 1200;

export interface ContextInput {
  document: { title: string; language?: string };
  chunks: { ref: string; heading_path: string[]; text: string }[];
}

export interface ContextOutput {
  headers: { ref: string; header: string }[];
}

export const CONTEXT_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["headers"],
  additionalProperties: false,
  properties: {
    headers: {
      type: "array",
      items: {
        type: "object",
        required: ["ref", "header"],
        additionalProperties: false,
        properties: { ref: { type: "string" }, header: { type: "string", minLength: 1, maxLength: 300 } },
      },
    },
  },
};

export const ANSWER_TASK = "retrieval.answer_question";
export const ANSWER_PROMPT_VERSION = "answer_question@2";

export interface AnswerSource {
  /** "1", "2", ...: what a sentence cites. */
  ref: string;
  kind: "statement" | "passage";
  title: string;
  /** A passage's sentences, one per line. */
  text: string;
  /** For a statement of a fact slot: where its value stands with governance. */
  standing?: "holds" | "outdated" | "disputed" | "differs";
  /** For a value that does not hold: the source with the value that holds instead. */
  held_ref?: string;
}

/**
 * In this order, sources first: a prompt that gives every question the same sources (the
 * long-context rival) then starts the same, so a provider's prefix cache serves them.
 */
export interface AnswerInput {
  sources: AnswerSource[];
  /** The language to answer in. */
  language: string;
  context?: string;
  question: string;
}

export interface AnswerOutput {
  sentences: { text: string; sources: string[] }[];
  gaps: string[];
  confidence: number;
}

export const ANSWER_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["sentences", "gaps", "confidence"],
  additionalProperties: false,
  properties: {
    sentences: {
      type: "array",
      items: {
        type: "object",
        required: ["text", "sources"],
        additionalProperties: false,
        properties: {
          text: { type: "string", minLength: 1 },
          sources: { type: "array", items: { type: "string" } },
        },
      },
    },
    gaps: { type: "array", items: { type: "string" } },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
};

const INPUT = /<input>\s*([\s\S]*?)\s*<\/input>/;

/** The input of a prompt, read back from its messages. */
export function inputOf<T>(text: string): T | undefined {
  const found = INPUT.exec(text)?.[1];
  if (found === undefined) return undefined;
  try {
    return JSON.parse(found) as T;
  } catch {
    return undefined;
  }
}
