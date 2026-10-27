/**
 * A corpus on disk: a corpus.yaml that declares a tenant, its spaces, its sources (folders
 * and recorded Feishu fixtures, relative to the corpus) and a directory that maps each
 * source's principals to engine principals, standing in for the business layer. An
 * optional vocabulary.yaml is the tenant's predicate catalogue for extraction.
 *
 * provision() writes what the business layer would into access control: the directory's
 * members and the corpus's reader as members of the tenant, every space owned by the reader
 * and readable by the whole tenant, and each source in its space. Questions (questions.ts)
 * are asked as the reader.
 */

import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AuthzService } from "@inspiration/access-control";
import { type AclEntry, type Principal, parseAs, type Source } from "@inspiration/contracts";
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

export class CorpusError extends Error {
  override name = "CorpusError";
}

export class Corpus {
  readonly dir: string;
  readonly manifest: CorpusManifest;
  readonly sources: Source[];
  readonly vocabulary: Vocabulary | undefined;
  readonly #directoryOf = new Map<string, Record<string, string>>();

  constructor(dir: string, manifest: CorpusManifest, options: { vocabulary?: Vocabulary; createdAt?: Date } = {}) {
    const createdAt = options.createdAt ?? new Date(0);
    this.dir = resolve(dir);
    this.manifest = manifest;
    this.vocabulary = options.vocabulary;
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
      if (s.directory) {
        const section = manifest.directory?.[s.directory];
        if (!section) throw new CorpusError(`source ${s.id}: no directory section ${s.directory}`);
        this.#directoryOf.set(s.id, section);
      }
      return parseAs<Source>("Source", source);
    });
  }

  static async load(dir: string): Promise<Corpus> {
    const text = await readFile(join(dir, "corpus.yaml"), "utf8");
    const file = join(dir, "vocabulary.yaml");
    const found = await access(file).then(
      () => true,
      () => false,
    );
    return new Corpus(dir, parse(text) as CorpusManifest, found ? { vocabulary: await loadVocabulary(file) } : {});
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
