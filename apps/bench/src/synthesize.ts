/**
 * A synthetic tenant for scale runs: a company of ten departments whose policies,
 * guidelines, FAQs, meeting notes, weekly reports and project documents state a known set
 * of facts (hotel caps, annual leave days, purchase approval limits, ...). Most documents
 * state a fact's current value; some state a stale or wrong one, meeting notes record
 * decisions that change a value, the archive keeps older policy editions, and a shared
 * folder holds copies.
 *
 * Next to the corpus it writes truth.json: which document states which fact with which
 * value and why (current, stale, wrong, decision, superseded). Extraction, conflict
 * detection and topic clustering can be measured against it, which hand-written test data
 * cannot do at this size. Generation is deterministic for a seed.
 *
 * The tenant's names, departments, facts and the text of its documents come from a pack in
 * languages/ (zh, the only one that has a tenant so far); this file holds the shape of the corpus and the draws.
 */

import { mkdir, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ClaimValueKind, GovernanceLevel } from "@inspiration/contracts";
import type { CorpusManifest } from "@inspiration/engine";
import type { PredicateEntry, Vocabulary } from "@inspiration/extraction";
import { type LanguagePack, loadLanguages } from "@inspiration/kernel";
import { stringify } from "yaml";

interface Fact {
  key: string;
  department: string;
  topic: string;
  value: string;
  alternatives: string[];
  /** Sentences stating the fact; {value} is the value. */
  say: string[];
}

interface Slot {
  predicate: string;
  label: string;
  aliases: string[];
  qualifier?: { name: string; aliases: string[] };
  value: PredicateEntry["value"];
}

type Places = Record<"policies" | "teams" | "archive" | "shared", string>;

/** A synthetic tenant in one language, as its pack describes it. */
interface Tenant {
  name: string;
  /** The language tag its documents carry. */
  language: string;
  spaces: Record<"policies" | "teams", string>;
  /** Source names and the folders they read. */
  sources: Places;
  roots: Places;
  /** Department names, in order, and their directory groups. */
  departments: Record<string, string>;
  surnames: string[];
  given: string[];
  projects: string[];
  work: string[];
  /** Templates of the documents' text. */
  text: LanguagePack;
  /** Articles every policy has in some form. */
  boilerplate: string[];
  fillers: string[];
  facts: Fact[];
  /** How the tenant's predicate catalogue names each fact, by fact key. */
  slots: Record<string, Slot>;
}

const PACKS = loadLanguages(new URL("../languages/", import.meta.url)).filter((p) => p.has("tenant"));

function places(pack: LanguagePack, key: string): Places {
  const p = pack.section(key);
  return { policies: p.text("policies"), teams: p.text("teams"), archive: p.text("archive"), shared: p.text("shared") };
}

function slotOfPack(pack: LanguagePack, fact: Fact): Slot {
  const v = pack.section("value");
  const kind = v.text("kind") as ClaimValueKind;
  const value: PredicateEntry["value"] =
    kind === "enum"
      ? { kind, values: [fact.value, ...fact.alternatives] }
      : {
          kind,
          ...(v.has("unit") && { unit: v.text("unit") }),
          ...(v.has("currency") && { currency: v.text("currency") }),
          ...(v.has("words") && { words: v.list("words") }),
        };
  const slot: Slot = {
    predicate: pack.text("predicate"),
    label: pack.text("label"),
    aliases: pack.list("aliases"),
    value,
  };
  if (pack.has("qualifier")) {
    const q = pack.section("qualifier");
    slot.qualifier = { name: q.text("name"), aliases: q.list("aliases") };
  }
  return slot;
}

