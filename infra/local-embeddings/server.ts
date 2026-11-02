#!/usr/bin/env node
/**
 * A local model server for development and validation runs: the OpenAI embeddings API
 * (POST /v1/embeddings, GET /v1/models) and the Jina-style rerank API (POST /v1/rerank) on
 * CPU, with open multilingual models run by ONNX Runtime through transformers.js. It stands
 * in for a model server such as vLLM or TEI where the build container cannot pull one, so
 * retrieval can search and rerank across languages without a paid API. The gateway reaches
 * it as an openai_compatible provider; the embedding model's query instruction is the
 * gateway's to add (query_instruction in the gateway config).
 *
 *   npm ci --prefix infra/local-embeddings
 *   node infra/local-embeddings/server.ts            # http://127.0.0.1:8090/v1
 *
 * Behind an HTTPS proxy, Node's fetch uses it only with NODE_USE_ENV_PROXY=1, and trusts its
 * certificate authority only with NODE_EXTRA_CA_CERTS. On the build container's 4 CPUs the
 * 8-bit model embeds the company drive (542 passages) in about half an hour.
 *
 * LOCAL_EMBEDDINGS_MODEL (default onnx-community/Qwen3-Embedding-0.6B-ONNX), LOCAL_EMBEDDINGS_DTYPE
 * (q8, the 8-bit weights) and LOCAL_EMBEDDINGS_PORT (8090) change it. The reranker,
 * LOCAL_RERANK_MODEL (default onnx-community/bge-reranker-v2-m3-ONNX, 8-bit), is a
 * cross-encoder loaded on the first rerank request; it reads the query and each document
 * together, up to LOCAL_RERANK_TOKENS (1024) tokens, the document cut to fit. Models are
 * downloaded from huggingface.co once, into .data/models.
 *
 * Its dependencies stay out of the pnpm workspace, because ONNX Runtime alone is over 500 MB
 * and only runs that embed for real need it.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import {
  AutoModelForSequenceClassification,
  AutoTokenizer,
  env,
  type PreTrainedModel,
  type PreTrainedTokenizer,
  pipeline,
  type Tensor,
} from "@huggingface/transformers";

const MODEL = process.env.LOCAL_EMBEDDINGS_MODEL ?? "onnx-community/Qwen3-Embedding-0.6B-ONNX";
const DTYPE = (process.env.LOCAL_EMBEDDINGS_DTYPE ?? "q8") as "q8";
const PORT = Number(process.env.LOCAL_EMBEDDINGS_PORT ?? 8090);
const RERANK_MODEL = process.env.LOCAL_RERANK_MODEL ?? "onnx-community/bge-reranker-v2-m3-ONNX";
const RERANK_TOKENS = Number(process.env.LOCAL_RERANK_TOKENS ?? 1024);
// Texts of a batch are padded to the longest, so a batch holds texts of similar length.
const BATCH = 8;
// A batch's attention takes memory in proportion to its size times its longest length squared:
// ONNX Runtime refuses a mask over 4 GiB, which a batch of 8 reaches at about 2,900 tokens, and
// one 4,096-token text ran the container out of memory. So a batch of long texts is smaller,
// and a text is cut to its first LOCAL_EMBEDDINGS_TOKENS tokens, as embedding services truncate.
const EMBED_TOKENS = Number(process.env.LOCAL_EMBEDDINGS_TOKENS ?? 2048);
const BATCH_AREA = BATCH * 1024 * 1024;

env.cacheDir = fileURLToPath(new URL("../../.data/models/", import.meta.url));
const started = Date.now();
const extract = await pipeline("feature-extraction", MODEL, { dtype: DTYPE });
console.log(`${MODEL} (${DTYPE}) loaded in ${((Date.now() - started) / 1000).toFixed(1)} s`);

async function embed(texts: string[]): Promise<{ vectors: number[][]; tokens: number }> {
  const inputs = texts.map((t) => {
    const ids = extract.tokenizer.encode(t);
    return ids.length > EMBED_TOKENS
      ? {
          text: extract.tokenizer.decode(ids.slice(0, EMBED_TOKENS), { skip_special_tokens: true }),
          tokens: EMBED_TOKENS,
        }
      : { text: t, tokens: ids.length };
  });
  const lengths = inputs.map((i) => i.tokens);
  const order = texts.map((_, i) => i).sort((a, b) => (lengths[a] ?? 0) - (lengths[b] ?? 0));
  const vectors = new Array<number[]>(texts.length);
  for (let at = 0; at < order.length; ) {
    // Sorted by length, so the batch's last text is its longest.
    let size = 1;
    while (size < BATCH && at + size < order.length) {
      const longest = lengths[order[at + size] as number] ?? 0;
      if ((size + 1) * longest * longest > BATCH_AREA) break;
      size++;
    }
    const batch = order.slice(at, at + size);
    at += size;
    // Qwen3-Embedding reads the last token's state, normalized for cosine similarity.
    const out = await extract(
      batch.map((i) => inputs[i]?.text as string),
      { pooling: "last_token", normalize: true },
    );
    const rows = out.tolist() as number[][];
    batch.forEach((i, j) => {
      vectors[i] = rows[j] as number[];
    });
  }
  return { vectors, tokens: lengths.reduce((a, b) => a + b, 0) };
}

let reranker: Promise<{ tokenizer: PreTrainedTokenizer; model: PreTrainedModel }> | undefined;

function loadReranker() {
  reranker ??= (async () => {
    const at = Date.now();
    const [tokenizer, model] = await Promise.all([
      AutoTokenizer.from_pretrained(RERANK_MODEL),
      AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL, { dtype: DTYPE }),
    ]);
    console.log(`${RERANK_MODEL} (${DTYPE}) loaded in ${((Date.now() - at) / 1000).toFixed(1)} s`);
    return { tokenizer, model };
  })();
  return reranker;
}

/** How relevant each document is to the query, from 0 to 1: the cross-encoder's logit through a sigmoid. */
async function rerank(query: string, documents: string[]): Promise<{ scores: number[]; tokens: number }> {
  const { tokenizer, model } = await loadReranker();
  // The document is cut, not the query, and before pairing, so the closing separator stays.
  const room = Math.max(16, RERANK_TOKENS - tokenizer.encode(query).length - 4);
  const pairs = documents.map((d) => {
    const ids = tokenizer.encode(d, { add_special_tokens: false });
    return ids.length > room
      ? { text: tokenizer.decode(ids.slice(0, room)), length: room }
      : { text: d, length: ids.length };
  });
  const order = pairs.map((_, i) => i).sort((a, b) => (pairs[a]?.length ?? 0) - (pairs[b]?.length ?? 0));
  const scores = new Array<number>(documents.length);
  let tokens = 0;
  for (let at = 0; at < order.length; at += BATCH) {
    const batch = order.slice(at, at + BATCH);
    const inputs = tokenizer(
      batch.map(() => query),
      {
        text_pair: batch.map((i) => pairs[i]?.text as string),
        padding: true,
        truncation: true,
        max_length: RERANK_TOKENS,
      },
    );
    tokens += Number((inputs.attention_mask as Tensor).sum().item());
    const { logits } = (await model(inputs)) as { logits: Tensor };
    const rows = logits.sigmoid().tolist() as number[][];
    batch.forEach((i, j) => {
      scores[i] = rows[j]?.[0] as number;
    });
  }
  return { scores, tokens };
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

const server = createServer((req, res) => {
  (async () => {
    if (req.method === "GET" && req.url === "/v1/models") {
      const data = [MODEL, RERANK_MODEL].map((id) => ({ id, object: "model" }));
      return reply(res, 200, { object: "list", data });
    }
    if (req.method === "POST" && req.url === "/v1/rerank") {
      const request = (await body(req)) as { query?: unknown; documents?: unknown; top_n?: unknown };
      const { query, documents } = request;
      if (typeof query !== "string" || !Array.isArray(documents) || !documents.every((d) => typeof d === "string")) {
        return reply(res, 400, { error: { message: "query must be a string and documents an array of strings" } });
      }
      const { scores, tokens } = documents.length
        ? await serial(() => rerank(query, documents))
        : { scores: [], tokens: 0 };
      const results = scores
        .map((relevance_score, index) => ({ index, relevance_score }))
        .sort((a, b) => b.relevance_score - a.relevance_score)
        .slice(0, typeof request.top_n === "number" ? request.top_n : undefined);
      return reply(res, 200, { model: RERANK_MODEL, results, usage: { prompt_tokens: tokens, total_tokens: tokens } });
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
});
// Requests wait their turn for minutes, and a client reuses its idle sockets for longer than
// Node's 5 seconds: neither may close a socket under a request.
server.requestTimeout = 0;
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.listen(PORT, "127.0.0.1", () => console.log(`embeddings and reranking on http://127.0.0.1:${PORT}/v1`));
