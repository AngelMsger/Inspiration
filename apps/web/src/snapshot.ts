#!/usr/bin/env node
/**
 * pnpm snapshot <dir> [--corpus examples/corpus] [--today YYYY-MM-DD] [--gateway <file> [--valkey <url>]]
 *
 * Records the demo script (<corpus>/script.yaml) and builds a snapshot of the web app into
 * <dir>: index.html, its assets and snapshot.json, a static page that answers from the
 * recording (replay.ts) and guides a visitor through the script (guide.tsx), so anyone can
 * walk it without the engine. It runs the engine over a copy of the corpus with the
 * development models, as pnpm demo does, with the web app's backend in front (backend.ts), or
 * with the models a --gateway file configures (engine serve), such as config/gateway.demo.yaml,
 * where DeepSeek writes the answers; the guide then names the model the config prefers for them. A script step
 * may put its question in each language, so answers come in the language the page shows.
 * As each person it reads everything the page can show; then it takes the script's next
 * action and reads again, so every action leads to a recorded state. The engine takes the
 * day given, else today, as its day while it records.
 *
 * The snapshot holds what every person of the tenant could read, for whoever opens it: acting
 * as someone in it is a simulation, not access control. Record only a corpus whose whole
 * contents its recipients may read, such as the synthetic demo corpus.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { DocumentTree, DocumentTreeNode } from "@inspiration/contracts";
import { build, type Plugin } from "vite";
import { parse } from "yaml";
import { api, loadLibrary } from "./api.ts";
import { backend, loadPeople } from "./backend.ts";
import { callKey, type Recording, type Reply, type ScriptStep } from "./replay.ts";
import { Updates } from "./updates.ts";

const SERVE = fileURLToPath(new URL("../../engine/src/serve.ts", import.meta.url));
const CONFIG = fileURLToPath(new URL("../vite.config.ts", import.meta.url));
const ENGINE_PORT = 4199;
const fetchFromNetwork = globalThis.fetch;

/** The script file: steps, each taken by a member, starting at an address. */
export function loadScript(text: string): ScriptStep[] {
  const steps = (parse(text) as { steps?: ScriptStep[] } | null)?.steps ?? [];
  const address = (a: unknown) => typeof a === "string" && a.startsWith("/");
  const opens = (open: unknown) =>
    address(open) ||
    (typeof open === "object" && open !== null && Object.keys(open).length > 0 && Object.values(open).every(address));
  const valid = (s: ScriptStep) => typeof s?.as === "string" && opens(s.open) && typeof s.text === "object";
  if (!steps.length || !steps.every(valid))
    throw new RangeError("script.yaml does not list steps with as, open and text");
  return steps;
}

/** The questions a script asks: its steps that open the ask page, in each language they are put in. */
export function questionsOf(steps: readonly ScriptStep[]): string[] {
  const addresses = steps.flatMap((s) => (typeof s.open === "string" ? [s.open] : Object.values(s.open)));
  const asked = addresses.flatMap((a) => new URL(a, "http://page").searchParams.get("q") ?? []);
  return [...new Set(asked)];
}

/**
 * The model a gateway config prefers for answers, unless that is a development stand-in. It is
 * the config's preference, not a record of each answer: one goes to another model on a
 * retryable error, or when its content is more sensitive than the model is cleared for.
 */
export function answerModel(config: string): string | undefined {
  const { providers = [], routes = [] } = (parse(config) ?? {}) as {
    providers?: { name: string; kind: string }[];
    routes?: { match: string; prefer?: string[] }[];
  };
  const literal = (part: string) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const glob = (match: string) => new RegExp(`^${match.split("*").map(literal).join(".*")}$`);
  const ref = routes.find((r) => glob(r.match).test("retrieval.answer_question"))?.prefer?.[0];
  const [provider, model] = ref?.split("/") ?? [];
  return providers.find((p) => p.name === provider && p.kind !== "fake") ? model : undefined;
}

