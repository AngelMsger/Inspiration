# Validation runs

Every run on a paid model leaves a log here, so that a later evaluation starts from what
earlier runs found and pays only for what has changed since. A Chinese copy is in
[README.zh.md](README.zh.md); if the two differ, this English version wins.

| Run | Model | What it answered | Cost |
| --- | --- | --- | --- |
| [2026-10-27, DeepSeek first run](2026-10-27-deepseek.md) | deepseek-flash, thinking off | Reading: recall 77%, precision 53% (86% without one slot). 150 questions: engine 71, plain retrieval 60, reading everything 140; the engine is limited by stand-in search. Replay: 0.35 asks per changed fact | CNY 6.61 (US$0.93) |
| [2026-10-27, search with a real embedding](2026-10-27-search.md) | none: Qwen3-Embedding-0.6B on CPU, over the first run's replies | Where the first run lost its answers: stand-in vectors and reranker, and ~80-token snippets. With a real embedding, no reranker and whole passages, the answer is in what the model reads for 116 of 135 questions (64 before); with the top 3 documents, 125 | none |
| [2026-10-27, answers read whole passages](2026-10-27-whole.md) | deepseek-flash, thinking off, with Qwen3-Embedding-0.6B and no reranker; answers only, reading from the first run's replies | 150 questions: engine 116, plain retrieval 109, reading everything 140 (120, 112 and 140 with two gaps in the key corrected). The 24 left: search 14, the renamed 2023 copy 4, the key 4, the model 3, less 1 the other way | CNY 1.46 |
| [2026-10-28, a real reranker and the handbook's real conflicts](2026-10-28-rerank.md) | none: bge-reranker-v2-m3 and Qwen3-Embedding-0.6B on CPU, over the earlier runs' replies | With a real reranker the answer is in what the engine reads for 125 of 135 questions (116 before), and in the mature RAG's 16 passages for 128. 16 handbook pages, 1,447 versions since 2023: 4 real conflicts, so the decisive test builds its cases on the real text | none |
| [2026-11-01, a compact answer, a mature RAG and a fast model](2026-11-01-compact.md) | deepseek-flash, thinking off, on the reranker and query translation; gpt-6-luna, reasoning off, for answers only; reading from earlier runs' replies | 150 questions on DeepSeek: mature RAG 137, engine 134, compact answer 128, at 9,936, 5,538 and 2,075 input tokens an answer; on Luna, 134, 134 and 129; the gap is a renamed 2023 copy and two passages too few for one long article | CNY 2.95 and US$0.28 |
| [2026-11-02, the decisive test](2026-11-02-decisive.md) | deepseek-flash, thinking off, on the reranker and query translation; two topics in a 17.8M-token searched corpus | 276 questions, after a hand check: long context 252, governed long context 243, Inspiration 239, mature RAG 233, compact answer 233; +2.9 points over the mature RAG on changed and conflicting facts, against an aim of 10. Governance's provisional choices, with nobody deciding, lost announced changes and one side of governed disagreements | CNY 17.06 |

## What a log holds

- **Conclusions first**: what the run settled, and what it left open.
- **What ran**: the commit, the exact commands, the gateway config with the model ID and its
  request options, and the prompt version of every task.
- **What it cost**: tokens by task, with how many came from the provider's prefix cache and
  how many from the response cache, and the real charge, read from the provider's balance
  before and after.
- **The results**, beside the stand-in numbers of the same command.

A log is a record: once its run is reported, it is not edited, except to link the run that
replaces a conclusion.

## Reusing a run's replies

The gateway caches every reply it gets (`cache` in the gateway config), keyed by the model,
its request options, the task, the prompt version and the messages. A run's replies are
exported when it ends and kept with its JSON report in the project's shared files, under
`inspiration/validation/runs/<date>/`, since the container that ran it does not last. Before
the next run, import them:

```bash
pnpm bench cache import <replies.jsonl> --stack --gateway config/gateway.deepseek.yaml
pnpm bench ingest examples/company-drive ... --stack     # pays only for calls no earlier run made
pnpm bench cache export <new replies.jsonl> --stack
```

A call is paid again only when its key changes: a new prompt version, another model or
request option, or different text in a window. So a fix to answering reruns the questions
and nothing else, and a fix to one prompt rereads only what that prompt reads.

The file is a backup of replies this project's gateway produced, and is trusted for nothing
more. No reply in it is checked against the provider, and whoever edits it can plant replies,
so it is imported only into a bench cache, never into a shared or production one. Because it
is the only copy of paid replies once the container is gone, `cache import` checks every line
first: when one does not parse, or lacks its key or reply, it names each broken line and
writes nothing.
