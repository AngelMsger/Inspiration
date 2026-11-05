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
 * where a checkout dates every file the day it was made. A file written for a test says so
 * (kind constructed), with what it changes and the file it is based on, if any.
 *
 * provision() writes what the business layer would, through access control's directory: the
 * tenant; as its active members the directory's members, the spaces' maintainers and readers,
 * the corpus's reader and everyone an optional people.yaml lists (named as it names them, and
 * given the super admin's roles where it says role: super_admin); every space owned by
 * its maintainer (owner in corpus.yaml, else the reader) and read by its readers (the whole
 * tenant when not given), and each source in its space. Who reads a document is its space's
 * audience; the ACLs its folder or Feishu reports are kept as they are and decide nothing.
 * Questions (questions.ts) are asked as the reader.
 */

import { createHash } from "node:crypto";
import { access, readdir, readFile, utimes } from "node:fs/promises";
import { join, posix, relative, resolve, sep } from "node:path";
import type { AuthzService, Directory } from "@inspiration/access-control";
import { globToRegExp } from "@inspiration/connectors";
import {
  type AclEntry,
  canonicalJson,
  type Principal,
  type PutMember,
  type PutTenant,
  parseAs,
  type Source,
  schemaErrors,
} from "@inspiration/contracts";
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
  /** locale: the tenant's default locale; en when not given. */
  tenant: { id: string; name: string; locale?: string };
  /**
   * owner: the member who maintains the space; the reader when not given. readers: who reads
   * it besides its owner, as member IDs; the whole tenant when not given.
   */
  spaces: { id: string; name: string; owner?: string; readers?: string[] }[];
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
  /**
   * What the file is to the company: the document in use, a copy of an older version, or an
   * old revision kept; or a file written for a test, which no outside source has.
   */
  kind?: "current" | "stale_copy" | "old_revision" | "constructed";
  /** For a stale copy or an old revision: the file whose older version it is. */
  of?: string;
  url?: string;
  revision?: string;
  license?: string;
  /** For a constructed file, the file and revision it starts from, as "<path>@<revision>". */
  based_on?: string;
  /** What the file is and why it is there, in a sentence or two. */
  note?: string;
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
          kind: { enum: ["current", "stale_copy", "old_revision", "constructed"] },
          of: { type: "string" },
          url: { type: "string" },
          revision: { type: "string" },
          license: { type: "string" },
          based_on: { type: "string" },
          note: { type: "string" },
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
  /** Member ID to display name, from people.yaml. */
  readonly names: ReadonlyMap<string, string>;
  /** The members people.yaml makes the company's super admin. */
  readonly superAdmins: ReadonlySet<string>;
  readonly #directoryOf = new Map<string, Record<string, string>>();

  constructor(
    dir: string,
    manifest: CorpusManifest,
    options: {
      vocabulary?: Vocabulary;
      files?: CorpusFile[];
      names?: Map<string, string>;
      superAdmins?: Set<string>;
      createdAt?: Date;
    } = {},
  ) {
    const createdAt = options.createdAt ?? new Date(0);
    this.dir = resolve(dir);
    this.manifest = manifest;
    this.vocabulary = options.vocabulary;
    this.files = options.files ?? [];
    this.names = options.names ?? new Map();
    this.superAdmins = options.superAdmins ?? new Set();
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
    const people = join(dir, "people.yaml");
    return new Corpus(dir, manifest, {
      ...((await exists(vocabulary)) && { vocabulary: await loadVocabulary(vocabulary) }),
      ...((await exists(files)) && { files: await loadFiles(files) }),
      ...((await exists(people)) && (await loadPeople(people))),
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

  /** The tenancy service that provisions the corpus, as the business layer's would. */
  get service(): string {
    return `svc_${this.tenantId.slice("ten_".length)}`;
  }

  /**
   * What the business layer would provision for the corpus, through the directory. Run again,
   * it replays what is unchanged, so the graph is granted again even when only the records
   * outlived the last run, and sends a newer version of what corpus.yaml changed.
   */
  async provision(directory: Directory, authz: AuthzService): Promise<void> {
    const tenantId = this.tenantId;
    const tenant: Omit<PutTenant, "version"> = {
      name: this.manifest.tenant.name,
      kind: "team",
      status: "active",
      default_locale: this.manifest.tenant.locale ?? "en",
    };
    const version = seedVersion(await directory.tenant(tenantId), tenant);
    await directory.putTenant(tenantId, { ...tenant, version }, this.service);
    const members = new Set([
      this.reader.id,
      ...this.manifest.spaces.flatMap((s) => [s.owner ?? [], s.readers ?? []].flat()),
      ...Object.values(this.manifest.directory ?? {}).flatMap((section) => Object.values(section)),
      ...this.names.keys(),
    ]);
    for (const id of [...members].filter((m) => m.startsWith("mem_")).sort()) {
      const member: Omit<PutMember, "version"> = {
        status: "active",
        display_name: this.names.get(id) ?? id,
        roles: this.superAdmins.has(id) ? [...SUPER_ADMIN_ROLES] : ["member"],
      };
      const version = seedVersion(await directory.member(tenantId, id), member);
      await directory.putMember(tenantId, id, { ...member, version });
    }
    for (const space of this.manifest.spaces) {
      const owner = space.owner ?? this.reader.id;
      const existing = await directory.space(space.id);
      if (!existing)
        await directory.createSpace(tenantId, { name: space.name, owner_ids: [owner] }, { spaceId: space.id });
      else {
        if (existing.name !== space.name) await directory.patchSpace(space.id, { name: space.name });
        await directory.putOwners(space.id, [owner]);
      }
      const readers = space.readers ?? [tenantId];
      await directory.putAudience(
        space.id,
        readers.map((id) => ({ principal_id: id === tenantId ? "tenant" : id, role: "viewer" })),
      );
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

/** The version a seed sends: the copy's own when the fields are unchanged, so a run again replays; else one more. */
function seedVersion(current: { version?: number } | undefined, fields: object): number {
  const version = current?.version;
  if (version === undefined) return 1;
  const held = current as Record<string, unknown>;
  const same = Object.entries(fields).every(([k, v]) => canonicalJson(held[k]) === canonicalJson(v));
  return same ? version : version + 1;
}

/** The roles the business layer gives its product role super_admin. */
const SUPER_ADMIN_ROLES = ["owner", "admin", "security_admin", "auditor"] as const;

/** Member ID to display name, and the super admins, from a people.yaml beside the corpus. */
async function loadPeople(file: string): Promise<{ names: Map<string, string>; superAdmins: Set<string> }> {
  const { people = [] } = parse(await readFile(file, "utf8")) as {
    people?: { member: string; name: string; role?: string }[];
  };
  return {
    names: new Map(people.map((p) => [p.member, p.name])),
    superAdmins: new Set(people.filter((p) => p.role === "super_admin").map((p) => p.member)),
  };
}