function documentsOf(tree: DocumentTree): { source: string; item: string }[] {
  const walk = (node: DocumentTreeNode): { source: string; item: string }[] => [
    ...(node.document ? [{ source: node.document.source_id, item: node.document.external_id }] : []),
    ...(node.children ?? []).flatMap(walk),
  ];
  return tree.sources.flatMap(walk);
}

/** Records every call the page makes through a backend, under the state and member it is in. */
class Recorder {
  readonly bodies: Record<string, unknown> = {};
  readonly states: Record<string, Record<string, Reply>>[] = [{}];
  member = "";
  readonly #backend: string;

  constructor(backendUrl: string) {
    this.#backend = backendUrl;
  }

  /** fetch as the page's api.ts calls it (/api/...), through the backend as the current member. */
  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (typeof input !== "string" || !input.startsWith("/api/")) return fetchFromNetwork(input, init);
    const path = input;
    const body = typeof init?.body === "string" ? init.body : undefined;
    const res = await fetchFromNetwork(`${this.#backend}${path}`, {
      ...init,
      headers: { ...(init?.headers as Record<string, string>), cookie: `inspiration_member=${this.member}` },
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as unknown) : null;
    const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
    this.bodies[hash] = json;
    const state = this.states.at(-1) as Record<string, Record<string, Reply>>;
    state[this.member] ??= {};
    (state[this.member] as Record<string, Reply>)[callKey(init?.method ?? "GET", path.slice("/api".length), body)] = {
      status: res.status,
      body: hash,
    };
    return new Response(text, { status: res.status, headers: res.headers });
  };

  /** Mark the last call as the action that leads to a new state, and start that state. */
  advance(): void {
    const calls = this.states.at(-1)?.[this.member] ?? {};
    const last = Object.keys(calls).at(-1);
    if (last) (calls[last] as Reply).next = this.states.length;
    this.states.push({});
  }

  /** The source versions what this member read in this state names, not yet read themselves. */
  versionsToRead(): string[] {
    const calls = this.states.at(-1)?.[this.member] ?? {};
    const named = new Set<string>();
    for (const reply of Object.values(calls)) {
      for (const m of JSON.stringify(this.bodies[reply.body]).matchAll(/"(sv_[0-9A-Z]{26})"/g))
        named.add(m[1] as string);
    }
    const read = new Set(Object.keys(calls).flatMap((k) => k.match(/[?&]version=(sv_[0-9A-Z]{26})/)?.[1] ?? []));
    return [...named].filter((v) => !read.has(v)).sort();
  }
}

/** Read, as the recorder's member, everything the page can show them. */
async function readAll(recorder: Recorder, questions: readonly string[]): Promise<void> {
  const library = await loadLibrary();
  await api.inbox();
  await api.updates();
  const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
  for (const space of library.spaces) await quietly(api.overview(space.id));
  for (const list of library.topics.values()) for (const t of list.topics) await api.topic(t.key);
  for (const tree of library.trees.values()) for (const d of documentsOf(tree)) await api.document(d);
  for (const q of questions) {
    await quietly(api.answer(q));
    await quietly(api.search(q));
  }
  // A citation opens the version it names; so does a version a document view links to.
  for (let versions = recorder.versionsToRead(); versions.length; versions = recorder.versionsToRead()) {
    for (const version of versions) await quietly(api.document({ version }));
  }
}

/** Take a step's action as its member: confirm a todo's suggestion, or put in an upstream edit. */
async function act(step: ScriptStep): Promise<void> {
  if (step.do?.update) {
    await api.putUpdate(step.do.update);
    return;
  }
  const slot = step.do?.resolve;
  const todo = (await api.inbox()).cards.flatMap((c) => c.todos).find((t) => t.todo.slot_key === slot);
  const suggested = todo?.choices[0]?.key;
  if (!todo || !suggested) throw new RangeError(`${step.as} has no todo about ${slot} to decide`);
  await api.resolve(todo.todo.id, { with: suggested });
}

