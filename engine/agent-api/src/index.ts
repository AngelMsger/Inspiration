/**
 * Agent API: how agents reach the knowledge base. Built so far: the MCP server (mcp.ts), with
 * the tools search, ask and read, over streamable HTTP without sessions: each request carries
 * one JSON-RPC message and gets one JSON answer, so any engine process can serve it. It
 * answers initialize, ping, tools/list and tools/call; a notification or a response gets no
 * answer (HTTP 202), and a batch is refused.
 *
 *     const mcp = new McpServer({ library, version, refusal });
 *     const answer = await mcp.handle(message, who);   // a JsonRpcResponse, or undefined
 *
 * An agent acts as the member it acts for, never as more: its principal (an agent token, kind
 * agent, on_behalf_of the member, with the token's spaces as space_scope) reads through the
 * library the engine gives it, which reads as the HTTP API does, so access control applies the
 * member's rights, narrowed to the token's spaces and to reading. The engine's composition
 * root wires the library and serves the server at POST /v0/mcp; the business layer checks the
 * personal token the agent holds and passes the call on with a principal token for it.
 *
 * - search takes SearchQuery's text, space_ids and top_k and gives a SearchResult.
 * - ask takes AnswerQuery's question, space_ids, context and depth and gives a GroundedAnswer,
 *   recorded as every answer is, under the member, with the agent beside it.
 * - read takes a citation's source_version_id and gives that version's DocumentView.
 *
 * A tool's result is its contract value as structured content and as JSON text. A tool that
 * fails answers isError with why, when the library expects the failure (McpOptions.refusal),
 * and otherwise only that it failed, so nothing internal reaches the agent.
 *
 * Not yet built: REST and OpenAPI for agents, the Skills export, a per-call audit, OAuth for
 * MCP clients (the business layer's), and reacting to unit.published.
 */

export { type JsonRpcResponse, type Library, type McpOptions, McpServer, PROTOCOL_VERSIONS } from "./mcp.ts";
