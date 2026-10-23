/**
 * Prompt registry. Prompts are versioned files; the version is part of every model call and
 * of every artifact's inputs hash, so changing a prompt shows exactly what to rebuild.
 *
 * A prompt file (YAML):
 *
 *     task: extraction.extract_claims
 *     version: claims@2
 *     system: |
 *       You extract atomic claims...
 *     user: |
 *       Document: {{title}}
 *       {{chunk}}
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type ChatMessage, contentHash } from "@inspiration/contracts";
import { parse } from "yaml";

const VAR = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

export class Prompt {
  readonly task: string;
  readonly version: string;
  readonly user: string;
  readonly system: string | undefined;

  constructor(fields: { task: string; version: string; user: string; system?: string }) {
    this.task = fields.task;
    this.version = fields.version;
    this.user = fields.user;
    this.system = fields.system;
  }

  get hash(): string {
    return contentHash(JSON.stringify([this.task, this.version, this.system ?? null, this.user]));
  }

  /** The messages with every {{name}} filled in. Values that are not strings are written as JSON. */
  render(variables: Readonly<Record<string, unknown>> = {}): ChatMessage[] {
    const fill = (template: string) =>
      template.replace(VAR, (_, name: string) => {
        if (!(name in variables)) {
          throw new RangeError(`prompt ${this.task}@${this.version}: missing variable ${name}`);
        }
        const v = variables[name];
        return typeof v === "string" ? v : JSON.stringify(v);
      });
    const messages: ChatMessage[] = [];
    if (this.system) messages.push({ role: "system", content: fill(this.system) });
    messages.push({ role: "user", content: fill(this.user) });
    return messages;
  }

  equals(other: Prompt): boolean {
    return this.hash === other.hash;
  }
}

function yamlFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .map((f) => join(dir, f));
}

export class PromptRegistry {
  readonly #prompts = new Map<string, Prompt>();

  register(prompt: Prompt): void {
    const key = `${prompt.task}\0${prompt.version}`;
    const known = this.#prompts.get(key);
    if (known && !known.equals(prompt)) {
      throw new RangeError(`prompt ${prompt.task} ${prompt.version} is already registered with different text`);
    }
    this.#prompts.set(key, prompt);
  }

  /** Register every *.yaml file under dir. */
  loadDir(dir: string): void {
    for (const file of yamlFiles(dir)) {
      const doc = parse(readFileSync(file, "utf8")) as { task: string; version: string; user: string; system?: string };
      this.register(new Prompt(doc));
    }
  }

  get(task: string, version: string): Prompt {
    const prompt = this.#prompts.get(`${task}\0${version}`);
    if (!prompt) throw new RangeError(`no prompt ${task} ${version}`);
    return prompt;
  }

  render(task: string, version: string, variables: Readonly<Record<string, unknown>> = {}): ChatMessage[] {
    return this.get(task, version).render(variables);
  }
}
