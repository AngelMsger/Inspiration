/**
 * A local or mounted directory as a source: every file is an item, its relative path the
 * external ID. Files go to the parser router unchanged; the connector only adds what the
 * directory says about them.
 *
 * - Markdown front matter: title, approval_state, sensitivity, authority,
 *   governance_level, owner, tags, language, translation_of (the external ID of the file
 *   it translates) and any other key (kept in metadata.extra). Front matter that is not
 *   valid YAML gives no metadata, and the file syncs without it.
 * - Translations: a file named for its language ("leave-policy.zh.md", a two-letter
 *   language code with an optional script or region) is in that language, whatever its
 *   folder's .meta.yaml says, and translates the file without it ("leave-policy.md") when
 *   that file exists; the link changes the translation's version when that file appears or goes.
 *   Front matter overrides both.
 * - `.meta.yaml` in a folder: the same keys as defaults for every file below it; deeper
 *   folders and front matter win.
 * - `.acl.yaml` in a folder: who may read the files below it, as short entries
 *   (`readers: [group:finance, user:li.na, tenant]`, also commenters, editors, owners). The
 *   nearest file applies; `inherit: true` adds the parent folder's entries.
 *
 * Scope: `{ kind: "folder", options: { root: "<path>" }, include?, exclude? }`, globs on the
 * relative path (`**` crosses folders, `*` does not).
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, posix, relative, resolve, sep } from "node:path";
import {
  type AclEntry,
  type AclRole,
  type AclSnapshot,
  type ApprovalState,
  type Connector,
  type ConnectorCapabilities,
  type ConnectorContext,
  type Cursor,
  canonicalJson,
  contentHash,
  isGovernanceLevel,
  type ListedItem,
  type ListPage,
  type NormalizedDocument,
  type ScopeSpec,
  type SensitivityLabel,
  type Source,
  type SourceRef,
  sameVersion,
  type Unchanged,
  type Version,
} from "@inspiration/contracts";
import { parse } from "yaml";
import { aclHash, aclSnapshot, parseEntry } from "./acl.ts";

export const MIME_TYPES: Readonly<Record<string, string>> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".html": "text/html",
  ".htm": "text/html",
  ".csv": "text/csv",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

const PAGE_SIZE = 200;
const APPROVAL_STATES = new Set(["draft", "in_review", "approved", "archived", "unknown"]);
const LABELS = new Set(["public", "internal", "confidential", "secret"]);
const ROLES: Record<string, AclRole> = {
  readers: "viewer",
  commenters: "commenter",
  editors: "editor",
  owners: "owner",
};

type Meta = Record<string, unknown>;

/** Glob on a relative POSIX path: `**` matches across folders, `*` and `?` within one. */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*" && glob[i + 1] === "*") {
      out += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/** A Markdown file whose front matter is not valid YAML, so its own labels cannot be read. */
export class FrontMatterError extends Error {
  override name = "FrontMatterError";
}

/** Front matter of a Markdown file, and the text after it; FrontMatterError when it is not valid YAML. */
export function frontMatter(text: string): { meta: Meta; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  let meta: unknown;
  try {
    meta = parse(m[1] as string);
  } catch (e) {
    throw new FrontMatterError(
      `front matter is not valid YAML: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}`,
    );
  }
  return {
    meta: meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as Meta) : {},
    body: text.slice(m[0].length),
  };
}

