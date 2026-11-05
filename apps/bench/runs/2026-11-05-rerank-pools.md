# 2026-11-05: how many texts the reranker reads

MVP slice 3 ([the MVP plan](../../../docs/design/mvp.md)) asks for "a reranker off the CPU or a
shallower one", chosen with the free search-only check before the trial. This run is that check
for the shallower one: the company drive's 135 answerable questions, searched with the reranker
reading 30, 20, 15 and 10 passages and as many statements, every model reply replayed from
earlier runs. Nothing was paid. A Chinese copy is in
[2026-11-05-rerank-pools.zh.md](2026-11-05-rerank-pools.zh.md).

The full record is in the project's shared files, `inspiration/validation/runs/2026-11-05-rerank-pools/`:
the script, the gateway config, each pool's log and JSON report, and the reranker timings with the
script that took them.

## Conclusions

- **15 passages and 15 statements keep what 30 and 30 find, at half the reranker's work.** The
  answer is in what the engine reads for 130 of 135 questions at 15 against 131 at 30, in the
  compact answer for 125 against 126, and in the mature RAG's for 130 against 131. The one the
  engine loses is a Japanese question on the Tokaido Shinkansen's yearly passengers, whose first hit was
  already 29th of 30.
- **10 is too shallow**: 126, 123 and 127, with three changed facts lost in every language.
- **The reranker's time follows the texts it reads.** On this container's 4 CPUs it took a median
  5.7 s for 60 texts, 4.2 s for 40, 2.9 s for 30 and 2.0 s for 20. The engine's real passages are
  longer than these samples: on [2026-11-01](2026-11-01-compact.md) its 60 texts took a median
  9.1 s, so 30 should take about 4.6 s here. That is the CPU's share of a whole answer; the model
  answers in about 1.4 s.
- **The pools change to 15 and 15** (`RERANK_POOL`, `STATEMENT_POOL` in
  `engine/retrieval/src/search.ts`). The mature RAG keeps reranking 30 passages (`MATURE_POOL`),
  as in every run it was measured in, since it reads 16 and a rival is not made weaker by the
  engine's choice: against it the engine finds 130 to its 131. In these runs the rival shared the
  pool, so its row below shows what it would lose at each depth.
- Taking the reranker off the CPU, onto a small GPU or a hosted `bge-reranker-v2-m3`, is a
  separate choice for the trial server; this run does not measure it.

## What ran

Commit `e9d86b3` (main after #192), with only the two constants changed per run by `pools.sh`:

```bash
DEEPSEEK_SEARCH_ONLY_KEY=none pnpm bench ingest examples/company-drive --today 2026-10-27 \
  --context 1000000 --gateway gateway.rerank-pools.yaml --stack --search-only --json pool-<n>.json
```

`gateway.rerank-pools.yaml` is `config/gateway.local-embeddings.yaml` without its route that
gives question translation to the stand-in, so the translations replay from the 2026-11-01 replies
as the engine would ask them. Embeddings are Qwen3-Embedding-0.6B and the reranker
bge-reranker-v2-m3 (8-bit), both on the CPU through `infra/local-embeddings`. Rerank scores are
cached per question and text, so the shallower pools replayed nearly all of theirs from pool 30's
run; the timings come from a separate script (`time.mjs`) that sends the local server three
requests of each size, cut from the drive's documents, while nothing else ran.

## What it cost

Nothing: every completion replayed from the response cache (`cache_only`), embeddings and
reranks ran locally.

## Results

| Rerank pool, passages and statements | 30 | 20 | 15 | 10 |
| --- | --- | --- | --- | --- |
| In what the engine reads, of 135 | 131 | 130 | 130 | 126 |
| In the compact answer | 126 | 126 | 125 | 123 |
| In the compact answer's statements alone | 96 | 87 | 82 | 73 |
| In the mature RAG's passages | 131 | 130 | 130 | 127 |
| Changed facts, of 66: engine, compact | 65, 61 | 64, 61 | 64, 60 | 61, 58 |
| Unchanged facts, of 69: engine, compact | 66, 65 | 66, 65 | 66, 65 | 65, 65 |
| Median tokens read: engine, compact, mature RAG | 5,506, 1,737, 10,407 | 5,432, 1,666, 10,398 | 4,945, 1,647, 9,691 | 3,501, 1,566, 6,458 |
| Reranker, median seconds on 4 CPUs (sample texts) | 5.7 | 4.2 | 2.9 | 2.0 |

At 15 the compact answer loses two and gains one: it loses the Chinese question on the expense
claim deadline and the English one on the length of the full-gauge Shinkansen lines, and gains the Chinese
question on the Tokaido Shinkansen's yearly passengers.
