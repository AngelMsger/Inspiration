/**
 * Uploads: the files people put into a space. Each space has one upload area, a source of
 * type "upload" with a stable ID, and a file is an item of it whose external ID is its path in
 * the space (its folders and name, "/"-separated). The bytes go to the blob store when they
 * arrive and the file is recorded in sync.uploads; the area's connector lists and fetches
 * those records as any connector lists and fetches its system, so an upload is stored as a
 * changed item is. Uploads carry no ACL: the space's audience decides who reads them.
 */

import {
  type BlobRef,
  type BlobStore,
  type Connector,
  contentHash,
  type NormalizedDocument,
  type Source,
  type SourceRef,
  sameVersion,
  stableId,
  type Version,
} from "@inspiration/contracts";
import { defineTable, type Records } from "@inspiration/eventbus";

export const UPLOAD_TYPE = "upload";

/** One uploaded file as the upload area keeps it. */
export interface UploadRecord {
  source_id: string;
  /** The file's path in the space, its folders and name; the item's external ID. */
  path: string;
  blob: BlobRef;
  content_hash: string;
  /** When the file last changed where it came from, as the uploader's device says. */
  modified_at?: string;
  uploaded_at: string;
  uploaded_by: string;
}

export const UPLOADS = defineTable<UploadRecord>("sync.uploads", {
  key: (u) => uploadKey(u.source_id, u.path),
  columns: { source_id: (u) => u.source_id },
});

const uploadKey = (sourceId: string, path: string) => `${sourceId}\x1f${path}`;

/** A file to upload into a space. */
export interface Upload {
  path: string;
  bytes: Uint8Array;
  mime_type: string;
  modified_at?: string;
  /** The member who uploads it. */
  uploaded_by: string;
}

export const MAX_PATH = 1024;

/** The folders and name of a path, or a RangeError when it is not one a file may have. */
export function pathParts(path: string): { folders: string[]; name: string } {
  if (path.length > MAX_PATH) throw new RangeError(`a file's path has at most ${MAX_PATH} characters`);
  const parts = path.split("/");
  for (const part of parts) {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
    if (!part || part === "." || part === ".." || /[\u0000-\u001f\u007f\\]/.test(part)) {
      throw new RangeError(`"${path}" is not a file path: name every folder and the file, without . or ..`);
    }
  }
  const name = parts.pop() as string;
  return { folders: parts, name };
}

/** The ID of a space's upload area, the same in every process, so two first uploads make one. */
export function uploadAreaId(spaceId: string): string {
  return stableId("source", UPLOAD_TYPE, spaceId);
}

/** A space's upload area, before its first file. */
export function uploadArea(tenantId: string, spaceId: string, now: string): Source {
  return {
    id: uploadAreaId(spaceId),
    tenant_id: tenantId,
    space_id: spaceId,
    type: UPLOAD_TYPE,
    name: "Uploads",
    scope: { kind: UPLOAD_TYPE },
    status: "active",
    created_at: now,
  };
}

/** The upload area's connector over its records. */
export function uploadConnector(records: Records, source: Source): Connector {
  return {
    type: UPLOAD_TYPE,
    capabilities: () => ({ list: true, fetch: true, acl: false, files: true }),
    async list() {
      const uploads = await records.find(UPLOADS, { source_id: source.id });
      return { items: uploads.map((u) => ({ ref: refOf(u), version: versionOf(u) })) };
    },
    async fetch(ref: SourceRef, known?: Version) {
      const upload = await records.get(UPLOADS, uploadKey(source.id, ref.external_id));
      if (!upload) throw new RangeError(`no upload ${ref.external_id} in ${source.id}`);
      const version = versionOf(upload);
      if (sameVersion(known, version)) return { unchanged: true };
      const { name } = pathParts(upload.path);
      const dot = name.lastIndexOf(".");
      const doc: NormalizedDocument = {
        ref: refOf(upload),
        version,
        title: dot > 0 ? name.slice(0, dot) : name,
        mime_type: upload.blob.mime_type,
        file: upload.blob,
      };
      if (upload.modified_at) doc.metadata = { modified_at: upload.modified_at };
      return doc;
    },
  };
}

/** The record for a file, its bytes stored, or undefined when the same bytes are already there. */
export async function recordOf(
  records: Records,
  blobs: BlobStore,
  sourceId: string,
  upload: Upload,
  now: string,
): Promise<UploadRecord | undefined> {
  const { name } = pathParts(upload.path);
  const hash = contentHash(upload.bytes);
  const current = await records.get(UPLOADS, uploadKey(sourceId, upload.path));
  if (current?.content_hash === hash) return undefined;
  return {
    source_id: sourceId,
    path: upload.path,
    blob: await blobs.put(upload.bytes, { mimeType: upload.mime_type, filename: name }),
    content_hash: hash,
    ...(upload.modified_at && { modified_at: upload.modified_at }),
    uploaded_at: now,
    uploaded_by: upload.uploaded_by,
  };
}

const refOf = (u: UploadRecord): SourceRef => ({ source_id: u.source_id, external_id: u.path });

const versionOf = (u: UploadRecord): Version => ({ content_hash: u.content_hash });
