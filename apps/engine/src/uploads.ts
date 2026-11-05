// The upload route of the HTTP API: PUT /v0/spaces/:space/files/:path puts one file into the
// space's uploads. A folder is one request per file. The member needs editor or above on the
// space; the file's type comes from its name, and only the types the engine reads are taken.
// The answer comes once the document is stored, so it is in the Documents tree at once;
// reading it runs in the background.

import { MIME_TYPES } from "@inspiration/connectors";
import type { FileWritten, Principal, SpaceEntry } from "@inspiration/contracts";
import { pathParts } from "@inspiration/source-sync";
import type { Engine } from "./engine.ts";
import { badRequest, forbidden, HttpError, validated } from "./http-errors.ts";

/** The most a file may have. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** The types the engine reads, by extension: those a folder source takes, less images until OCR. */
const READABLE: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(MIME_TYPES).filter(([, type]) => !type.startsWith("image/")),
);

export interface FileRequest {
  header(name: string): string | undefined;
  /** The body, or HttpError 413 once it passes limit bytes. */
  bytes(limit: number): Promise<Uint8Array>;
}

/** Store one file at its path in a space the member may read. */
export async function putFile(
  engine: Engine,
  who: Principal,
  space: SpaceEntry,
  encodedPath: string,
  req: FileRequest,
): Promise<FileWritten> {
  if (!(await engine.authz.check(who, "edit", { type: "space", id: space.id })).allow) {
    throw forbidden("uploading needs editor or above on the space");
  }
  const path = decodedPath(encodedPath);
  const { name } = await validated(async () => pathParts(path));
  const dot = name.lastIndexOf(".");
  const mimeType = dot > 0 ? READABLE[name.slice(dot).toLowerCase()] : undefined;
  if (!mimeType) {
    const types = Object.keys(READABLE).join(" ");
    throw new HttpError(415, "unsupported_type", `the engine reads files named ${types}; not ${name}`);
  }
  const modified = req.header("x-inspiration-modified");
  const modifiedAt = modified === undefined ? undefined : instant(modified);
  const bytes = await req.bytes(MAX_FILE_BYTES);

  const area = await engine.sync.uploadArea(who.tenant_id, space.id);
  // Checked on every upload, not only the first, so an area that a crash left unregistered heals.
  if (!(await engine.authz.spaceOf({ type: "source", id: area.id }))) {
    await engine.authz.registerSource(area.id, space.id);
  }
  const written = await engine.sync.upload(area.id, {
    path,
    bytes,
    mime_type: mimeType,
    ...(modifiedAt && { modified_at: modifiedAt }),
    uploaded_by: who.id,
  });
  if (written.changed) engine.settleLater();
  return written;
}

/** The path as the URL carries it, each segment encoded. */
function decodedPath(encoded: string): string {
  try {
    return encoded.split("/").map(decodeURIComponent).join("/");
  } catch {
    throw badRequest(`the path ${encoded} is not URL-encoded`);
  }
}

function instant(value: string): string {
  const at = new Date(value);
  if (!/^\d{4}-\d\d-\d\dT/.test(value) || Number.isNaN(at.getTime())) {
    throw badRequest(`x-inspiration-modified must be an ISO 8601 instant, not ${value}`);
  }
  return at.toISOString();
}
