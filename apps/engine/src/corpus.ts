/**
 * A corpus on disk: a corpus.yaml that declares a tenant, its spaces, its sources (folders
 * and recorded Feishu fixtures, relative to the corpus) and a directory that maps each
 * source's principals to engine principals, standing in for the business layer. An
 * optional vocabulary.yaml is the tenant's predicate catalogue for extraction. A folder source
 * may keep only some of its files: include and exclude are globs on the relative path, and
 * sample keeps that share of what is left by a stable hash of each path, so a smaller share
 * keeps a subset of a larger one (corpora of growing size around the same cases). An optional
 * files.yaml says where each file comes from and when it was last changed: stamp() gives
 * every file listed that modified time, as the drive the corpus stands for would report it,
 * where a checkout dates every file the day it was made.
 *
 * provision() writes what the business layer would into access control: the directory's
 * members and the corpus's reader as members of the tenant, every space owned by the reader
 * and readable by the whole tenant, and each source in its space. Questions (questions.ts)
 * are asked as the reader.
 */

import { createHash } from "node:crypto";
import { access, readdir, readFile, utimes } from "node:fs/promises";
import { join, posix, relative, resolve, sep } from "node:path";
import type { AuthzService } from "@inspiration/access-control";
import { globToRegExp } from "@inspiration/connectors";
import { type AclEntry, type Principal, parseAs, type Source, schemaErrors } from "@inspiration/contracts";
import { loadVocabulary, type Vocabulary } from "@inspiration/extraction";
import type { PrincipalResolver } from "@inspiration/source-sync";
import { parse } from "yaml";

interface SourceSpec {
  id: string;
  type: string;
  space: string;
  name: string;
  /** Folder root, or the fixtures folder of a Feishu source. */
  root: string;
  /** Which directory section maps this source's principals. */
  directory?: string;
  default_authority?: number;
  default_sensitivity?: Source["default_sensitivity"];
  /** What the admin picked when connecting it; folders and items may set their own. */
  governance_level?: Source["governance_level"];
  /** Globs on a folder source's relative paths: only these files, then none of these. */
  include?: string[];
  exclude?: string[];
  /** The share of a folder source's files kept, 0 to 1, by a stable hash of each path. */
  sample?: number;
}

export interface CorpusManifest {
  tenant: { id: string; name: string };
  spaces: { id: string; name: string }[];
  /** Section name, then "<principal kind>:<source principal ID>", then the engine principal. */
  directory?: Record<string, Record<string, string>>;
  sources: SourceSpec[];
  /** The member questions are asked as; mem_ with the tenant's ID when not given. */
  reader?: string;
}

/** A file of the corpus as files.yaml records it. */
export interface CorpusFile {
  /** Relative to the corpus. */
  path: string;
  /** When the file was last changed, as its drive would say: a day or an instant. */
  modified: string;
  /** What the file is to the company: the document in use, a copy of an older version, or an old revision kept. */
  kind?: "current" | "stale_copy" | "old_revision";
  /** For a stale copy or an old revision: the file whose older version it is. */
  of?: string;
  url?: string;
  revision?: string;
  license?: string;
}

const FILES_SCHEMA = {
  type: "object",
  required: ["files"],
  properties: {
    files: {
      type: "array",
      items: {
        type: "object",
        required: ["path", "modified"],
        additionalProperties: false,
        properties: {
          path: { type: "string", minLength: 1 },
          modified: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}" },
          kind: { enum: ["current", "stale_copy", "old_revision"] },
          of: { type: "string" },
          url: { type: "string" },
          revision: { type: "string" },
          license: { type: "string" },
        },
      },
    },
  },
};

export class CorpusError extends Error {
  override name = "CorpusError";
}

export class Corpus {
  readonly dir: string;
  readonly manifest: CorpusManifest;
  readonly sources: Source[];
  readonly vocabulary: Vocabulary | undefined;
  readonly files: readonly CorpusFile[];
  readonly #directoryOf = new Map<string, Record<string, string>>();

  constructor(
    dir: string,
    manifest: CorpusManifest,
    options: { vocabulary?: Vocabulary; files?: CorpusFile[]; createdAt?: Date } = {},
  ) {
    const createdAt = options.createdAt ?? new Date(0);
    this.dir = resolve(dir);
    this.manifest = manifest;
    this.vocabulary = options.vocabulary;
    this.files = options.files ?? [];
    const spaces = new Set(manifest.spaces.map((s) => s.id));
    this.sources = manifest.sources.map((s) => {
      if (!spaces.has(s.space)) throw new CorpusError(`source ${s.id}: unknown space ${s.space}`);
      const root = join(this.dir, s.root);
      const options = s.type === "folder" ? { root } : { fixtures: root };
      const source: Source = {
        id: s.id,
        tenant_id: manifest.tenant.id,
        space_id: s.space,
        type: s.type,
        name: s.name,
        scope: { kind: s.type === "folder" ? "folder" : "workspace", options },
        status: "active",
        created_at: createdAt.toISOString(),
      };
      if (s.default_authority !== undefined) source.default_authority = s.default_authority;
      if (s.default_sensitivity) source.default_sensitivity = s.default_sensitivity;
      if (s.governance_level) source.governance_level = s.governance_level;
      if (s.include) source.scope.include = s.include;
      if (s.exclude) source.scope.exclude = s.exclude;
      if (s.directory) {
        const section = manifest.directory?.[s.directory];
        if (!section) throw new CorpusError(`source ${s.id}: no directory section ${s.directory}`);
        this.#directoryOf.set(s.id, section);
      }
      return parseAs<Source>("Source", source);
    });
  }

