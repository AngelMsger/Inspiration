// The MCP server over a library double: the protocol it speaks, the tools it lists, the
// arguments it passes on as the principal asked, and what a failed tool tells the agent.

import type { DocumentView, GroundedAnswer, Principal, SearchResult } from "@inspiration/contracts";
import { describe, expect, test } from "vitest";
import { type JsonRpcResponse, type Library, McpServer, PROTOCOL_VERSIONS } from "../src/index.ts";

const AGENT: Principal = {
  id: "agt_01QINGHE000000000000HELPER",
  kind: "agent",
  tenant_id: "ten_01QINGHE000000000000000001",
  on_behalf_of: "mem_01QINGHE0000000000ZHOUMIN",
  scopes: ["knowledge.read"],
};
const VERSION = "sv_01QINGHE00000000000TRAVEL1";

class Refused extends Error {
  override name = "Refused";
}

function server() {
  const calls: [string, unknown, Principal][] = [];
  const library: Library = {
    search: async (query, who) => {
      calls.push(["search", query, who]);
      return { query_id: "q1", hits: [], token_estimate: 0 } satisfies SearchResult;
    },
    answer: async (query, who) => {
      calls.push(["answer", query, who]);
      if (query.question === "boom") throw new Error("the database is gone");
      return {
        answer_id: "a1",
        answer: "650 CNY",
        citations: [],
        confidence: 0.9,
        gaps: [],
        token_estimate: 3,
      } as GroundedAnswer;
    },
    document: async (version, who) => {
      calls.push(["document", version, who]);
      if (version !== VERSION) throw new Refused(`document ${version} is not found`);
      return { version: { id: VERSION } } as DocumentView;
    },
  };
  const mcp = new McpServer({
    library,
    version: "0.1.0",
    refusal: (e) =>
      e instanceof Refused || e instanceof RangeError || (e as Error).name === "ContractError"
        ? (e as Error).message
        : undefined,
  });
  // A request with an id always gets an answer.
  const rpc = async (method: string, params?: unknown, id: number | string = 1) =>
    (await mcp.handle(
      { jsonrpc: "2.0", id, method, ...(params !== undefined && { params }) },
      AGENT,
    )) as JsonRpcResponse;
  return { mcp, rpc, calls };
}

describe("the MCP server", () => {
  test("agrees on the client's protocol version when it speaks it, else offers its newest", async () => {
    const { rpc } = server();
    const asked = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "c" },
    });
    expect(asked).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "inspiration", version: "0.1.0" },
      },
    });
    expect((await rpc("initialize", { protocolVersion: "2024-11-05" })).result).toMatchObject({
      protocolVersion: PROTOCOL_VERSIONS[0],
    });
    expect(await rpc("ping", undefined, "p")).toEqual({ jsonrpc: "2.0", id: "p", result: {} });
  });

  test("answers no notification or response, and refuses a batch or what is not JSON-RPC", async () => {
    const { mcp } = server();
    expect(await mcp.handle({ jsonrpc: "2.0", method: "notifications/initialized" }, AGENT)).toBeUndefined();
    expect(await mcp.handle({ jsonrpc: "2.0", id: 7, result: {} }, AGENT)).toBeUndefined();
    expect(await mcp.handle([{ jsonrpc: "2.0", id: 1, method: "ping" }], AGENT)).toMatchObject({
      id: null,
      error: { code: -32600 },
    });
    expect(await mcp.handle({ id: 2, method: "ping" }, AGENT)).toMatchObject({ id: 2, error: { code: -32600 } });
    expect(await mcp.handle("ping", AGENT)).toMatchObject({ id: null, error: { code: -32600 } });
    expect(await mcp.handle({ jsonrpc: "2.0", id: 3, method: "resources/list" }, AGENT)).toMatchObject({
      id: 3,
      error: { code: -32601 },
    });
  });

  test("lists search, ask and read, each with what it takes", async () => {
    const { rpc } = server();
    const { tools } = (await rpc("tools/list")).result as {
      tools: { name: string; inputSchema: { required: string[] } }[];
    };
    expect(tools.map((t) => [t.name, t.inputSchema.required])).toEqual([
      ["search", ["text"]],
      ["ask", ["question"]],
      ["read", ["version_id"]],
    ]);
  });

  test("passes a tool's arguments on as the contract has them, for the principal that called", async () => {
    const { rpc, calls } = server();
    const searched = await rpc("tools/call", { name: "search", arguments: { text: "hotel cap", top_k: 3, extra: 1 } });
    expect(searched?.result).toEqual({
      content: [{ type: "text", text: JSON.stringify({ query_id: "q1", hits: [], token_estimate: 0 }) }],
      structuredContent: { query_id: "q1", hits: [], token_estimate: 0 },
    });
    await rpc("tools/call", { name: "ask", arguments: { question: "hotel cap?", depth: "standard" } });
    await rpc("tools/call", { name: "read", arguments: { version_id: VERSION } });
    expect(calls).toEqual([
      ["search", { text: "hotel cap", top_k: 3 }, AGENT],
      ["answer", { question: "hotel cap?", depth: "standard" }, AGENT],
      ["document", VERSION, AGENT],
    ]);
  });

  test("tells the agent why a tool failed when the failure is expected, and only that it failed otherwise", async () => {
    const { rpc } = server();
    const call = async (name: string, args: unknown) => (await rpc("tools/call", { name, arguments: args })).result;
    expect(await call("read", { version_id: "sv_01ELSEWHERE0000000000000001" })).toEqual({
      content: [{ type: "text", text: "document sv_01ELSEWHERE0000000000000001 is not found" }],
      isError: true,
    });
    expect(await call("search", { text: "" })).toMatchObject({
      isError: true,
      content: [{ text: expect.stringMatching(/text/) }],
    });
    expect(await call("read", {})).toMatchObject({ isError: true, content: [{ text: "version_id names a version" }] });
    expect(await call("ask", { question: "boom" })).toEqual({
      content: [{ type: "text", text: "ask failed" }],
      isError: true,
    });
    expect(await rpc("tools/call", { name: "write", arguments: {} })).toMatchObject({ error: { code: -32602 } });
  });
});
