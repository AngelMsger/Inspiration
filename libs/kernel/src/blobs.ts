/** Content-addressed blob stores. */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { BlobRef, BlobStore } from "@inspiration/contracts";

function digestOf(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function blobRef(uri: string, digest: string, data: Uint8Array, mimeType: string, filename?: string): BlobRef {
  const ref: BlobRef = { uri, sha256: `sha256:${digest}`, size_bytes: data.byteLength, mime_type: mimeType };
  if (filename !== undefined) ref.filename = filename;
  return ref;
}

/**
 * Blobs on a local or mounted filesystem, at <root>/<aa>/<sha256>. Prototype default; an
 * S3-compatible store implements the same BlobStore interface.
 */
export class LocalBlobStore implements BlobStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  #path(digest: string): string {
    return join(this.root, digest.slice(0, 2), digest);
  }

  async put(data: Uint8Array, options: { mimeType: string; filename?: string }): Promise<BlobRef> {
    const digest = digestOf(data);
    const path = this.#path(digest);
    const exists = await stat(path).then(
      () => true,
      () => false,
    );
    if (!exists) {
      await mkdir(dirname(path), { recursive: true });
      // Write then rename, so a reader never sees a partial blob.
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, data);
      await rename(tmp, path);
    }
    return blobRef(pathToFileURL(path).href, digest, data, options.mimeType, options.filename);
  }

  #resolve(ref: BlobRef): string {
    if (!ref.uri.startsWith("file:")) throw new RangeError(`LocalBlobStore cannot read ${ref.uri}`);
    const path = resolve(fileURLToPath(ref.uri));
    const rel = relative(this.root, path);
    if (rel.startsWith("..") || resolve(this.root, rel) !== path) {
      throw new RangeError(`blob ${ref.uri} is outside the store`);
    }
    return path;
  }

  async get(ref: BlobRef): Promise<Uint8Array> {
    const data = new Uint8Array(await readFile(this.#resolve(ref)));
    if (`sha256:${digestOf(data)}` !== ref.sha256) throw new RangeError(`blob ${ref.uri} does not match its hash`);
    return data;
  }

  async delete(ref: BlobRef): Promise<void> {
    await rm(this.#resolve(ref), { force: true });
  }
}

/** In-memory BlobStore for tests. */
export class MemoryBlobStore implements BlobStore {
  readonly #data = new Map<string, Uint8Array>();

  async put(data: Uint8Array, options: { mimeType: string; filename?: string }): Promise<BlobRef> {
    const digest = digestOf(data);
    this.#data.set(digest, data.slice());
    return blobRef(`memory://${digest}`, digest, data, options.mimeType, options.filename);
  }

  async get(ref: BlobRef): Promise<Uint8Array> {
    const data = this.#data.get(ref.sha256.replace(/^sha256:/, ""));
    if (!data) throw new RangeError(`no blob ${ref.uri}`);
    return data.slice();
  }

  async delete(ref: BlobRef): Promise<void> {
    this.#data.delete(ref.sha256.replace(/^sha256:/, ""));
  }
}
