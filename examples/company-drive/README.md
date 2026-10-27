# A company drive, as it really looks

A company's documents as they are found in practice, built only from real public text, for
measuring whether the engine answers with what is in force when older copies, older
revisions and lagging translations sit beside the current documents. 150 questions, a third
each in English, Chinese and Japanese, are put to the engine and to two rivals over the same
documents and model: plain retrieval over the same chunks, and a model that reads every
document. A Chinese copy is in [README.zh.md](README.zh.md); if the two differ, this English
version wins.

```bash
pnpm bench ingest examples/company-drive --today 2026-10-27 --context 1000000   # in memory, about 50 seconds
```

`--context` gives the long-context rival a window of a million tokens: the drive is 311,106
tokens, more than the default 150,000. `apps/bench/test/company-drive.test.ts` checks every
key entry against its file and holds the run to the numbers below.

## What is on the drive

Every sentence is as its author wrote it; only the arrangement is staged. `files.yaml` says
where each file comes from, at which revision, when it was last changed (the loader gives
each file that modified time, as a drive would report it) and what it stands for.

| Folder | Source in `corpus.yaml` | What it holds |
| --- | --- | --- |
| `handbook/finance/` | Handbook, governed, authority 0.9 | GitLab's Global Travel and Expense Policy as of 2026-09-13, and beside it a backup someone kept of the 2024-02-08 version |
| `../kubernetes-docs/docs/` | Engineering docs, governed, 0.9 | the five Kubernetes pages of [examples/kubernetes-docs](../kubernetes-docs/), each in English, Chinese and Japanese, the Japanese up to three years behind |
| `drive/finance/`, `drive/downloads/` | Shared drive, reference, 0.5 | older copies of the expense policy that people saved: 2023-02-08, 2022-05-31 and 2021-06-23 |
| `drive/research/{en,ja,zh}/` | the same | Wikipedia's Shinkansen article in each language, the current revision and one from October 2024 |

The policy files are GitLab's page at the commit named, unchanged (© GitLab Inc. and
contributors, [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)). The
articles are by Wikipedia contributors, CC BY-SA 4.0: each is the Parsoid HTML of the
revision named, trimmed to its text. Kept are the article body, its headings, paragraphs,
lists and tables (infoboxes included) and figure captions, every text node unchanged;
removed are styles, reference markers and lists, navigation boxes, hidden maintenance
spans, edit links, and attributes other than `href`, `lang`, `colspan` and `rowspan`. The
Chinese revisions are the zh-cn variant. `.acl.yaml` lets the whole tenant read both
folders; `vocabulary.yaml` is the vocabularies of the GitLab and Kubernetes examples plus
five Shinkansen predicates.

## The answer key

`keys.yaml` gives 36 facts, each with its values by the day each took effect and, for every
value, where the drive states it: the file, its revision and the words, verbatim. It was
written by reading the files, not from the engine. The value in effect on `asked_on`
(2026-10-27) answers a question; the others are stale. A day comes from the document or its
history: for the policy, the version of GitLab's history in which the value first appears
([examples/gitlab-expenses](../gitlab-expenses/)); for the articles, the day the text gives
("fiscal 2023" is 2024-03-31, "in 2024" is 2024-01-01), else the earliest revision on the
drive that states it. A value of `null` means no document in use states the fact from that
day, though an old copy may: the 2021 download still lists monitor caps that left the
policy that December.

| Facts | Unchanged | Changed |
| --- | --- | --- |
| Expense policy (English only) | hotel, internet while traveling, US receipts, E-Group limit, new hire stipend, host gift, gift cap, co-working, client meals, domestic flight lead time | meals per day 100 → 120, claim deadline 30 → 90 days, monthly limit $5K → $10K, phone 200 → 50 → 80 → 100, home internet 80 → 100, dry cleaning 3 → 5 days, marketing purchases 2,500 → 5,000; monitor caps no longer stated |
| Kubernetes (three languages) | nodes, pods per node, pods per cluster, kubelet skew, grace period, backoff cap and reset, imagefs threshold | none |
| Shinkansen (three languages) | top speed, conventional and maglev records, opening day, seats | Sapporo opening 2031 → 2038, Tōkaidō passengers 159 → 161 million, full-gauge length 2,830 → about 2,951 km (only the Japanese article was behind), Chūō opening 2027 → 2034 |

To check an entry, open the URL `files.yaml` gives for the file (it names the revision),
find the quote and read the value and its conditions. The test checks that every quote is
in its file, with runs of spaces as one space and HTML tags removed, and that the revision
matches `files.yaml` or `examples/kubernetes-docs/sources.yaml`; whether the quote says what
the key says is a reader's check.

## The questions

`questions.yaml` asks each unchanged fact once per language, each changed fact twice, worded
differently, and nine questions nothing on the drive answers (parental leave, the size of a
ConfigMap, a pet on the Shinkansen), three per language: 150 questions, 50 per language, 69
about unchanged facts, 66 about changed ones and 15 that the drive in use does not answer.
The expense policy exists in English only, so its 52 questions in Chinese and Japanese ask
across languages, as staff of an international company would.

