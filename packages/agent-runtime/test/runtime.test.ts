import type {
  AgentRunContext,
  AgentSpec,
  ChatMessage,
  Principal,
  SensitivityLabel,
  ToolSpec,
} from "@inspiration/contracts";
import {
  FakeProvider,
  Gateway,
  type MemoryUsage,
  Prompt,
  PromptRegistry,
  parseGatewayConfig,
} from "@inspiration/model-gateway";
import { describe, expect, test } from "vitest";
import {
  actionSchema,
  FunctionTool,
  LabeledResult,
  MAX_RESULT_CHARS,
  MemoryRuns,
  ReplayTools,
  Runtime,
  ToolRegistry,
} from "../src/index.ts";

const TASK = "collaboration.comment_assistant";
const TENANT = "ten_01JC000000000000000000TEN1";
const PROPOSAL = "prp_01JC000000000000000000PRP1";

const SEARCH: ToolSpec = {
  name: "search",
  description: "Search claims the caller may read.",
  input_schema: { type: "object", required: ["query"], properties: { query: { type: "string" } } },
  effect: "read",
};
const PROPOSE: ToolSpec = {
  name: "propose_edit",
  description: "Propose an edit to a page block. A steward or owner approves it.",
  input_schema: {
    type: "object",
    required: ["block_key", "text"],
    properties: { block_key: { type: "string" }, text: { type: "string" } },
  },
  effect: "propose",
};

function gateway(): Gateway {
  const config = parseGatewayConfig({
    providers: [
      {
        name: "cloud",
        kind: "fake",
        max_sensitivity: "internal",
        models: [
          {
            name: "cloud-flash",
            operations: ["complete"],
            tiers: ["flash", "standard"],
            price: { input: 1, output: 2 },
          },
        ],
      },
      {
        name: "local",
        kind: "fake",
        max_sensitivity: "secret",
        models: [{ name: "local-chat", operations: ["complete"], json_schema: true }],
      },
    ],
    budgets: [{ match: "tenant:capped*", period: "month", limit: 0.00001 }, { match: "*" }],
  });
  return new Gateway(config, {
    providers: Object.fromEntries(config.providers.map((p) => [p.name, new FakeProvider(p)])),
  });
}

function spec(overrides: Partial<AgentSpec> = {}): AgentSpec {
  return {
    name: TASK,
    version: "0.1.0",
    prompt_version: "comment@1",
    tools: ["search", "propose_edit"],
    max_steps: 6,
    max_tokens: 24_000,
    approval: "owner",
    tier: "standard",
    output_schema: { type: "object", required: ["reply"], properties: { reply: { type: "string" } } },
    ...overrides,
  };
}

function context(principal: Partial<Principal> = {}, overrides: Partial<AgentRunContext> = {}): AgentRunContext {
  return {
    principal: {
      id: "agt_01JC000000000000000000AGT1",
      kind: "agent",
      tenant_id: TENANT,
      on_behalf_of: "usr_01JC000000000000000000USR1",
      ...principal,
    },
    budget_key: `tenant:${TENANT}/collaboration`,
    trace_id: "trace-1",
    ...overrides,
  };
}

const call = (tool: string, args: Record<string, unknown> = {}) =>
  JSON.stringify({ thought: `use ${tool}`, action: "call_tool", tool, arguments: args });
const final = (output: Record<string, unknown>) => JSON.stringify({ thought: "done", action: "final", output });

/** search and propose_edit, recording their calls. search labels its result. */
class Tools {
  readonly calls: [string, Record<string, unknown>][] = [];
  readonly sensitivity: SensitivityLabel | null;

  /** null: search results carry no label. */
  constructor(sensitivity: SensitivityLabel | null = "confidential") {
    this.sensitivity = sensitivity;
  }