/** The synthetic tenant written in a language. */
export function tenantIn(language: string): Tenant {
  const pack = PACKS.find((p) => p.tag === language);
  if (!pack)
    throw new RangeError(`no synthetic tenant in ${language}; there is one in ${PACKS.map((p) => p.tag).join(", ")}`);
  const facts: Fact[] = [];
  const slots: Record<string, Slot> = {};
  for (const f of pack.sections("facts")) {
    const fact: Fact = {
      key: f.text("key"),
      department: f.text("department"),
      topic: f.text("topic"),
      value: f.text("value"),
      alternatives: f.list("alternatives"),
      say: f.list("say"),
    };
    facts.push(fact);
    slots[fact.key] = slotOfPack(f.section("slot"), fact);
  }
  const spaces = pack.section("spaces");
  return {
    name: pack.text("tenant"),
    language: pack.text("language"),
    spaces: { policies: spaces.text("policies"), teams: spaces.text("teams") },
    sources: places(pack, "sources"),
    roots: places(pack, "roots"),
    departments: pack.map("departments"),
    surnames: [...pack.text("surnames")],
    given: [...pack.text("given")],
    projects: pack.list("projects"),
    work: pack.list("work"),
    text: pack.section("text"),
    boilerplate: pack.list("boilerplate"),
    fillers: pack.list("fillers"),
    facts,
    slots,
  };
}

/** The template with every {name} filled in. */
function fill(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = values[name];
    if (value === undefined) throw new RangeError(`no value for {${name}} in ${JSON.stringify(template)}`);
    return String(value);
  });
}

/** The slot key of a fact, as extraction's slotOf writes it. */
export function slotOfFact(tenant: Tenant, key: string): string {
  const slot = tenant.slots[key];
  if (!slot) throw new RangeError(`no slot for fact ${key}`);
  return slot.qualifier ? `${slot.predicate}|${slot.qualifier.name}` : slot.predicate;
}

/** The catalogue the synthetic tenant gives extraction: one entry per predicate. */
export function vocabulary(tenant: Tenant): Vocabulary {
  const entries = new Map<string, PredicateEntry>();
  for (const slot of Object.values(tenant.slots)) {
    const entry = entries.get(slot.predicate) ?? {
      predicate: slot.predicate,
      label: slot.label,
      knowledge_class: "policy",
      aliases: [],
      value: slot.value,
    };
    entry.aliases = [...new Set([...entry.aliases, ...slot.aliases])];
    if (slot.qualifier) entry.qualifiers = [...(entry.qualifiers ?? []), slot.qualifier];
    if (slot.value.values)
      entry.value = { ...entry.value, values: [...new Set([...(entry.value.values ?? []), ...slot.value.values])] };
    entries.set(slot.predicate, entry);
  }
  return { predicates: [...entries.values()] };
}

/**
 * A department's knowledge staff: three people, the first its policy owner, who write its
 * guides. They are the directory's members, so topics can get owners.
 */
export function staffOf(tenant: Tenant, department: string): string[] {
  const i = Object.keys(tenant.departments).indexOf(department);
  const { surnames, given } = tenant;
  return [0, 1, 2].map((j) => `${surnames[(3 * i + j) % surnames.length]}${given[(7 * i + 5 * j + 1) % given.length]}`);
}

/** mulberry32: small, fast, and the same everywhere for a seed. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Stated {
  document: string;
  fact: string;
  value: string;
  stance: "current" | "stale" | "wrong" | "decision" | "superseded";
  /** A decision's effective day, YYYY-MM-DD. */
  from?: string;
}

export interface SynthesisOptions {
  documents: number;
  seed?: number;
  /** Share of non-policy fact statements that use another value. */
  errorRate?: number;
  /** The language of the tenant's pack. */
  language?: string;
}

export interface Synthesis {
  documents: number;
  statements: number;
  duplicates: { document: string; of: string; exact: boolean }[];
}

const FILLER = /\{(\w+)(?::(\d+)-(\d+))?\}/g;

class Writer {
  readonly tenant: Tenant;
  readonly rand: () => number;
  readonly truth: Stated[] = [];
  readonly duplicates: Synthesis["duplicates"] = [];
  readonly files = new Map<string, string>();
  /** When each file last changed in the source, YYYY-MM-DD: set as its mtime. */
  readonly modified = new Map<string, string>();

  constructor(tenant: Tenant, seed: number) {
    this.tenant = tenant;
    this.rand = prng(seed);
  }

