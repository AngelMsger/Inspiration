// What every built-in parser does the same way: read its bytes as text, and name itself as the
// producer of what it returns.

import type { Parser, ProducerInfo } from "@inspiration/contracts";

/** UTF-8 text without a byte order mark. */
export function decode(data: Uint8Array): string {
  return new TextDecoder("utf-8", { ignoreBOM: false }).decode(data);
}

export function producer(parser: Pick<Parser, "name" | "version">): ProducerInfo {
  return { component: "normalization", name: parser.name, version: parser.version };
}