An answer is `right` when it contains a text of the value in effect and cites a document
that states it, and `stale` when it contains a text of an older value and none of the
current one. Texts match without case or thousands separators, a number only whole ("30" is
not in "300"). A right answer may also mention an old value; with real models, a judge has
to tell "90 days (an old copy says 30)" from an answer that hedges.

## Results with the stand-ins

Stand-ins answer every model task, so these numbers measure the pipeline, not model quality.

| Questions | Engine right, stale | Plain retrieval | Reading everything |
| --- | --- | --- | --- |
| All 150 | 47, 3 | 44, 6 | 49, 8 |
| Unchanged, 69 | 32, 0 | 32, 0 | 34, 0 |
| Changed, 66 | 13, 3 | 10, 5 | 13, 6 |
| Not answered by the drive, 15 | 2, 0 | 2, 1 | 2, 2 |
| In English, 50 | 28, 2 | 26, 5 | 31, 7 |
| In Chinese, 50 | 13, 1 | 10, 1 | 10, 0 |
| In Japanese, 50 | 6, 0 | 8, 0 | 8, 1 |

- In English, where the stand-ins can read the documents, the engine answers 9 of 22
  questions on changed facts right and 2 stale, plain retrieval 8 and 4, the model reading
  everything 11 and 5; on unchanged facts 19, 18 and 20 of 23.
- The engine answers from the latest edition of a document. Normalization pairs the
  documents that are editions of one text: the policy and its backup, the three copies on
  the drive, which share a fifth to two fifths of their sentences under the title they kept
  (Expenses), and the two revisions of each article. The 2021 download is an older edition
  of the copies saved since, so its "within 30 days" and its monitor caps, which left the
  policy that December, no longer answer; plain retrieval and the model reading everything
  still give both.
- Governance settles the rest without a person: the policy's 90 days and $120 hold over the
  backup and the copies.
- Across languages the stand-ins find little: the policy's 52 questions in Chinese and
  Japanese get one right answer. The stand-in search compares words and hashed vectors, so a
  Chinese question does not find an English sentence; a multilingual embedding model is
  needed to measure this.
- The stand-in answer writes whatever shares a quarter of the question's words, so it says
  "not stated" for 2 of the 15 questions nothing in force answers.
- The engine's 3 stale answers: the phone cap twice, because the stand-in does not read the
  policy's current one ("Policy is set at $100" under "Phone Service") and the 2023 copy is
  the latest edition of Expenses, since a renamed document is not paired with its old
  editions; and the Sapporo opening in Chinese, where the current article itself keeps
  "预计2031年开通" in a table row the stand-in quotes.
- What editions cost here: a statement the stand-in read only from the 2024 revision of the
  English article leaves with it, though the current revision says the same, so three
  answers on unchanged or changed Shinkansen facts that were right through such statements
  are not. The Chūō opening is no longer answered from the 2024 revision (2027), though the
  stand-in does not find the current one's 2034 either.

The reading check scores extraction against the key. Each place the key gives a value is
found when governance holds that value in the fact's slot from that file, misread when the
file is in the slot with other values only, and missed when it is not in the slot at all. Of
the 77 places of the 24 facts the catalogue names, the stand-in finds 42, misreads 21 and
misses 14, and it puts 262 values the key does not give into those slots, a precision of
14%: it takes a number from every sentence that has a fact's words, which in the Shinkansen
articles is most of them. The other 12 facts have no catalogue entry, so only answers find
their 36 places.

## On a real model

```
pnpm bench ingest examples/company-drive --gateway config/gateway.deepseek.yaml --dry-run
pnpm bench ingest examples/company-drive --gateway config/gateway.deepseek.yaml --valkey <url>
```

The dry run answers with the stand-ins but meters their calls at the config's prices, with a
prefix cache like the provider's. For all 150 questions it estimates 1.04 USD at full price:
extraction 0.36 for 339 windows, and answering 0.58, of which the model reading everything
takes 0.43. That model reads 48 million input tokens, all but 0.4 million served by the
prefix cache, because the corpus comes before each question. `--questions 30` asks a spread
of 30 and estimates 0.66 USD. Output lengths are the stand-ins', and embeddings and reranking
stay stand-ins. The real run keeps every reply in Valkey for 30 days, so running again on
unchanged documents and prompts pays only for what changed. The config's budget is a soft stop
for all the calls together at 5 USD a day: it refuses calls once the day's spend, with what
calls in flight hold, reaches the limit, but a call let in under it can cost more than it held,
so a day may exceed it by an amount only the balance bounds. On a database (`--stack`) it
counts the day's earlier runs too. The hard cap is the prepaid balance.

The design's pass bars apply to real models. What a real run needs is in
[docs/design/validation.md](../../docs/design/validation.md).