  /** The tenant's template under key, filled in. */
  say(key: string, values: Readonly<Record<string, string | number>> = {}): string {
    return fill(this.tenant.text.text(key), values);
  }

  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.rand() * xs.length)] as T;
  }

  int(lo: number, hi: number): number {
    return lo + Math.floor(this.rand() * (hi - lo + 1));
  }

  person(): string {
    const { surnames, given } = this.tenant;
    return this.pick(surnames) + this.pick(given) + (this.rand() < 0.5 ? this.pick(given) : "");
  }

  /** A day as the tenant writes it. */
  written(year: string | number, month: number, day: number): string {
    return this.say("date", { year, month, day });
  }

  /** A day of 2026 in the month, written and as YYYY-MM-DD. */
  day(month = this.int(1, 9)): { written: string; iso: string } {
    const day = this.int(1, 28);
    return { written: this.written(2026, month, day), iso: `2026-${pad(month)}-${pad(day)}` };
  }

  date(month?: number): string {
    return this.day(month).written;
  }

  state(document: string, fact: Fact, stance: Stated["stance"], value = fact.value): string {
    this.truth.push({ document, fact: fact.key, value, stance });
    return fill(this.pick(fact.say), { value });
  }

  /** A fact statement in a non-policy document: mostly current, sometimes stale or wrong. */
  hearsay(document: string, fact: Fact, errorRate: number): string {
    if (this.rand() >= errorRate) return this.state(document, fact, "current");
    return this.state(document, fact, this.rand() < 0.5 ? "stale" : "wrong", this.pick(fact.alternatives));
  }

  /** A sentence of everyday work, its draws made in the order the template names them. */
  filler(): string {
    const project = this.pick(this.tenant.projects);
    const form = this.pick(this.tenant.fillers);
    return form.replace(FILLER, (_, name: string, lo?: string, hi?: string) => {
      if (name === "project") return project;
      if (name === "work") return this.pick(this.tenant.work);
      if (name === "person") return this.person();
      if (name === "int" && lo && hi) return String(this.int(Number(lo), Number(hi)));
      if (name === "date") return lo && hi ? this.date(this.int(Number(lo), Number(hi))) : this.date();
      throw new RangeError(`no value for {${name}} in filler ${JSON.stringify(form)}`);
    });
  }

  fillers(n: number): string[] {
    return Array.from({ length: n }, () => this.filler());
  }

  write(path: string, text: string, modified: string): void {
    this.files.set(path, text);
    this.modified.set(path, modified);
  }
}

const pad = (n: number) => String(n).padStart(2, "0");

