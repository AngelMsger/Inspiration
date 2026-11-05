// The MCP server: JSON-RPC over streamable HTTP, stateless. Each POST carries one message and
// gets one JSON answer; nothing is kept between requests and nothing is streamed.

import {
  type AnswerQuery,
  type DocumentView,
  type GroundedAnswer,
  type Principal,
  parseAs,
  type SearchQuery,
  type SearchResult,
} from "@inspiration/contracts";
import { logger } from "@inspiration/kernel";

const log = logger("agent-api");

/** The protocol versions this server speaks, newest first. */
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;

/** What the tools read, through the engine, as the principal asks: the same reads as its HTTP API. */
export interface Library {
  search(query: SearchQuery, who: Principal): Promise<SearchResult>;
  answer(query: AnswerQuery, who: Principal): Promise<GroundedAnswer>;
  /** The version a citation names, as the principal may read it. */
  document(versionId: string, who: Principal): Promise<DocumentView>;
}

export interface McpOptions {
  library: Library;
  /** The server's version, for initialize. */
  version: string;
  /**
   * What a failed tool tells the agent: the message of an error the library expects (a
   * refusal, a bad argument, something not found), else undefined, and the agent is told only
   * that the tool failed.
   */
  refusal(error: unknown): string | undefined;
}

type Id = string | number | null;

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: Id;
  result?: unknown;
  error?: { code: number; message: string };
}

const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

const SPACES = {
  type: "array",
  items: { type: "string", pattern: "^spc_" },
  description: "Only these spaces; without it, every space you may read.",
};

interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required: string[] };
  run(library: Library, args: Record<string, unknown>, who: Principal): Promise<unknown>;
}

/** Picks the arguments a tool takes, so a contract type validates them under the names the agent used. */
const pick = (args: Record<string, unknown>, keys: readonly string[]) =>
  Object.fromEntries(keys.filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));

const TOOLS: readonly Tool[] = [
  {
    name: "search",
    title: "Search",
    description:
      "Search the company's documents and the statements read from them, as you may read them. Each hit has a " +
      "snippet, its citations and how current it is; read a citation's source_version_id with the read tool.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", minLength: 1, description: "What to look for, in any language." },
        space_ids: SPACES,
        top_k: { type: "integer", minimum: 1, maximum: 100, description: "How many hits, 10 if not given." },
      },
      required: ["text"],
    },
    run: (library, args, who) =>
      library.search(parseAs<SearchQuery>("SearchQuery", pick(args, ["text", "space_ids", "top_k"])), who),
  },
  {
    name: "ask",
    title: "Ask",
    description:
      "Answer a question from the company's documents, with the passages it rests on. It gives the value " +
      "that holds and says when sources differ or a value is out of date.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", minLength: 1 },
        space_ids: SPACES,
        context: { type: "string", description: "The task you are doing, if it helps narrow the answer." },
        depth: {
          type: "string",
          enum: ["compact", "standard"],
          description: "compact, the default, reads the conclusions kept; standard reads more passages.",
        },
      },
      required: ["question"],
    },
    run: (library, args, who) =>
      library.answer(
        parseAs<AnswerQuery>("AnswerQuery", pick(args, ["question", "space_ids", "context", "depth"])),
        who,
      ),
  },
  {
    name: "read",
    title: "Read a document",
    description: "Read a document whole: the version a citation or a search hit names, with its blocks.",
    inputSchema: {
      type: "object",
      properties: { version_id: { type: "string", pattern: "^sv_", description: "A citation's source_version_id." } },
      required: ["version_id"],
    },
    run: (library, args, who) => {
      if (typeof args.version_id !== "string" || !args.version_id) throw new RangeError("version_id names a version");
      return library.document(args.version_id, who);
    },
  },
];

export class McpServer {
  readonly #options: McpOptions;

  constructor(options: McpOptions) {
    this.#options = options;
  }

  /** The answer to one message, or undefined for a notification or a response, which get none. */
  async handle(message: unknown, who: Principal): Promise<JsonRpcResponse | undefined> {
    if (Array.isArray(message)) return failure(null, INVALID_REQUEST, "send one message per request");
    const m = (typeof message === "object" && message) || {};
    const id = "id" in m && (typeof m.id === "string" || typeof m.id === "number") ? m.id : null;
    if (!("method" in m)) return "result" in m || "error" in m ? undefined : failure(id, INVALID_REQUEST, "no method");
    if ((m as { jsonrpc?: unknown }).jsonrpc !== "2.0" || typeof m.method !== "string") {
      return failure(id, INVALID_REQUEST, "not a JSON-RPC 2.0 request");
    }
    if (!("id" in m)) return undefined;
    const params =
      "params" in m && typeof m.params === "object" && m.params ? (m.params as Record<string, unknown>) : {};
    switch (m.method) {
      case "initialize":
        return success(id, this.#initialize(params));
      case "ping":
        return success(id, {});
      case "tools/list":
        return success(id, { tools: TOOLS.map(({ run: _run, ...tool }) => tool) });
      case "tools/call":
        return this.#call(id, params, who);
      default:
        return failure(id, METHOD_NOT_FOUND, `no method ${m.method}`);
    }
  }

  #initialize(params: Record<string, unknown>) {
    const asked = params.protocolVersion;
    const protocolVersion = PROTOCOL_VERSIONS.find((v) => v === asked) ?? PROTOCOL_VERSIONS[0];
    return {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "inspiration", title: "Inspiration", version: this.#options.version },
      instructions:
        "The company's knowledge base, read as the member who gave you access. Ask answers a question with " +
        "citations; search finds passages and statements; read opens a cited document whole.",
    };
  }

  async #call(id: Id, params: Record<string, unknown>, who: Principal): Promise<JsonRpcResponse> {
    const tool = TOOLS.find((t) => t.name === params.name);
    if (!tool) return failure(id, INVALID_PARAMS, `no tool ${String(params.name)}`);
    const args = typeof params.arguments === "object" && params.arguments ? params.arguments : {};
    try {
      const value = await tool.run(this.#options.library, args as Record<string, unknown>, who);
      return success(id, { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });
    } catch (error) {
      const refusal = this.#options.refusal(error);
      if (refusal === undefined) log.error("tool failed", { tool: tool.name, error });
      const text = refusal ?? `${tool.name} failed`;
      return success(id, { content: [{ type: "text", text }], isError: true });
    }
  }
}

const success = (id: Id, result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });
const failure = (id: Id, code: number, message: string): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});
