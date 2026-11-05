/**
 * How far the engine has read each document's latest version (ReadingState in the contracts),
 * from what normalization and extraction last stored for it: waiting until normalization
 * parses the version, failed when it could not, reading until extraction reads it to the end,
 * paused while a spent budget or a model out of reach holds extraction, read after that.
 * Paused documents read on when Engine.resumeReading next finds room.
 */

import type { DocumentReading, ReadingCounts, SourceVersion } from "@inspiration/contracts";
import type { Engine } from "./engine.ts";

const SPENT = "Today's reading budget for the company is spent; reading carries on when the next day's budget starts.";
const OUT_OF_REACH = "The reading model could not be reached; reading carries on once it can be.";
const UNREADABLE = "The file could not be read.";

const keyOf = (d: { source_id: string; external_id: string }) => `${d.source_id}\x1f${d.external_id}`;

/** The reading of each version, latest versions of the tenant's documents; undefined once read. */
export async function readingOf(
  engine: Engine,
  tenantId: string,
  versions: readonly SourceVersion[],
): Promise<(DocumentReading | undefined)[]> {
  const sources = [...new Set(versions.map((v) => v.source_id))];
  const parsed = new Map(
    (await Promise.all(sources.map((id) => engine.normalization.documents(id)))).flat().map((d) => [keyOf(d), d]),
  );
  const marks = new Map((await engine.extraction.documents(tenantId)).map((m) => [keyOf(m), m]));
  return versions.map((v): DocumentReading | undefined => {
    const normalized = parsed.get(keyOf(v));
    const mark = marks.get(keyOf(v));
    if (normalized?.failed?.source_version_id === v.id) return failed(normalized.failed.warnings);
    if (normalized?.source_version_id !== v.id) return { state: "waiting" };
    if (normalized.status === "failed" || normalized.status === "unsupported") return failed(normalized.warnings);
    if (mark?.source_version_id !== v.id) return { state: "reading" };
    if (mark.paused) return { state: "paused", note: mark.paused.code === "budget_exceeded" ? SPENT : OUT_OF_REACH };
    return mark.reading ? { state: "reading" } : undefined;
  });
}

/** Documents by reading state. */
export function countsOf(readings: readonly (DocumentReading | undefined)[]): ReadingCounts {
  const counts: ReadingCounts = { waiting: 0, reading: 0, read: 0, paused: 0, failed: 0 };
  for (const r of readings) counts[r?.state ?? "read"]++;
  return counts;
}

function failed(warnings: readonly string[] | undefined): DocumentReading {
  return { state: "failed", note: warnings?.length ? warnings.join("; ") : UNREADABLE };
}