/** FNV-1a: a day offset that depends on the path only, so file dates do not move the random draws. */
function hashOf(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

function dayAfter(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function frontMatter(fields: Record<string, unknown>): string {
  return `---\n${stringify(fields).trimEnd()}\n---\n`;
}

export async function synthesize(dir: string, options: SynthesisOptions): Promise<Synthesis> {
  const tenant = tenantIn(options.language ?? "zh");
  const { roots } = tenant;
  const w = new Writer(tenant, options.seed ?? 1);
  const text = (key: string) => tenant.text.text(key);
  const factsOf = (department: string) => tenant.facts.filter((f) => f.department === department);
  const errorRate = options.errorRate ?? 0.15;
  const departments = Object.keys(tenant.departments);
  const target = options.documents;
  let made = 0;
  const policies: { path: string; text: string; department: string }[] = [];

  // One policy per department and topic first: the reference every other document is measured against.
  for (const department of departments) {
    const topics = [...new Set(factsOf(department).map((f) => f.topic))];
    for (const topic of topics) {
      if (made >= target) break;
      const title = w.say("policy_title", { topic });
      const path = `${roots.policies}/${department}/${title}.md`;
      const facts = factsOf(department).filter((f) => f.topic === topic);
      const boilerplate = tenant.boilerplate.map((t) => fill(t, { department, topic }));
      const articles = [
        ...tenant.text.list("policy_opening").map((t) => fill(t, { department, topic })),
        ...facts.map((f) => w.state(path, f, "current")),
        ...boilerplate.slice(0, w.int(5, boilerplate.length)),
        w.say("policy_closing", { date: w.written(2026, 1, 1) }),
      ];
      const owner = staffOf(tenant, department)[0];
      const body = `${frontMatter({ title, governance_level: "governed", approval_state: "approved", owner })}# ${title}\n\n${articles.map((a, i) => w.say("article", { n: i + 1, text: a })).join("\n\n")}\n`;
      // Policies were last edited in December, before they took effect.
      w.write(path, body, dayAfter("2025-12-01", hashOf(path) % 28));
      policies.push({ path, text: body, department });
      made++;
    }
  }

  // The rest, by kind, until the target is reached.
  const kinds: [string, number][] = [
    ["guide", 0.12],
    ["faq", 0.1],
    ["minutes", 0.3],
    ["weekly", 0.3],
    ["project", 0.12],
    ["copy", 0.03],
    ["edition", 0.03],
  ];
  const counters = new Map<string, number>();
  while (made < target) {
    const kind = pickWeighted(kinds, w.rand());
    const department = w.pick(departments);
    const n = (counters.get(`${kind}:${department}`) ?? 0) + 1;
    counters.set(`${kind}:${department}`, n);
    const facts = factsOf(department);
    let path: string;
    let body: string;
    let modified: string;
    if (kind === "guide" || kind === "faq") {
      const title = w.say(kind === "guide" ? "guide_title" : "faq_title", { department, n });
      path = `${roots.teams}/${department}/${text(kind === "guide" ? "guide_folder" : "faq_folder")}/${title}.md`;
      const sections = Array.from({ length: w.int(4, 10) }, () => {
        const f = w.pick(facts);
        const said = [w.hearsay(path, f, errorRate), ...w.fillers(w.int(1, 4))].join("");
        return `## ${kind === "faq" ? w.say("faq_heading", { topic: f.topic }) : f.topic}\n\n${said}`;
      });
      const owner = kind === "guide" ? w.pick(staffOf(tenant, department)) : w.person();
      body = `${frontMatter({ title, governance_level: kind === "guide" ? "governed" : "reference", owner })}# ${title}\n\n${sections.join("\n\n")}\n`;
      modified = dayAfter("2024-10-23", hashOf(path) % 730);
    } else if (kind === "minutes") {
      const month = w.int(1, 10);
      const title = w.say("minutes_title", { department, month, n });
      path = `${roots.teams}/${department}/${text("minutes_folder")}/${title}.md`;
      const items = w.fillers(w.int(5, 12));
      // A decision changes a fact; later documents may or may not follow it.
      if (w.rand() < 0.15 && facts.length) {
        const f = w.pick(facts);
        const value = w.pick(f.alternatives);
        const from = Math.min(12, month + 1);
        w.truth.push({ document: path, fact: f.key, value, stance: "decision", from: `2026-${pad(from)}-01` });
        const statement = fill(w.pick(f.say), { value });
        items.push(w.say("decision", { date: w.written(2026, from, 1), topic: f.topic, statement }));
      } else if (w.rand() < 0.4 && facts.length) items.push(w.hearsay(path, w.pick(facts), errorRate));
      const owner = w.person();
      const held = w.day(month);
      modified = held.iso;
      const people = Array.from({ length: w.int(3, 8) }, () => w.person()).join(text("list_mark"));
      body = `${frontMatter({ title, governance_level: "reference", owner, date: modified })}# ${title}\n\n${w.say("minutes_held", { date: held.written })}\n${w.say("minutes_attendees", { people })}\n\n## ${text("minutes_items")}\n\n${items.map((t, i) => `${i + 1}. ${t}`).join("\n")}\n\n## ${text("minutes_todos")}\n\n${Array.from({ length: w.int(1, 4) }, () => `- ${w.filler()}`).join("\n")}\n`;
    } else if (kind === "weekly") {
      const project = w.pick(tenant.projects);
      const title = w.say("weekly_title", { project, department, n });
      path = `${roots.teams}/${department}/${text("weekly_folder")}/${title}.md`;
      const rows = Array.from(
        { length: w.int(2, 6) },
        () => `| ${w.pick(tenant.work)} | ${w.person()} | ${w.int(0, 100)}% |`,
      );
      const columns = tenant.text.list("weekly_columns");
      const table = `| ${columns.join(" | ")} |\n| ${columns.map(() => "---").join(" | ")} |\n${rows.join("\n")}`;
      // Reports of one department and number fall in one of the year's first 42 weeks, on its Friday.
      modified = dayAfter("2026-01-09", 7 * ((n - 1) % 42));
      const owner = w.person();
      const progress = w
        .fillers(w.int(6, 15))
        .map((t) => `- ${t}`)
        .join("\n");
      const risks = `${w.filler()}${w.rand() < 0.2 && facts.length ? w.hearsay(path, w.pick(facts), errorRate) : ""}`;
      body = `${frontMatter({ title, governance_level: "search_only", owner, date: modified })}# ${title}\n\n## ${text("weekly_progress")}\n\n${progress}\n\n${table}\n\n## ${text("weekly_risks")}\n\n${risks}\n`;
    } else if (kind === "project") {
      const project = w.pick(tenant.projects);
      const title = w.say("project_title", { project, department, n });
      path = `${roots.teams}/${department}/${text("project_folder")}/${title}.md`;
      const parts = Array.from(
        { length: w.int(3, 6) },
        (_, i) =>
          `## ${i + 1}. ${w.pick(tenant.work)}\n\n${Array.from({ length: w.int(2, 6) }, () => w.filler()).join("")}`,
      );
      body = `${frontMatter({ title, governance_level: "reference", owner: w.person() })}# ${title}\n\n${parts.join("\n\n")}\n`;
      modified = dayAfter("2024-10-23", hashOf(path) % 730);
    } else if (kind === "copy" && policies.length) {
      const source = w.pick(policies);
      path = `${roots.shared}/${department}/${w.say("copy", { name: source.path.split("/").at(-1) as string })}`;
      if (w.files.has(path)) continue;
      body = source.text.replace("governance_level: governed", "governance_level: reference");
      modified = dayAfter(w.modified.get(source.path) as string, 1 + (hashOf(path) % 20));
      for (const t of w.truth.filter((s) => s.document === source.path)) w.truth.push({ ...t, document: path });
      w.duplicates.push({ document: path, of: source.path, exact: true });
    } else if (kind === "edition" && policies.length) {
      const source = w.pick(policies);
      const year = w.pick(["2023", "2024", "2025"]);
      const name = (source.path.split("/").at(-1) as string).replace(".md", "");
      path = `${roots.archive}/${source.department}/${w.say("edition", { title: name, year })}.md`;
      if (w.files.has(path)) continue;
      modified = dayAfter(`${Number(year) - 1}-12-01`, hashOf(path) % 28);
      body = source.text
        .replace("approval_state: approved", "approval_state: archived")
        .replace(w.written(2026, 1, 1), w.written(year, 1, 1));
      // An older edition: one stated value differs, the rest are as now.
      const stated = w.truth.filter((s) => s.document === source.path);
      const changed = stated.length ? w.pick(stated) : undefined;
      for (const t of stated) {
        const fact = tenant.facts.find((f) => f.key === t.fact) as Fact;
        if (t === changed) {
          const old = w.pick(fact.alternatives);
          const sentence = fact.say.map((s) => fill(s, { value: t.value })).find((s) => body.includes(s));
          if (sentence) body = body.replace(sentence, sentence.replace(t.value, old));
          w.truth.push({ document: path, fact: t.fact, value: old, stance: "superseded" });
        } else w.truth.push({ ...t, document: path, stance: "superseded" });
      }
      w.duplicates.push({ document: path, of: source.path, exact: false });
    } else continue;
    if (w.files.has(path)) continue;
    w.write(path, body, modified);
    made++;
  }

  for (const [path, body] of w.files) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), body);
    const at = new Date(`${w.modified.get(path)}T08:00:00Z`);
    await utimes(join(dir, path), at, at);
  }
  for (const department of departments) {
    const group = tenant.departments[department] as string;
    // Department spaces are for the department; policies, the archive and shared copies for everyone.
    await mkdir(join(dir, roots.teams, department), { recursive: true });
    await writeFile(
      join(dir, roots.teams, department, ".acl.yaml"),
      `readers: [group:${group}]\neditors: [group:${group}]\n`,
    );
  }
  for (const root of [roots.policies, roots.archive, roots.shared]) await mkdir(join(dir, root), { recursive: true });
  await writeFile(join(dir, roots.policies, ".acl.yaml"), "readers: [tenant]\n");
  await writeFile(join(dir, roots.policies, ".meta.yaml"), `authority: 0.9\nlanguage: ${tenant.language}\n`);
  const facts = tenant.facts.map((f) => ({ ...f, slot: slotOfFact(tenant, f.key) }));
  await writeFile(
    join(dir, "truth.json"),
    `${JSON.stringify({ facts, statements: w.truth, duplicates: w.duplicates }, null, 1)}\n`,
  );
  await writeFile(join(dir, "vocabulary.yaml"), stringify(vocabulary(tenant)));
  await writeFile(join(dir, "corpus.yaml"), stringify(manifest(tenant)));
  return { documents: made, statements: w.truth.length, duplicates: w.duplicates };
}