  /**
   * Reads corpus.yaml and what lies beside it. sample, when given, replaces the sample of
   * every search_only source, so one corpus runs at several sizes of what is only searched.
   */
  static async load(dir: string, options: { sample?: number } = {}): Promise<Corpus> {
    const text = await readFile(join(dir, "corpus.yaml"), "utf8");
    const manifest = parse(text) as CorpusManifest;
    const empty = new Set<string>();
    for (const s of manifest.sources) {
      if (options.sample !== undefined && s.governance_level === "search_only") s.sample = options.sample;
      if (s.sample === undefined) continue;
      if (s.type !== "folder" || !(s.sample >= 0 && s.sample <= 1)) {
        throw new CorpusError(`source ${s.id}: sample is a share from 0 to 1 of a folder's files`);
      }
      s.include = await sampled(join(dir, s.root), s);
      delete s.exclude;
      if (!s.include.length) empty.add(s.id);
    }
    // A sampled source that keeps no file is left out, since an empty include means every file.
    // An include written empty in corpus.yaml keeps that meaning.
    manifest.sources = manifest.sources.filter((s) => !empty.has(s.id));
    const exists = (file: string) =>
      access(file).then(
        () => true,
        () => false,
      );
    const vocabulary = join(dir, "vocabulary.yaml");
    const files = join(dir, "files.yaml");
    return new Corpus(dir, manifest, {
      ...((await exists(vocabulary)) && { vocabulary: await loadVocabulary(vocabulary) }),
      ...((await exists(files)) && { files: await loadFiles(files) }),
    });
  }

  /** Gives each file files.yaml lists the modified time it records. Idempotent. */
  async stamp(): Promise<void> {
    for (const f of this.files) {
      const at = new Date(f.modified.length === 10 ? `${f.modified}T12:00:00Z` : f.modified);
      await utimes(join(this.dir, f.path), at, at);
    }
  }

  get tenantId(): string {
    return this.manifest.tenant.id;
  }

  /** An item's path in the corpus: its source's root, then its external ID. */
  pathOf(sourceId: string, externalId: string): string {
    const spec = this.manifest.sources.find((s) => s.id === sourceId);
    return spec ? `${spec.root}/${externalId}` : externalId;
  }

  /** The member a source's user is, as its directory section maps them. */
  memberOf(sourceId: string, user: string): string | undefined {
    const id = this.#directoryOf.get(sourceId)?.[`user:${user}`];
    return id?.startsWith("mem_") ? id : undefined;
  }

  /** A member of the tenant who reads every space, as tenant-wide documents allow. */
  get reader(): Principal {
    const id = this.manifest.reader ?? `mem_${this.tenantId.slice("ten_".length)}`;
    return { id, kind: "member", tenant_id: this.tenantId };
  }

  /** What the business layer would provision in access control for the corpus. Idempotent. */
  async provision(authz: AuthzService): Promise<void> {
    const tenantId = this.tenantId;
    const members = new Set([
      this.reader.id,
      ...Object.values(this.manifest.directory ?? {}).flatMap((section) =>
        Object.values(section).filter((id) => id.startsWith("mem_")),
      ),
    ]);
    for (const id of [...members].sort()) await authz.addTenantMember(tenantId, id);
    for (const space of this.manifest.spaces) {
      await authz.createSpace(space.id, { tenantId, ownerId: this.reader.id });
      await authz.grantSpace(space.id, "viewer", tenantId);
    }
    for (const source of this.sources) await authz.registerSource(source.id, source.space_id);
  }

  /** The directory lookup source sync calls for every ACL entry without an engine principal. */
  readonly resolvePrincipal: PrincipalResolver = (source: Source, entry: AclEntry) =>
    entry.external_id === undefined
      ? undefined
      : this.#directoryOf.get(source.id)?.[`${entry.principal_kind}:${entry.external_id}`];
}

/**
 * The relative paths of a folder source's files that its include and exclude allow and its
 * sample keeps. A path is kept when the first four bytes of its SHA-256, as a share of 2^32,
 * fall below the sample, which does not depend on the other files. The paths become the
 * source's include globs; a path with * or ? in it would match more than itself, which no
 * corpus here has.
 */
async function sampled(root: string, spec: SourceSpec): Promise<string[]> {
  const include = (spec.include ?? []).map(globToRegExp);
  const exclude = (spec.exclude ?? []).map(globToRegExp);
  const kept: string[] = [];
  const walk = async (folder: string): Promise<void> => {
    for (const e of await readdir(folder, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const path = join(folder, e.name);
      if (e.isDirectory()) await walk(path);
      else if (e.isFile()) {
        const rel = relative(root, path).split(sep).join(posix.sep);
        if (include.length && !include.some((r) => r.test(rel))) continue;
        if (exclude.some((r) => r.test(rel))) continue;
        if (createHash("sha256").update(rel).digest().readUInt32BE(0) / 2 ** 32 < (spec.sample ?? 1)) kept.push(rel);
      }
    }
  };
  await walk(root);
  return kept.sort();
}

async function loadFiles(file: string): Promise<CorpusFile[]> {
  const data = parse(await readFile(file, "utf8")) as { files: CorpusFile[] };
  const errors = schemaErrors(FILES_SCHEMA, data);
  if (errors.length) throw new CorpusError(`files.yaml: ${errors.join("; ")}`);
  return data.files;
}
