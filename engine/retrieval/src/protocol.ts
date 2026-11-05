/**
 * What retrieval sends the model and what it expects back, on its three tasks. The mocks
 * read the same inputs, so both sides of each prompt share these types.
 */

import { type ChatMessage, GatewayException, type ModelGateway, type SensitivityLabel } from "@inspiration/contracts";
import { logger } from "@inspiration/kernel";
import type { PromptRegistry } from "@inspiration/model-gateway";

export const COMPONENT = "retrieval";

const log = logger(COMPONENT);

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
export const ANSWER_PROMPT_VERSION = "answer_question@4";

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
  /**
   * For a statement on one side of a disagreement no person has settled: the statements that
   * state the other values.
   */
  disputed_with?: string[];
  /** For a passage: the statements of such a disagreement that its lines state. */
  disputed?: string[];
  /** For a passage: its document's governance level, by which sources that disagree are weighed. */
  level?: "governed" | "reference" | "search_only";
  /** For a passage: the day its document last changed, by the date its source gives. */
  changed?: string;
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

export const TRANSLATE_TASK = "retrieval.translate_question";
export const TRANSLATE_PROMPT_VERSION = "translate_question@1";

export interface TranslateInput {
  question: string;
  /** BCP 47 tags of the languages to write it in. */
  languages: string[];
}

export interface TranslateOutput {
  translations: { language: string; text: string }[];
}

export const TRANSLATE_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["translations"],
  additionalProperties: false,
  properties: {
    translations: {
      type: "array",
      items: {
        type: "object",
        required: ["language", "text"],
        additionalProperties: false,
        properties: { language: { type: "string" }, text: { type: "string", minLength: 1, maxLength: 2000 } },
      },
    },
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

/**
 * The reply to one of retrieval's prompts, or undefined when the model gives none that is
 * valid: an answer the model cannot give validly is no answer. Budgets and outages are raised.
 */
export async function complete<T>(
  models: ModelGateway,
  prompts: PromptRegistry,
  call: {
    task: string;
    version: string;
    input: unknown;
    schema: Record<string, unknown>;
    sensitivity: SensitivityLabel;
    tenantId: string;
    maxOutputTokens?: number;
    metadata?: Record<string, string>;
  },
): Promise<T | undefined> {
  try {
    const completion = await models.complete({
      task: call.task,
      prompt_version: call.version,
      messages: prompts.render(call.task, call.version, { input: JSON.stringify(call.input) }) as [
        ChatMessage,
        ...ChatMessage[],
      ],
      response_schema: call.schema,
      tier: "flash",
      sensitivity: call.sensitivity,
      budget_key: `tenant:${call.tenantId}/${COMPONENT}`,
      tenant_id: call.tenantId,
      temperature: 0,
      ...(call.maxOutputTokens && { max_output_tokens: call.maxOutputTokens }),
      ...(call.metadata && { metadata: call.metadata }),
    });
    return completion.json as T;
  } catch (e) {
    if (e instanceof GatewayException && e.code === "invalid_output") {
      log.warn("no valid output", { task: call.task, error: e.message });
      return undefined;
    }
    throw e;
  }
}
