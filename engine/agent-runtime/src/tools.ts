import {
  type AgentResult,
  type AgentRunContext,
  SENSITIVITY_ORDER,
  type SensitivityLabel,
  type Tool,
  type ToolSpec,
} from "@inspiration/contracts";

/**
 * A tool result with its label kept apart from the value, for results that cannot carry a
 * "sensitivity" field, such as text. The runtime gives the model only the value.
 */
export class LabeledResult {
  readonly value: unknown;
  readonly sensitivity: SensitivityLabel;

  constructor(value: unknown, sensitivity: SensitivityLabel) {
    this.value = value;
    this.sensitivity = sensitivity;
  }
}

/** The sensitivity label a tool put on its result, if any. */
export function labelOf(result: unknown): SensitivityLabel | undefined {
  if (result instanceof LabeledResult) return result.sensitivity;
  const label =
    typeof result === "object" && result !== null ? (result as { sensitivity?: unknown }).sensitivity : undefined;
  return typeof label === "string" && label in SENSITIVITY_ORDER ? (label as SensitivityLabel) : undefined;
}

/** The label a replay assumes for a recorded result that has none: the highest. */
const UNLABELED: SensitivityLabel = "secret";

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
 * objects are decoded again, and each comes back with the label its step recorded, which
 * survives truncation. A step recorded without a label (an older trace) fails closed: the
 * decoded result's own label if it is intact, otherwise the highest.
 */
export class ReplayTools extends ToolRegistry {
  constructor(specs: readonly ToolSpec[], recorded: AgentResult) {
    super();
    const results = new Map<string, AgentResult["steps"]>();
    for (const step of recorded.steps) {
      if (step.kind !== "tool_call" || !step.tool) continue;
      results.set(step.tool, [...(results.get(step.tool) ?? []), step]);
    }
    for (const spec of specs) {
      const queue = [...(results.get(spec.name) ?? [])];
      this.add(
        new FunctionTool(spec, async () => {
          const step = queue.shift();
          if (!step) throw new RangeError(`no recorded result left for ${spec.name}`);
          const value = decode(step.result);
          return new LabeledResult(value, step.sensitivity ?? labelOf(value) ?? UNLABELED);
        }),
      );
    }
  }
}

function decode(value: unknown): unknown {
  if (typeof value === "string" && value.startsWith("{")) {
    try {
      return JSON.parse(value);
    } catch {
      // a truncated or non-JSON result is replayed as text
    }
  }
  return value;
}