async function healthy(url: string, engine: ChildProcess): Promise<void> {
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    if (engine.exitCode !== null) throw new Error("the engine stopped before it served");
    if (
      await fetch(url).then(
        (r) => r.ok,
        () => false,
      )
    )
      return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`the engine did not answer at ${url}`);
}

/** The built page starts from recorded.tsx, which answers from snapshot.json. */
const snapshotPage: Plugin = {
  name: "inspiration-snapshot-page",
  // Before Vite bundles the page's entry, so that the entry is recorded.tsx.
  transformIndexHtml: { order: "pre", handler: (html) => html.replace("/src/main.tsx", "/src/recorded.tsx") },
};

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      corpus: { type: "string", default: "examples/corpus" },
      today: { type: "string" },
      gateway: { type: "string" },
      valkey: { type: "string" },
    },
  });
  const out = positionals[0];
  if (!out)
    throw new RangeError(
      "usage: pnpm snapshot <dir> [--corpus examples/corpus] [--today YYYY-MM-DD] [--gateway <file> [--valkey <url>]]",
    );
  const steps = loadScript(await readFile(join(values.corpus, "script.yaml"), "utf8"));
  const questions = questionsOf(steps);
  const copy = await mkdtemp(join(tmpdir(), "inspiration-snapshot-"));
  await cp(resolve(values.corpus), copy, { recursive: true });
  const people = loadPeople(join(copy, "people.yaml"));
  // The engine's clock stands still while it records, so a page that does not change between
  // people and steps is the same body, stored once, and not one per instant it was read.
  const today = values.today ?? new Date().toISOString().slice(0, 10);
  const models = values.gateway ? ["--gateway", resolve(values.gateway)] : [];
  if (values.valkey) models.push("--valkey", values.valkey);
  const answerer = values.gateway ? answerModel(await readFile(values.gateway, "utf8")) : undefined;
  const serve = [SERVE, "serve", copy, "--dev-identity", "--port", String(ENGINE_PORT), "--today", today, ...models];
  const engine = spawn(process.execPath, serve, {
    stdio: "inherit",
    env: { INSPIRATION_LOG_LEVEL: "warn", ...process.env },
  });
  let server: Server | undefined;
  try {
    console.log(`reading ${values.corpus} with the models of ${values.gateway ?? "the development stand-ins"}…`);
    await healthy(`http://127.0.0.1:${ENGINE_PORT}/v0/health`, engine);
    const middleware = backend({ engine: `http://127.0.0.1:${ENGINE_PORT}`, ...people, updates: new Updates(copy) });
    server = createServer((req, res) => void middleware(req, res, () => res.writeHead(404).end()));
    await new Promise<void>((done) => server?.listen(0, "127.0.0.1", done));
    const recorder = new Recorder(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    globalThis.fetch = recorder.fetch as typeof fetch;
    const readEveryone = async () => {
      for (const person of people.people) {
        recorder.member = person.member;
        await readAll(recorder, questions);
      }
    };
    await readEveryone();
    for (const step of steps.filter((s) => s.do)) {
      recorder.member = step.as;
      await act(step);
      recorder.advance();
      await readEveryone();
      console.log(`recorded state ${recorder.states.length - 1}: ${step.do?.resolve ?? step.do?.update}`);
    }
    const recording: Recording = {
      recorded_at: new Date().toISOString(),
      day: today,
      people,
      steps,
      questions,
      ...(answerer && { answer_model: answerer }),
      bodies: recorder.bodies,
      states: recorder.states,
    };
    await build({
      configFile: CONFIG,
      base: "./",
      logLevel: "warn",
      plugins: [snapshotPage],
      build: { outDir: resolve(out), emptyOutDir: true, target: "es2022" },
    });
    const json = JSON.stringify(recording);
    await writeFile(join(out, "snapshot.json"), json);
    console.log(
      `${out}: ${recording.states.length} states, ${Object.keys(recording.bodies).length} bodies, ${Math.round(json.length / 1024)} KB`,
    );
  } finally {
    server?.close();
    engine.kill("SIGTERM");
    await rm(copy, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
