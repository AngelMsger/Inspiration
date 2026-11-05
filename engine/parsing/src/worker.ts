// The parser normalization's router picks for Word, PowerPoint, Excel and PDF files: it sends
// the file to the parsing worker and returns the blocks the worker read.

import type { FileMeta, ParseResult, Parser } from "@inspiration/contracts";
import { getSettings } from "@inspiration/kernel";

/** The types the worker reads, by MIME type and by the file name's extension. */
export const WORKER_TYPES: Readonly<Record<string, string>> = {
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pdf": "application/pdf",
};

const TYPES = new Set(Object.values(WORKER_TYPES));

/** A large PDF takes the worker a while; one that takes longer than this is given up on. */
const TIMEOUT_MS = 300_000;

export class WorkerError extends Error {
  override name = "WorkerError";
}

/** A parser that sends files to the worker at url. */
export function workerParserAt(url: () => string): Parser {
  return {
    name: "worker",
    version: "1",
    accepts(meta: FileMeta) {
      const dot = meta.filename?.lastIndexOf(".") ?? -1;
      const ext = dot >= 0 ? meta.filename?.slice(dot).toLowerCase() : undefined;
      return TYPES.has(meta.mime_type) || (ext !== undefined && ext in WORKER_TYPES) ? 1 : 0;
    },
    async parse(file, meta, _hints, ctx): Promise<ParseResult> {
      const base = url().replace(/\/$/, "");
      const body = await ctx.blobs.get(file);
      let res: Response;
      try {
        res = await fetch(`${base}/v1/parse`, {
          method: "POST",
          headers: {
            "content-type": meta.mime_type,
            ...(meta.filename && { "x-inspiration-filename": encodeURIComponent(meta.filename) }),
          },
          body,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        throw new WorkerError(`the parsing worker at ${base} is not reachable (pnpm parsing starts it): ${error}`);
      }
      const answer = (await res.json().catch(() => undefined)) as
        | (ParseResult & { error?: { message?: string } })
        | undefined;
      if (!res.ok || !answer) {
        throw new WorkerError(answer?.error?.message ?? `the parsing worker answered ${res.status}`);
      }
      return answer;
    },
  };
}

/** The "parsers" plugin: the worker at the parsingUrl setting. */
export const workerParser: Parser = workerParserAt(() => getSettings().parsingUrl);
