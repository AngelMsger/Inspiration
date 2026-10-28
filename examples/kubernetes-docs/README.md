# Kubernetes documentation in three languages

Five pages of the Kubernetes documentation, each in English and in its official Chinese and
Japanese translations, for measuring extraction and governance across languages. Knowledge
does not depend on the language it is written in, so a page and its translations should give
each fact one value and count as one source. The translations are not all current: three of
the Japanese pages are two to three years older than their English originals. A Chinese copy
is in [README.zh.md](README.zh.md); if the two differ, this English version wins.

```bash
pnpm bench ingest examples/kubernetes-docs   # in memory, about 3 seconds
pnpm bench ask examples/kubernetes-docs "How many nodes can a Kubernetes cluster have at most?"
```

After the usual report, the control check (as in [examples/control](../control/README.md))
prints each page as **right**, **known gap** (it differs the way `expected.yaml` records) or
**differs**, and the question check does the same for each question of `questions.yaml`.
`apps/bench/test/kubernetes.test.ts` runs both in memory and on Postgres. `ask` answers one
question as the corpus's reader, with its citations and notes.

## Files

| File | What it holds |
| --- | --- |
| `docs/` | 15 pages: `x.html` in English, `x.zh-cn.html` and `x.ja.html` its translations, which the folder source reads as such from their names |
| `sources.yaml` | for each file, the URL, the kubernetes/website commit, the date the page footer gives and the SHA-256 of the page as served |
| `vocabulary.yaml` | the 11 facts followed, each named as the English, Chinese and Japanese pages word it |
| `expected.yaml` | the answers, and where the engine gives others today and why |
| `questions.yaml` | 12 questions in the three languages, with the texts a right answer contains and the pages it cites, and where the engine answers otherwise today and why |
| `corpus.yaml` | one governed folder source |

## Source and licence

The pages are from [kubernetes.io](https://kubernetes.io), fetched on 2026-10-27. They are
© The Kubernetes Authors, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
Each file is the page's content element (class `td-content`), unchanged, up to the feedback
block that ends it, in a minimal document that adds the page's title and language;
`sources.yaml` links each one to its page and commit.

| Page | English | Chinese | Japanese | Facts followed |
| --- | --- | --- | --- | --- |
| setup/best-practices/cluster-large | 2026-02-08 | 2026-05-06 | 2023-03-10 | nodes, pods per node, pods and containers in a cluster |
| releases/version-skew-policy | 2026-04-14 | 2026-07-06 | 2026-04-14 | how many minor versions a kubelet may be older |
| concepts/scheduling-eviction/node-pressure-eviction | 2026-07-21 | 2026-09-05 | 2026-06-08 | three default hard eviction thresholds |
| concepts/workloads/pods/pod-lifecycle | 2026-07-27 | 2026-10-10 | 2024-02-06 | termination grace period, restart delay cap, restart delay reset |
| concepts/architecture/garbage-collection | 2025-10-20 | 2025-12-18 | 2023-08-16 | none: a page that should add nothing to the facts |

## What the run shows

With the stand-in model, 1 of the 4 pages with facts is right, and the other 3 are known gaps
that are all the stand-in's:

- **Statements:** 29 of the 33 the answers expect are in their slot with their value, and 18
  more land in a slot or with a value they should not have.
- **Sources:** 9 of the 11 values have the expected sources, one each, across three languages.
- **Proposals:** 10 of 11 slots get the expected proposal.

What the engine does right throughout:

- **A page and its translations are one source.** Every value read in more than one language
  counts once, whichever of the three languages state it.
- **The original holds over its translation.** Seven values that only translations state,
  each of a page that states another value, are settled without a person: the stand-in's
  misreadings of the Japanese and Chinese pages (the 1.37 of "Kubernetes v1.37 では", the 10,
  20 and 40 seconds of a list of delays). The same rule settles a translation that has fallen
  behind: the test edits the English page to raise the node limit to 6,000, and 6,000 holds,
  the 5,000 only the translations still state settles without a person, and freshness gives
  both translations a review.
- **Old translations agree with their originals.** The Japanese pages from 2023 and 2024 state
  the same value for every fact followed. They leave out the sections added since, rather
  than state older values.

The real pages exposed two parsing bugs, now fixed. A line break in the HTML source split a
sentence, so the 10-minute reset was missed in English and Chinese. An ellipsis followed by a
comma ("(10s, 20s, 40s, …), that is capped at 300 seconds") ended a sentence, so the English
300 seconds were missed.

The stand-in's misses, which a model is expected not to make:

- **A generic alias:** "nodes" fits any passage that names nodes, so "memory.available<100Mi
  (Linux nodes)" puts 100 among the node limits.
- **Numbers in words:** "up to three minor versions older" has no digit, so the kubelet's skew
  is read from "1.25" instead.
- **Another unit:** the Japanese page gives the restart delay cap as "5分" (5 minutes), and the
  stand-in only reads seconds, where a model gives the catalogue's unit.
- **A word for every grace period:** the Japanese "猶予期間" also names the 0 seconds of a hard
  eviction and the 2 seconds a preStop hook is given.

`expected.yaml` gives each reason in full. One more finding from real text: the Chinese
eviction page leaves out the line for Windows nodes' memory default and attaches "(Windows
节点)" to the line after it, so a model reading it would put the node filesystem threshold
under Windows only. Nothing here follows that qualifier yet.

## Questions

The questions ask for the facts followed, in English, Chinese and Japanese, plus one that
nothing here answers. An answer is right when it contains an expected text and cites one of
the expected pages, in any of its languages. With stand-ins for the models (an answer made
of the source sentences sharing most of the question's words, and a reranker that counts
shared words), 9 of the 12 are right. The check also says whether the search the answer rests
on found an expected text at all: it did for all 11 questions with an answer, so the misses
are the stand-in answer's, not the search's. The answer reads each passage it is given
whole, so the item under a list's lead-in reaches it.

Each question is also put to two rivals with the same documents and stand-in model: a mature
RAG over the same chunks and search, without statements or governance, and a model that reads
all 15 pages at once (about 77,000 tokens by the engine's estimate); and to the engine reading
all 15 after governance. Each gets 8 of the 12 right. On pages that agree
with each other the knowledge layer is not expected to win; it is expected to win when a
fact changes, as below.

What the engine does right throughout:

- **The value that holds, whatever the language.** After the English page raises its node
  limit to 6,000, the question in Chinese is answered with the English 6,000, and a note says
  the Chinese page still states 5,000. The Chinese sentence that states 5,000 is not given to
  the answer: its statement is, marked as replaced, with the statement of the value that holds.
  The mature RAG over the same chunks still answers 5,000: its stand-in does not weigh the
  pages' dates, as a model told to would.
- **Notes only on the values an answer gives.** A conflict note comes with the node limit,
  which the stand-in extraction gives seven values, and not with answers about thresholds.
- **A question with no answer is a gap.** The passport question cites nothing and says so.

The misses, each recorded in `questions.yaml` with its reason:

- **Different words for the same thing:** "at most" against "no more than", and the Japanese
  上限 (upper limit) against 最大 (maximum).
- **Kana and kanji:** the Japanese question writes しきい値 and the page 閾値.

The same corpus is meant to run again once a real model is configured. Then the stand-in's
misses measure extraction quality, and the engine's part should stay as it is.
