/**
 * The agent runtime: the loop every built-in agent runs on, with tool checks, step and token
 * limits, sensitivity tracking, approval gates, traces and replay.
 *
 *     const runtime = new Runtime(gateway, new ToolRegistry([...]), prompts, { runs: new PostgresRuns(pool) });
 *     const result = await runtime.run(spec, input, ctx);
 */

export * from "./migrations.ts";
export * from "./runs.ts";
export * from "./runtime.ts";
export * from "./tools.ts";