export interface EditOptions {
  /** Share of the documents to edit. */
  share: number;
  seed?: number;
  /** The day of the edits, YYYY-MM-DD: the edited files' modification time. */
  day: string;
  /** The language of the tenant's pack. */
  language?: string;
}

export interface Edits {
  documents: number;
  by_kind: Record<string, number>;
}

/**
 * Edit a share of a synthesized corpus in place, as a stretch of ordinary work would: a
 * policy revises one of its values, and its copies in the shared folder keep the old text;
 * any other document gains a paragraph. The archive and the copies are not edited.
 */
export async function edit(dir: string, options: EditOptions): Promise<Edits> {
  const tenant = tenantIn(options.language ?? "zh");
  const { roots } = tenant;
  const w = new Writer(tenant, options.seed ?? 2);
  const paths = (await readdir(dir, { recursive: true }))
    .map((p) => p.split("\\").join("/"))
    .filter((p) => p.endsWith(".md") && !p.startsWith(`${roots.archive}/`) && !p.startsWith(`${roots.shared}/`))
    .sort();
  const edits: Edits = { documents: 0, by_kind: {} };
  const at = new Date(`${options.day}T08:00:00Z`);
  for (const path of paths) {
    if (w.rand() >= options.share) continue;
    let text = await readFile(join(dir, path), "utf8");
    let kind = "paragraph added";
    if (path.startsWith(`${roots.policies}/`)) {
      const stated = tenant.facts
        .flatMap((f) => f.say.map((say) => [f, fill(say, { value: f.value })] as const))
        .filter(([, sentence]) => text.includes(sentence));
      if (!stated.length) continue;
      const [fact, sentence] = w.pick(stated);
      text = text.replace(sentence, sentence.replace(fact.value, w.pick(fact.alternatives)));
      kind = "policy value revised";
    } else text = `${text.trimEnd()}\n\n${w.filler()}\n`;
    await writeFile(join(dir, path), text);
    await utimes(join(dir, path), at, at);
    edits.documents++;
    edits.by_kind[kind] = (edits.by_kind[kind] ?? 0) + 1;
  }
  return edits;
}