async function readYaml(path: string): Promise<Meta | undefined> {
  try {
    const value = parse(await readFile(path, "utf8")) as unknown;
    return value && typeof value === "object" ? (value as Meta) : {};
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

/**
 * Sidecar files read during one call. Many files share a folder's .meta.yaml and .acl.yaml,
 * so a listing reads each once; a later call reads them again, because sync keeps one
 * connector per source and sidecars change between runs.
 */
class Sidecars {
  readonly #read = new Map<string, Promise<Meta | undefined>>();

  read(path: string): Promise<Meta | undefined> {
    let found = this.#read.get(path);
    if (!found) {
      found = readYaml(path);
      this.#read.set(path, found);
    }
    return found;
  }
}

interface FileInfo {
  path: string;
  rel: string;
  folders: string[];
}

export class FolderConnector implements Connector {
  readonly type = "folder";
  readonly source: Source;
  readonly root: string;
  readonly #ctx: ConnectorContext;

  constructor(source: Source, ctx: ConnectorContext) {
    const root = source.scope.options?.root;
    if (typeof root !== "string" || !root) throw new RangeError(`source ${source.id}: scope.options.root is required`);
    this.source = source;
    this.root = resolve(root);
    this.#ctx = ctx;
  }

  capabilities(): ConnectorCapabilities {
    return { list: true, fetch: true, acl: true, acl_fidelity: "exact", files: true };
  }

  async #walk(dir: string, folders: string[], out: FileInfo[]): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const path = join(dir, e.name);
      if (e.isDirectory()) await this.#walk(path, [...folders, e.name], out);
      else if (e.isFile() && MIME_TYPES[extname(e.name).toLowerCase()]) {
        out.push({ path, rel: relative(this.root, path).split(sep).join(posix.sep), folders });
      }
    }
  }

  async #files(scope: ScopeSpec): Promise<FileInfo[]> {
    const all: FileInfo[] = [];
    await this.#walk(this.root, [], all);
    const include = (scope.include ?? []).map(globToRegExp);
    const exclude = (scope.exclude ?? []).map(globToRegExp);
    return all.filter(
      (f) => (!include.length || include.some((r) => r.test(f.rel))) && !exclude.some((r) => r.test(f.rel)),
    );
  }

  /** Folder defaults from the root down to the file's folder. */
  async #folderMeta(folders: readonly string[], sidecars: Sidecars): Promise<Meta> {
    const meta: Meta = {};
    for (let i = 0; i <= folders.length; i++) {
      Object.assign(meta, await sidecars.read(join(this.root, ...folders.slice(0, i), ".meta.yaml")));
    }
    return meta;
  }

  /** Entries from the nearest .acl.yaml, plus its parents' while a file says inherit. */
  async #aclEntries(folders: readonly string[], sidecars: Sidecars): Promise<AclEntry[]> {
    const entries: AclEntry[] = [];
    for (let i = folders.length; i >= 0; i--) {
      const acl = await sidecars.read(join(this.root, ...folders.slice(0, i), ".acl.yaml"));
      if (!acl) continue;
      for (const [key, role] of Object.entries(ROLES)) {
        const specs = acl[key];
        if (Array.isArray(specs)) entries.push(...specs.map((s) => parseEntry(String(s), role)));
      }
      if (acl.inherit !== true) break;
    }
    return entries;
  }

  async #describe(
    f: FileInfo,
    sidecars: Sidecars,
  ): Promise<{
    data: Uint8Array;
    meta: Meta;
    original?: string;
    version: Version;
    acl: AclEntry[];
    unreadable?: FrontMatterError;
  }> {
    const [data, info, folderMeta, acl] = await Promise.all([
      readFile(f.path),
      stat(f.path),
      this.#folderMeta(f.folders, sidecars),
      this.#aclEntries(f.folders, sidecars),
    ]);
    const ext = extname(f.path).toLowerCase();
    let own: Meta = {};
    let unreadable: FrontMatterError | undefined;
    if (ext === ".md" || ext === ".markdown") {
      try {
        own = frontMatter(data.toString("utf8")).meta;
      } catch (e) {
        if (!(e instanceof FrontMatterError)) throw e;
        unreadable = e;
      }
    }
    // The language a file is named for is more specific than its folder's and less than its own front matter.
    const translation = translationOf(f.rel);
    const meta: Meta = { ...folderMeta, ...(translation && { language: translation.language }), ...own };
    const original =
      typeof meta.translation_of === "string" && meta.translation_of
        ? meta.translation_of
        : translation && (await isFile(join(this.root, ...translation.original.split("/"))))
          ? translation.original
          : undefined;
    const version: Version = {
      content_hash: contentHash(data),
      // The original a file translates is part of its metadata even when inferred from the file name, so the
      // translation changes when its original appears or goes.
      metadata_hash: contentHash(canonicalJson(original ? { ...meta, translation_of: original } : meta)),
      acl_hash: aclHash(acl),
      modified_at: info.mtime.toISOString(),
      size_bytes: info.size,
    };
    return { data, meta, ...(original && { original }), version, acl, ...(unreadable && { unreadable }) };
  }

  #ref(f: FileInfo, title?: string): SourceRef {
    const ref: SourceRef = { source_id: this.source.id, external_id: f.rel, kind: "file", uri: `file://${f.path}` };
    if (title) ref.title = title;
    if (f.folders.length) ref.parent_external_id = f.folders.join("/");
    return ref;
  }

  async list(scope: ScopeSpec, cursor?: Cursor): Promise<ListPage> {
    const files = await this.#files(scope);
    const start = cursor ? Number(cursor) : 0;
    const items: ListedItem[] = [];
    const sidecars = new Sidecars();
    for (const f of files.slice(start, start + PAGE_SIZE)) {
      const { version } = await this.#describe(f, sidecars);
      items.push({ ref: this.#ref(f), version });
    }
    const page: ListPage = { items };
    if (start + PAGE_SIZE < files.length) page.next_cursor = String(start + PAGE_SIZE);
    return page;
  }

  #file(ref: SourceRef): FileInfo {
    const path = resolve(this.root, ref.external_id);
    const rel = relative(this.root, path);
    if (rel.startsWith("..") || rel === "") throw new RangeError(`${ref.external_id} is outside the source folder`);
    const parts = rel.split(sep);
    return { path, rel: parts.join(posix.sep), folders: parts.slice(0, -1) };
  }

  async fetch(ref: SourceRef, known?: Version): Promise<NormalizedDocument | Unchanged> {
    const f = this.#file(ref);
    const { data, meta, original, version, acl, unreadable } = await this.#describe(f, new Sidecars());
    // Front matter carries the file's own sensitivity, approval state and governance level. When it
    // cannot be read, the folder's defaults would silently loosen them, so the file fails alone: a
    // sync reports it, keeps the version stored before and goes on with the other files. Listing
    // still works, so the file is not taken for deleted.
    if (unreadable) throw unreadable;
    if (sameVersion(known, version)) return { unchanged: true };
    const ext = extname(f.path).toLowerCase();
    const mimeType = MIME_TYPES[ext] ?? "application/octet-stream";
    const name = basename(f.path);
    const title = typeof meta.title === "string" ? meta.title : (titleOf(data, ext) ?? name.slice(0, -ext.length));
    const file = await this.#ctx.blobs.put(data, { mimeType, filename: name });
    const {
      title: _title,
      approval_state,
      sensitivity,
      authority,
      governance_level,
      owner,
      tags,
      translation_of,
      ...extra
    } = meta;
    const doc: NormalizedDocument = {
      ref: this.#ref(f, title),
      version,
      title,
      mime_type: mimeType,
      file,
      metadata: {
        modified_at: version.modified_at as string,
        path: f.folders,
        ...(typeof owner === "string" && { author_external_id: owner }),
        ...(Array.isArray(tags) && { tags: tags.map(String) }),
        ...(original && { translation_of: { source_id: this.source.id, external_id: original } }),
        ...(Object.keys(extra).length > 0 && { extra }),
      },
      acl: this.#snapshot(f, acl),
    };
    if (typeof meta.language === "string") doc.language = meta.language;
    if (typeof approval_state === "string" && APPROVAL_STATES.has(approval_state)) {
      doc.approval_state = approval_state as ApprovalState;
    }
    if (typeof sensitivity === "string" && LABELS.has(sensitivity)) doc.sensitivity = sensitivity as SensitivityLabel;
    if (typeof authority === "number" && authority >= 0 && authority <= 1) doc.authority = authority;
    if (isGovernanceLevel(governance_level)) doc.governance_level = governance_level;
    return doc;
  }

  #snapshot(f: FileInfo, entries: readonly AclEntry[]): AclSnapshot {
    return aclSnapshot(this.source.id, f.rel, entries, { fidelity: "exact", capturedAt: new Date() });
  }

  async acl(ref: SourceRef): Promise<AclSnapshot> {
    const f = this.#file(ref);
    return this.#snapshot(f, await this.#aclEntries(f.folders, new Sidecars()));
  }
}