  registry(): ToolRegistry {
    return new ToolRegistry([
      new FunctionTool(SEARCH, async (args) => {
        this.calls.push(["search", args]);
        const hits = [{ claim_id: "clm_01JC000000000000000000CLM1", text: "Cap is 600 CNY" }];
        return this.sensitivity ? { hits, sensitivity: this.sensitivity } : { hits };
      }),
      new FunctionTool(PROPOSE, async (args) => {
        this.calls.push(["propose_edit", args]);
        return { proposal_id: PROPOSAL, status: "pending" };
      }),
    ]);
  }
}

function prompts(): PromptRegistry {
  const registry = new PromptRegistry();
  registry.register(
    new Prompt({
      task: TASK,
      version: "comment@1",
      system: "You answer comments on knowledge pages, with citations.",
      user: "Comment: {{input}}",
    }),
  );
  return registry;
}

const fake = (gw: Gateway, name: string) => gw.provider<FakeProvider>(name);
const usageOf = (gw: Gateway) => (gw.usage as MemoryUsage).records;

describe("agent runtime", () => {
  test("a run calls tools, collects proposals and waits for approval", async () => {
    const gw = gateway();
    const tools = new Tools();
    fake(gw, "cloud").script(TASK, call("search", { query: "hotel cap" }));
    // search returned confidential content, so every later step must stay on the local model.
    fake(gw, "local").script(
      TASK,
      call("propose_edit", { block_key: "b_cap", text: "The cap is 600 CNY." }),
      final({ reply: "Updated, see claim." }),
    );
    const runs = new MemoryRuns();
    const result = await new Runtime(gw, tools.registry(), prompts(), { runs }).run(
      spec(),
      { comment: "Is the cap 500?" },
      context(),
    );

    expect(result.status).toBe("needs_approval");
    expect(result.output).toEqual({ reply: "Updated, see claim." });
    expect(result.proposal_ids).toEqual([PROPOSAL]);
    expect(result.steps.map((s) => s.kind)).toEqual(["tool_call", "tool_call", "final"]);
    expect(tools.calls.map(([name]) => name)).toEqual(["search", "propose_edit"]);
    expect(fake(gw, "cloud").calls).toHaveLength(1);
    expect(fake(gw, "local").calls).toHaveLength(2);
    expect(usageOf(gw).map((r) => r.sensitivity)).toEqual(["internal", "confidential", "confidential"]);
    expect(result.usage.input_tokens).toBe(usageOf(gw).reduce((n, r) => n + r.usage.input_tokens, 0));
    expect(result.cost.amount).toBeCloseTo(
      usageOf(gw).reduce((n, r) => n + r.cost.amount, 0),
      8,
    );
    expect(result.run_id).toMatch(/^run_/);
    expect(result.trace_id).toBe("trace-1");
    expect(await runs.get(result.run_id)).toEqual(result);
  });

  test("invalid arguments are reported to the model", async () => {
    const gw = gateway();
    const tools = new Tools(null);
    const seen: string[] = [];
    const afterError = (messages: readonly ChatMessage[]) => {
      seen.push([...messages].reverse().find((m) => m.role === "user")?.content ?? "");
      return call("search", { query: "hotel cap" });
    };
    fake(gw, "cloud").script(TASK, call("search"), afterError, final({ reply: "ok" }));
    const result = await new Runtime(gw, tools.registry(), prompts()).run(spec({ approval: "none" }), "q", context());

    expect(result.status).toBe("completed");
    expect(result.steps[0]).toMatchObject({ kind: "error", tool: "search" });
    expect(result.steps[0]?.error).toBe("invalid arguments for search: (root): must have required property 'query'");
    expect(seen[0]).toMatch(/^Error: invalid arguments for search/);
    expect(tools.calls).toEqual([["search", { query: "hotel cap" }]]);
  });

  test("an unknown tool is corrected inside the gateway", async () => {
    const gw = gateway();
    // The action schema enumerates the tools, so the gateway's corrective retry catches this.
    fake(gw, "cloud").script(TASK, call("delete_everything"), final({ reply: "ok" }));
    const result = await new Runtime(gw, new Tools().registry(), prompts()).run(
      spec({ approval: "none" }),
      "q",
      context(),
    );
    expect(result.status).toBe("completed");
    expect(result.steps).toHaveLength(1);
  });

  test("output that never matches the schema fails the run", async () => {
    const gw = gateway();
    fake(gw, "cloud").script(TASK, final({ answer: "x" }), final({ answer: "y" }));
    const result = await new Runtime(gw, new Tools().registry(), prompts()).run(spec({ max_steps: 2 }), "q", context());
    expect(result.status).toBe("failed");
    expect(result.error).toContain("reply");
    expect(result.steps.at(-1)?.kind).toBe("error");
  });

  test("a failing tool does not end the run", async () => {
    const gw = gateway();
    const tools = new ToolRegistry([
      new FunctionTool(SEARCH, async () => {
        throw new RangeError("index offline");
      }),
      new FunctionTool(PROPOSE, async () => ({})),
    ]);
    fake(gw, "cloud").script(TASK, call("search", { query: "x" }), final({ reply: "Search is down." }));
    const result = await new Runtime(gw, tools, prompts()).run(spec({ approval: "none" }), "q", context());
    expect(result.status).toBe("completed");
    expect(result.steps[0]?.error).toBe("RangeError: index offline");
    expect(result.steps[0]?.result).toBe("Error: RangeError: index offline");
  });

  test("step and token limits", async () => {
    const gw = gateway();
    const tools = new Tools(null);
    fake(gw, "cloud").script(TASK, call("search", { query: "a" }), call("search", { query: "b" }));
    let result = await new Runtime(gw, tools.registry(), prompts()).run(spec({ max_steps: 2 }), "q", context());
    expect(result.status).toBe("max_steps");
    expect(result.steps).toHaveLength(2);

    fake(gw, "cloud").script(TASK, call("search", { query: "a" }));
    // A different input, so the first step is not served from the response cache.
    result = await new Runtime(gw, tools.registry(), prompts()).run(spec({ max_tokens: 1 }), "q2", context());
    expect(result.status).toBe("budget_exceeded");
    expect(result.steps).toHaveLength(1);
  });

  test("gateway budget exhaustion stops the run", async () => {
    const gw = gateway();
    fake(gw, "cloud").script(TASK, call("search", { query: "word ".repeat(300) }));
    const ctx = context({}, { budget_key: "tenant:capped/collaboration" });
    const result = await new Runtime(gw, new Tools(null).registry(), prompts()).run(spec(), "q", ctx);
    expect(result.status).toBe("budget_exceeded");
    expect(result.steps.at(-1)?.kind).toBe("error");
  });

  test("agents must act on behalf of a person; services need not", async () => {
    const gw = gateway();
    const runtime = new Runtime(gw, new Tools().registry(), prompts());
    const { on_behalf_of: _, ...alone } = context().principal;
    await expect(runtime.run(spec(), "q", { ...context(), principal: alone })).rejects.toThrow(/on behalf of/);
    fake(gw, "cloud").script(TASK, final({ reply: "ok" }));
    const service = { id: "svc_01JC000000000000000000SVC1", kind: "service" as const, tenant_id: TENANT };
    const result = await runtime.run(spec({ approval: "none" }), "q", { ...context(), principal: service });
    expect(result.status).toBe("completed");
  });

  test("unknown tools in a spec are refused", async () => {
    const runtime = new Runtime(gateway(), new Tools().registry(), prompts());
    await expect(runtime.run(spec({ tools: ["search", "get_sop"] }), "q", context())).rejects.toThrow(/get_sop/);
  });

  test("replay returns recorded results without calling tools", async () => {
    const gw = gateway();
    const tools = new Tools();
    fake(gw, "cloud").script(TASK, call("search", { query: "hotel cap" }));
    fake(gw, "local").script(TASK, call("propose_edit", { block_key: "b_cap", text: "600" }), final({ reply: "done" }));
    const recorded = await new Runtime(gw, tools.registry(), prompts()).run(spec(), "q", context());
    const replayed = await new Runtime(gw, new ReplayTools([SEARCH, PROPOSE], recorded), prompts()).run(
      spec(),
      "q",
      context(),
    );

    expect(tools.calls).toHaveLength(2); // only the recorded run touched the real tools
    expect(replayed.steps.map((s) => s.result)).toEqual(recorded.steps.map((s) => s.result));
    expect(replayed.proposal_ids).toEqual(recorded.proposal_ids);
    // The replayed search result keeps its label, so every step routes as in the recorded run
    // and, with the same messages at temperature 0, is answered from the response cache.
    const records = usageOf(gw);
    const first = records.slice(0, recorded.steps.length);
    const again = records.slice(recorded.steps.length);
    expect(again.map((r) => r.sensitivity)).toEqual(first.map((r) => r.sensitivity));
    expect(new Set(again.map((r) => r.status))).toEqual(new Set(["cached"]));
  });

  test("replay keeps the label of a result cut at MAX_RESULT_CHARS", async () => {
    const READ: ToolSpec = { ...SEARCH, name: "read_document" };
    const secret = new ToolRegistry([
      new FunctionTool(READ, async () => ({ sensitivity: "secret", text: "SECRET".repeat(3000) })),
    ]);
    const run = (gw: Gateway, tools: ToolRegistry) =>
      new Runtime(gw, tools, prompts()).run(spec({ tools: ["read_document"] }), "q", context());
    const script = (gw: Gateway) => {
      fake(gw, "cloud").script(TASK, call("read_document", { query: "budget" }));
      fake(gw, "local").script(TASK, final({ reply: "done" }));
    };
    const gw = gateway();
    script(gw);
    const recorded = await run(gw, secret);
    const shown = recorded.steps[0]?.result as string;
    expect(shown.length).toBeGreaterThan(MAX_RESULT_CHARS);
    expect(() => JSON.parse(shown)).toThrow();
    expect(recorded.steps[0]?.sensitivity).toBe("secret");

    const again = gateway();
    script(again);
    const replayed = await run(again, new ReplayTools([READ], recorded));
    expect(usageOf(gw).map((r) => r.sensitivity)).toEqual(["internal", "secret"]);
    expect(usageOf(again).map((r) => r.sensitivity)).toEqual(["internal", "secret"]);
    expect(replayed.steps.map((s) => s.result)).toEqual(recorded.steps.map((s) => s.result));

    // A trace recorded before steps carried labels fails closed instead of falling back to the context.
    const unlabeled = { ...recorded, steps: recorded.steps.map(({ sensitivity: _, ...step }) => step) };
    const old = gateway();
    script(old);
    await run(old, new ReplayTools([READ], unlabeled));
    expect(usageOf(old).map((r) => r.sensitivity)).toEqual(["internal", "secret"]);
  });

  test("a tool labels text by returning a LabeledResult", async () => {
    const READ: ToolSpec = { ...SEARCH, name: "read_document" };
    const tools = new ToolRegistry([
      new FunctionTool(READ, async () => new LabeledResult("预算表：研发部 1,200 万元", "confidential")),
    ]);
    const gw = gateway();
    fake(gw, "cloud").script(TASK, call("read_document", { query: "budget" }));
    fake(gw, "local").script(TASK, final({ reply: "done" }));
    const result = await new Runtime(gw, tools, prompts()).run(spec({ tools: ["read_document"] }), "q", context());
    expect(result.steps[0]?.result).toBe("预算表：研发部 1,200 万元");
    expect(usageOf(gw).map((r) => r.sensitivity)).toEqual(["internal", "confidential"]);
  });

  test("the action schema is one flat object", () => {
    const schema = actionSchema(spec(), [SEARCH, PROPOSE]) as { properties: Record<string, Record<string, unknown>> };
    expect(JSON.stringify(schema)).not.toContain("oneOf");
    expect(schema.properties.tool).toEqual({ enum: ["search", "propose_edit"] });
    expect(schema.properties.output?.required).toEqual(["reply"]);
  });
});
