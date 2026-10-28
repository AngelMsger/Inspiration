#!/usr/bin/env node
/**
 * A local embedding server for development and validation runs: the OpenAI embeddings API
 * (POST /v1/embeddings, GET /v1/models) on CPU, with an open multilingual model run by ONNX
 * Runtime through transformers.js. It stands in for a model server such as vLLM or TEI where
 * the build container cannot pull one, so retrieval can search across languages without a
 * paid API. The gateway reaches it as an openai_compatible provider; the model's query
 * instruction is the gateway's to add (query_instruction in the gateway config).
 *
 *   npm ci --prefix infra/local-embeddings
 *   node infra/local-embeddings/server.ts            # http://127.0.0.1:8090/v1
 *
 * Behind an HTTPS proxy, Node's fetch uses it only with NODE_USE_ENV_PROXY=1, and trusts its
 * certificate authority only with NODE_EXTRA_CA_CERTS. On the build container's 4 CPUs the
 * 8-bit model embeds the company drive (542 passages) in about half an hour.
 *
 * LOCAL_EMBEDDINGS_MODEL (default onnx-community/Qwen3-Embedding-0.6B-ONNX), LOCAL_EMBEDDINGS_DTYPE
 * (q8, the 8-bit weights) and LOCAL_EMBEDDINGS_PORT (8090) change it. The model is downloaded
 * from huggingface.co once, into .data/models.
 *
 * Its dependencies stay out of the pnpm workspace, because ONNX Runtime alone is over 500 MB
 * and only runs that embed for real need it.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { env, pipeline } from "@huggingface/transformers";

const MODEL = process.env.LOCAL_EMBEDDINGS_MODEL ?? "onnx-community/Qwen3-Embedding-0.6B-ONNX";
const DTYPE = (process.env.LOCAL_EMBEDDINGS_DTYPE ?? "q8") as "q8";
const PORT = Number(process.env.LOCAL_EMBEDDINGS_PORT ?? 8090);
// Texts of a batch are padded to the longest, so a batch holds texts of similar length.
const BATCH = 8;

env.cacheDir = fileURLToPath(new URL("../../.data/models/", import.meta.url));
const started = Date.now();
const extract = await pipeline("feature-extraction", MODEL, { dtype: DTYPE });
console.log(`${MODEL} (${DTYPE}) loaded in ${((Date.now() - started) / 1000).toFixed(1)} s`);

async function embed(texts: string[]): Promise<{ vectors: number[][]; tokens: number }> {
  const lengths = texts.map((t) => extract.tokenizer.encode(t).length);
  const order = texts.map((_, i) => i).sort((a, b) => (lengths[a] ?? 0) - (lengths[b] ?? 0));
  const vectors = new Array<number[]>(texts.length);
  for (let at = 0; at < order.length; at += BATCH) {
    const batch = order.slice(at, at + BATCH);
    // Qwen3-Embedding reads the last token's state, normalized for cosine similarity.
    const out = await extract(
      batch.map((i) => texts[i] as string),
      { pooling: "last_token", normalize: true },
    );
    const rows = out.tolist() as number[][];
    batch.forEach((i, j) => {
      vectors[i] = rows[j] as number[];
    });
  }
  return { vectors, tokens: lengths.reduce((a, b) => a + b, 0) };
}

// One request at a time: the model already uses every core.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work);
  queue = run.catch(() => undefined);
  return run;
}

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function reply(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

createServer((req, res) => {
  (async () => {
    if (req.method === "GET" && req.url === "/v1/models") {
      return reply(res, 200, { object: "list", data: [{ id: MODEL, object: "model" }] });
    }
    if (req.method !== "POST" || req.url !== "/v1/embeddings") {
      return reply(res, 404, { error: { message: `no route ${req.method} ${req.url}` } });
    }
    const request = (await body(req)) as { input?: unknown };
    const input = typeof request.input === "string" ? [request.input] : request.input;
    if (!Array.isArray(input) || !input.length || !input.every((t) => typeof t === "string")) {
      return reply(res, 400, { error: { message: "input must be a string or a non-empty array of strings" } });
    }
    const { vectors, tokens } = await serial(() => embed(input));
    reply(res, 200, {
      object: "list",
      model: MODEL,
      data: vectors.map((embedding, index) => ({ object: "embedding", index, embedding })),
      usage: { prompt_tokens: tokens, total_tokens: tokens },
    });
  })().catch((error: unknown) => reply(res, 500, { error: { message: String(error) } }));
}).listen(PORT, "127.0.0.1", () => console.log(`embeddings on http://127.0.0.1:${PORT}/v1`));