function manifest(tenant: Tenant): CorpusManifest {
  const id = "ten_01SYNTH0000000000000000001";
  const policy = "spc_01SYNTH000000000000000POLICY";
  const teams = "spc_01SYNTH0000000000000000TEAMS";
  const folder: Record<string, string> = {};
  Object.entries(tenant.departments).forEach(([d, group], i) => {
    folder[`group:${group}`] = `grp_01SYNTH${String(i).padStart(18, "0")}`;
    staffOf(tenant, d).forEach((name, j) => {
      folder[`user:${name}`] = `mem_01SYNTH${String(3 * i + j).padStart(18, "0")}`;
    });
  });
  const source = (
    id: string,
    space: string,
    name: string,
    root: string,
    authority: number,
    level: GovernanceLevel,
  ) => ({
    id,
    type: "folder",
    space,
    name,
    root,
    directory: "folder",
    default_authority: authority,
    governance_level: level,
  });
  const { sources, roots } = tenant;
  return {
    tenant: { id, name: tenant.name },
    spaces: [
      { id: policy, name: tenant.spaces.policies },
      { id: teams, name: tenant.spaces.teams },
    ],
    directory: { folder },
    sources: [
      source("src_01SYNTH00000000000000POLICIES", policy, sources.policies, roots.policies, 0.9, "governed"),
      source("src_01SYNTH0000000000000000TEAMS", teams, sources.teams, roots.teams, 0.5, "reference"),
      source("src_01SYNTH000000000000000ARCHIVE", policy, sources.archive, roots.archive, 0.3, "governed"),
      source("src_01SYNTH0000000000000000SHARED", teams, sources.shared, roots.shared, 0.4, "reference"),
    ],
  };
}

/** The entry whose cumulative share first exceeds r, a draw in [0, 1). */
function pickWeighted(entries: readonly (readonly [string, number])[], r: number): string {
  let below = 0;
  for (const [name, share] of entries) {
    below += share;
    if (r < below) return name;
  }
  return entries[0]?.[0] ?? "";
}
