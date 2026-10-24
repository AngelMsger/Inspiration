/**
 * What page-compiler sends the model to name topics, and what it expects back. The mock
 * reads the same input, so both sides of the prompt share these types.
 */

export const NAME_TASK = "page-compiler.name_topics";
export const NAME_PROMPT_VERSION = "name_topics@1";

/** Topics named per call. */
export const NAMES_PER_CALL = 20;

export interface TopicInput {
  /** A reference local to the call ("t1"). */
  ref: string;
  level: 1 | 2 | 3;
  /** The section headings below it, the most frequent first, with how many sections have each. */
  headings: { text: string; sections: number }[];
  /** The titles of its documents, the one with most sections in it first. */
  documents: string[];
  /** A few of its statements. */
  statements: string[];
  /** For an area or a split topic: the titles of the topics below it. */
  topics?: string[];
}

export interface NameInput {
  language: string;
  topics: TopicInput[];
}

export interface NamedTopic {
  ref: string;
  title: string;
  summary?: string;
}

export interface NameOutput {
  topics: NamedTopic[];
}

export const NAME_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["topics"],
  additionalProperties: false,
  properties: {
    topics: {
      type: "array",
      items: {
        type: "object",
        required: ["ref", "title"],
        additionalProperties: false,
        properties: {
          ref: { type: "string" },
          title: { type: "string", minLength: 1, maxLength: 40 },
          summary: { type: "string", maxLength: 200 },
        },
      },
    },
  },
};

const INPUT = /<input>\s*([\s\S]*?)\s*<\/input>/;

/** The input of a name_topics prompt, read back from its messages. */
export function nameInputOf(text: string): NameInput | undefined {
  const found = INPUT.exec(text)?.[1];
  if (found === undefined) return undefined;
  try {
    return JSON.parse(found) as NameInput;
  } catch {
    return undefined;
  }
}
