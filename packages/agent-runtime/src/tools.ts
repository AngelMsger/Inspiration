import type { AgentResult, AgentRunContext, Tool, ToolSpec } from "@inspiration/contracts";

export class ToolRegistry {
  readonly #tools = new Map<string, Tool>();

  constructor(tools: readonly Tool[] = []) {
    for (const t of tools) this.add(t);
  }

  add(tool: Tool): void {
    if (this.#tools.has(tool.spec.name)) throw new RangeError(`tool ${tool.spec.name} is already registered`);
    this.#tools.set(tool.spec.name, tool);
  }

  get(name: string): Tool {
    const tool = this.#tools.get(name);
    if (!tool) throw new RangeError(`unknown tool ${name}`);
    return tool;
  }

  /** The specs of the named tools. Throws when a spec names a tool that is not registered. */
  specs(names: readonly string[]): ToolSpec[] {
    const missing = names.filter((n) => !this.#tools.has(n));
    if (missing.length) throw new RangeError(`unknown tools: ${missing.join(", ")}`);
    return names.map((n) => this.get(n).spec);
  }
}

/** A tool from a spec and an async function. */
export class FunctionTool implements Tool {
  readonly spec: ToolSpec;
  readonly #fn: (args: Record<string, unknown>, ctx: AgentRunContext) => Promise<unknown>;

  constructor(spec: ToolSpec, fn: (args: Record<string, unknown>, ctx: AgentRunContext) => Promise<unknown>) {
    this.spec = spec;
    this.#fn = fn;
  }

  run(args: Record<string, unknown>, ctx: AgentRunContext): Promise<unknown> {
    return this.#fn(args, ctx);
  }
}

/**
 * Tools that return the results recorded in an earlier run, in order, so a prompt or model
 * change can be evaluated against the same tool outputs. Recorded results that are JSON
 * objects are decoded again, so their sensitivity label still applies.
 */
export class ReplayTools extends ToolRegistry {
  constructor(specs: readonly ToolSpec[], recorded: AgentResult) {
    super();
    const results = new Map<string, unknown[]>();
    for (const step of recorded.steps) {
      if (step.kind !== "tool_call" || !step.tool) continue;
      results.set(step.tool, [...(results.get(step.tool) ?? []), step.result]);
    }
    for (const spec of specs) {
      const queue = [...(results.get(spec.name) ?? [])];
      this.add(
        new FunctionTool(spec, async () => {
          if (!queue.length) throw new RangeError(`no recorded result left for ${spec.name}`);
          const value = queue.shift();
          if (typeof value === "string" && value.startsWith("{")) {
            try {
              return JSON.parse(value);
            } catch {
              // a truncated or non-JSON result is replayed as text
            }
          }
          return value;
        }),
      );
    }
  }
}
