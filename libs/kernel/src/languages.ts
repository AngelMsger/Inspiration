/**
 * Language packs: the words, punctuation and patterns a component needs to read or write one
 * language, kept as data so that code holds none of them and supporting a language means
 * adding files, not code. A component keeps one YAML file per BCP 47 tag in its languages/
 * directory (languages/en.yaml, languages/zh.yaml, languages/ja.yaml); what a file holds is
 * the component's to define, and the accessors below check its shape as it is read.
 *
 * Documents carry no language tag yet, so a component reads every text with all its packs
 * together, and the packs are written not to collide: a Japanese cue word keeps its kana, so
 * it never matches Chinese text. Text a component writes takes the language of what it
 * answers, which languageOf guesses from the script until the tag arrives.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

export class LanguagePackError extends Error {
  override name = "LanguagePackError";
}

/** One language's part of a pack file, or a section of it. */
export class LanguagePack {
  readonly tag: string;
  readonly #fields: Readonly<Record<string, unknown>>;
  readonly #where: string;

  constructor(tag: string, fields: unknown, where = tag) {
    if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
      throw new LanguagePackError(`language pack ${where}: expected a mapping`);
    }
    this.tag = tag;
    this.#fields = fields as Record<string, unknown>;
    this.#where = where;
  }

  has(key: string): boolean {
    return this.#fields[key] !== undefined;
  }

  /** A list of strings; empty when the pack leaves it out. */
  list(key: string): string[] {
    const value = this.#fields[key] ?? [];
    if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
      throw new LanguagePackError(`language pack ${this.#where}: ${key} must be a list of strings`);
    }
    return value;
  }

  /** A string the pack must give. */
  text(key: string): string {
    const value = this.#fields[key];
    if (typeof value !== "string") throw new LanguagePackError(`language pack ${this.#where}: ${key} must be a string`);
    return value;
  }

  /** A number the pack must give. */
  number(key: string): number {
    const value = this.#fields[key];
    if (typeof value !== "number") throw new LanguagePackError(`language pack ${this.#where}: ${key} must be a number`);
    return value;
  }

  /** A yes or no; no when the pack leaves it out. */
  flag(key: string): boolean {
    const value = this.#fields[key] ?? false;
    if (typeof value !== "boolean")
      throw new LanguagePackError(`language pack ${this.#where}: ${key} must be true or false`);
    return value;
  }

  /** A mapping of strings to strings; empty when the pack leaves it out. */
  map(key: string): Record<string, string> {
    const value = this.#fields[key] ?? {};
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      !Object.values(value).every((v) => typeof v === "string")
    ) {
      throw new LanguagePackError(`language pack ${this.#where}: ${key} must map strings to strings`);
    }
    return value as Record<string, string>;
  }

  /** A nested mapping, read with the same accessors. */
  section(key: string): LanguagePack {
    return new LanguagePack(this.tag, this.#fields[key], `${this.#where}.${key}`);
  }

  /** A list of nested mappings; empty when the pack leaves it out. */
  sections(key: string): LanguagePack[] {
    const value = this.#fields[key] ?? [];
    if (!Array.isArray(value)) throw new LanguagePackError(`language pack ${this.#where}: ${key} must be a list`);
    return value.map((v, i) => new LanguagePack(this.tag, v, `${this.#where}.${key}[${i}]`));
  }
}

/**
 * The packs in dir, one per <tag>.yaml file, in tag order. Pass a file URL as it is
 * (`new URL("../languages/", import.meta.url)`): its pathname keeps percent escapes, so a
 * checkout under a path with spaces would not be found.
 */
export function loadLanguages(dir: string | URL): LanguagePack[] {
  const path = typeof dir === "string" ? dir : fileURLToPath(dir);
  return readdirSync(path)
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .map((f) => new LanguagePack(f.slice(0, -".yaml".length), parse(readFileSync(join(path, f), "utf8")), f));
}

const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HAN = /\p{Script=Han}/u;

/**
 * The language a text is most likely in, from its script alone: Japanese when it has kana,
 * Chinese when it has Han characters, English otherwise. A stand-in for the document's
 * language tag; Japanese written only in kanji reads as Chinese.
 */
export function languageOf(text: string): "en" | "ja" | "zh" {
  if (KANA.test(text)) return "ja";
  if (HAN.test(text)) return "zh";
  return "en";
}

const SPECIAL = /[.*+?^${}()|[\]\\]/g;
const LATIN_START = /^[\p{Script=Latin}\d]/u;
const LATIN_END = /[\p{Script=Latin}\d]$/u;

const BEFORE = "(?<![\\p{Script=Latin}\\d])";
const AFTER = "(?![\\p{Script=Latin}\\d])";

/**
 * A regular expression source, for the u flag, that matches any of the words. A word that
 * starts or ends with a Latin letter or a digit matches only whole there ("cap" not in
 * "capital"), since Latin script separates words and Han and kana do not.
 */
export function anyOf(words: readonly string[]): string {
  const one = (w: string) =>
    `${LATIN_START.test(w) ? BEFORE : ""}${w.replace(SPECIAL, "\\$&")}${LATIN_END.test(w) ? AFTER : ""}`;
  return words.length ? `(?:${words.map(one).join("|")})` : "(?!)";
}