const LANGUAGES = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" });
// Two-letter codes only: three-letter ones read too many file names ("notes.new.md") as languages.
const SUFFIX = /^(.*[^/])\.([a-z]{2}(?:-[a-z]{4})?(?:-(?:[a-z]{2}|\d{3}))?)(\.[^./]+)$/i;

const isFile = (path: string) =>
  stat(path).then(
    (s) => s.isFile(),
    () => false,
  );

/** For a file named for its language ("policies/leave-policy.zh.md"), that language and the file it translates. */
export function translationOf(rel: string): { original: string; language: string } | undefined {
  const [, stem, tag, ext] = SUFFIX.exec(rel) ?? [];
  if (!stem || !tag || !ext) return undefined;
  const [language] = Intl.getCanonicalLocales(tag);
  return language && LANGUAGES.of(language) ? { original: `${stem}${ext}`, language } : undefined;
}

/** The first Markdown heading, or the HTML title. */
function titleOf(data: Uint8Array, ext: string): string | undefined {
  if (![".md", ".markdown", ".html", ".htm"].includes(ext)) return undefined;
  const text = new TextDecoder().decode(data);
  if (ext.startsWith(".htm")) return /<title>([^<]+)<\/title>/i.exec(text)?.[1]?.trim();
  return /^#{1,6}\s+(.+?)\s*#*\s*$/m.exec(frontMatter(text).body)?.[1];
}

export function folderConnector(source: Source, ctx: ConnectorContext): Connector {
  return new FolderConnector(source, ctx);
}
