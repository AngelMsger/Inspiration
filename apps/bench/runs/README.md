# Validation runs

Every run on a paid model leaves a log here, so that a later evaluation starts from what
earlier runs found and pays only for what has changed since. A Chinese copy is in
[README.zh.md](README.zh.md); if the two differ, this English version wins.

| Run | Model | What it answered | Cost |
| --- | --- | --- | --- |
| [2026-10-27, DeepSeek first run](2026-10-27-deepseek.md) | deepseek-flash, thinking off | Reading: recall 77%, precision 53% (86% without one slot). 150 questions: engine 71, plain retrieval 60, reading everything 140; the engine is limited by stand-in search. Replay: 0.35 asks per changed fact | CNY 6.61 (US$0.93) |
| [2026-10-27, search with a real embedding](2026-10-27-search.md) | none: Qwen3-Embedding-0.6B on CPU, over the first run's replies | Where the first run lost its answers: stand-in vectors and reranker, and ~80-token snippets. With a real embedding, no reranker and whole passages, the answer is in what the model reads for 116 of 135 questions (64 before); with the top 3 documents, 125 | none |

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
