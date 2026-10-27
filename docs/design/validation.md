# Validating the knowledge core

Status: proposed, 2026-10-27, after the product owner asked to validate the core value first: the knowledge part, which few products do well. The pass bars and the design changes below are proposals until the product owner agrees them. The engine thread runs every measurement and owns the benchmark code; this document is its specification. A Chinese copy is in [docs/zh/design/validation.md](../zh/design/validation.md).

## What we must prove

Inspiration is worth building if it does three things on the documents a company already has. It gives readers and agents the value that holds today, with the passage behind it. It does that more often than search over the same documents. And it asks people only about what the documents cannot settle.

Those documents repeat each other, contradict each other, lag in translation and change without notice. Every test below runs on real public documents of that kind, never on sentences we wrote. The business layer, accounts and permissions are left out: they are standard and certainly buildable.

## Five claims, and how each is tested

The core value breaks into five claims. Each needs its own test, because a miss in one hides behind the others: a right answer can come from luck in reading and a wrong one from a bug in deciding. The pass bars are proposals; we set them for good after the first run with a real model.

| Claim | What it means | Measured as | Proposed pass bar | Today |
| --- | --- | --- | --- | --- |
| 1. Reading | A model turns real text into statements: the right value in the right fact slot, with a verbatim quote | Recall and precision per followed fact against the answer key; values invented where the text states none | Recall at least 85%, precision at least 90%, invented values at most 1% | Cannot be measured yet. The stand-in reads 92 of the 212 values GitLab's policy states, reads 13 wrongly and invents none; a real model is needed |
| 2. Deciding | From those statements, governance gives the value that holds: a newer version replaces an older one on its date, an original holds over its translation, copies count once, a fact a page stops stating is kept and marked, and one fact in English, Chinese and Japanese is one piece of knowledge | Share of fact-versions where the reader gets the key's value, counting only the cases reading got right | 100%: the rules are deterministic, so any miss is a bug to fix | Right in every case the engine owns: GitLab 21 versions, Kubernetes 15 pages in three languages, control 6 of 8 (the other 2 are the stand-in's) |
| 3. Answering | On questions about facts that changed, conflict or exist in several languages, answers from governed knowledge beat plain RAG over the same documents and model | Right answers; stale answers; wrong answers given with confidence; citations that quote the source; "not stated" when nothing states it | No worse than plain RAG on facts that never changed, at least 20 points better on facts that changed or conflict, stale answers at most 5% | Runs end to end with stand-ins (PRs #32, #34). On the 150 questions over the company-as-it-looks corpus, right and stale answers are 48 and 5 for Inspiration, 44 and 6 for plain RAG, and 49 and 8 for long context (the whole 311,106-token corpus in a 1M-token window). On the 66 questions about changed facts: 14 and 4, 10 and 5, 13 and 6. On the 69 about unchanged facts: 32, 32 and 34 right, none stale. In English alone, where the stand-in search works, the 22 changed facts get 11, 8 and 11 right. Of 52 questions asking about the policy in Chinese or Japanese, 1 is right, because the stand-in search cannot cross languages. The stand-ins say "not stated" for 2 of 15. These numbers measure the pipeline, not reading |
| 4. Asking little | People are asked only what the documents cannot settle, and agree the question was worth asking | Todos per changed fact; share settled without a person; share of todos a reviewer marks "worth asking" | At most 1 todo per changed fact; at least 80% marked worth asking | GitLab replay with stand-ins (PR #33): after the first read, 20 versions change 20 facts and people are asked 4 times (2 todos raised, and an open todo given more to decide twice), 0.2 per changed fact; one todo is withdrawn later without a person. Only 1 of the 4 is worth asking (the 2026-03-18 notice that the page moved); the other 3 are the stand-in misreading the text, so 25% today, waiting on a real model |
| 5. Cost | Reading and answering cost little enough for a seat price to carry | Tokens per 1,000 words read; tokens per answer; share of documents that need a model at all | Reported, not gated, until pricing is set | Cannot be measured before a real model |

## Real documents to test on

Three corpora are built, a fourth is fetched, and a fifth would close a gap. All are public, licensed for reuse, and kept byte for byte with their source and revision in a manifest.

| Corpus | Languages | What it tests | State |
| --- | --- | --- | --- |
| GitLab's expense policy, 21 versions from 2020 to 2026 ([examples/gitlab-expenses](../../examples/gitlab-expenses)) | English | Values that change, appear and stop being stated; a page that moves away and comes back | Built (PR #27) |
| Kubernetes documentation, 5 pages with their official translations ([examples/kubernetes-docs](../../examples/kubernetes-docs)) | English, Chinese, Japanese | One fact in three languages; Japanese pages two to three years behind | Built (PR #29) |
| Wikipedia: Kubernetes, Tokyo, Shinkansen, today and two years ago | English, Chinese, Japanese | Long, loosely written text; facts that changed in two years; three articles written separately, not translated | The Shinkansen articles in all three languages, current and October 2024, are in the company-as-it-looks corpus (PR #34); the rest are not used yet |
| More GitLab handbook pages with history (leave, travel, onboarding, security, about 10 pages) | English | The closest public stand-in for a company's own policies, at a real rate of change | Proposed |
| A company as it really looks, built only from the texts above ([examples/company-drive](../../examples/company-drive)) | All three | Old versions left beside new ones ("the copy someone saved in 2022"), lagging translations, an old article next to the current one | Built (PR #34): GitLab's policy now, a 2024 backup and three older copies on a reference shared drive, the Kubernetes pages and the Shinkansen articles; 311,106 tokens |

In the last corpus every sentence is real. Only the arrangement is staged, and the manifest records which file is a stale copy. That is the situation where plain search goes wrong and Inspiration should not.

One gap remains: policy-like text written first in Chinese or Japanese, with dated revisions. All our Chinese and Japanese policy text is translated from English. The Chinese and Japanese Wikipedia articles are originals, but not policies. The best fix is a design partner's real documents, used with their permission, as the last step.

## Answer keys written by hand before any run

A result means something only if the right answer was fixed before the run, from the documents themselves. The GitLab timeline, the Kubernetes answers and the company-as-it-looks key (PR #34) work this way. That key has 36 facts and 113 entries, each with its file, revision and verbatim quote, and a test checks every quote and revision. Its 150 questions are 50 per language: 69 about unchanged facts, 66 about changed ones (two phrasings per language) and 15 that the documents in use do not answer.

1. **Read from the documents.** Every expected value names its file, revision and the quoted passage.
2. **A value per date.** Each fact gets its value from each date it changed, so "what is the hotel cap on 2023-09-01?" has one right answer.
3. **A second reader.** Someone other than the author checks 20 random entries, and every disagreement is settled and recorded. Our first key already needed this: it said GitLab's phone cap stopped being stated in August 2023, but the page still states it under its Phone Service heading ($80, then $100 from 2026-06-19). We propose the product owner or a teammate does this; it takes about 30 minutes.
4. **The question set.** About 150 questions, a third each in English, Chinese and Japanese. Half ask about facts that never changed, half about facts that changed, conflict or appear only in a lagging translation. One in ten has "not stated" as its right answer, to catch invented values.
5. **Frozen.** A key is never edited to match a result. When a document changes, the key is written again and old runs are kept as they were.
6. **Scored by rule.** A value matches when it equals the key after units are normalized. Where a model judges a free-text answer, it judges only against the key, and a sample of its judgements is checked by hand. A right answer can still mention an old value beside the new one, so the judge also checks whether it hedges between them.

## The baseline: plain RAG on the same documents

The value of the knowledge layer shows only against what people use today. So every question runs three times: through Inspiration and through two rivals, with the same documents and model. The engine thread builds the rival runs and scores all three side by side.

- **Plain RAG.** The same retrieval with statements and governance turned off: passages are retrieved and the model answers from them with citations. This is what most knowledge products do, RAGFlow among them.
- **Long context, where it fits.** For a small corpus, the model reads every document with its date and answers. It is the strongest simple rival. If Inspiration cannot beat it on answers, the layer has to earn its place on cost, on change alerts and on owners' work instead.

All three runs report the same numbers as claim 3, plus tokens and time per answer. Whatever Inspiration wins is what reading once, governing and keeping history are worth.

## What the real documents have already shown

Deciding is ready to be measured with a real model; reading is the open risk. The first runs on real text, all with the stand-in model, taught six things invented sentences never would have.

- **Real text is hard to read.** The stand-in missed "$10K", amounts in table cells, HTML tables, a rule with no number ("receipts are required for all expenses" means a threshold of 0), numbers in words ("up to three minor versions older") and another unit ("5分" in Japanese). These are the cases a real model must get right.
- **Real text found engine bugs.** A line break in the HTML split a sentence, "…)," ended one, and a long real heading made the gateway refuse every topic name in an answer. All three are fixed.
- **The baseline and the todo count found two more.** Statements were crowding the answer's own passages out of its sources; an answer now reads 8 passages plus 8 statements. And a fact stated in two places raised a todo when one of the places was removed. Both are fixed.
- **Real text found two missing rules, now built.** A fact a page stopped stating used to vanish without notice (20 of GitLab's fact-versions); it is now kept and marked, with one todo. Copies and translations used to count as separate sources; they now count once.
- **The company-as-it-looks corpus found one more fix and one gap.** A value that only a reference copy states, older than the governed document, is now out of date: the 2021 copy's 30 days no longer answers beside the policy's 90, while plain RAG still answers 30. Still open: an old revision whose fact has no governing slot is read as current, as with the Chuo Shinkansen's opening in the 2024 Shinkansen articles. The engine thread works on copy and revision identity next.
- **Old translations leave out rather than contradict.** The Japanese Kubernetes pages from 2023 and 2024 state the same values as the English ones, and simply lack the newer sections.

## Order of work and cost

Four steps, each closed by a gate. Only step 2 needs anything from the product owner: a model key with a hard spending cap.

1. **Without a model (done, engine thread).** Write the answer keys and the 150 questions (PR #34), add the plain-RAG and long-context runs (PR #32), count todos per changed fact on the GitLab replay (PR #33), and assemble the company-as-it-looks corpus (PR #34). Gate met: all three runs score the same 150 questions end to end with the stand-ins, in 52 seconds in memory.
2. **A capped probe with a real model.** One model through the model gateway, with the cap set as the probe's gateway budget, and a multilingual embedding, because the stand-in search cannot match a Chinese or Japanese question to English text. It starts with a dry run and a context check ([What the probe costs](#what-the-probe-costs)). Gate: claims 1, 3 and 5 have real numbers.
3. **Fix and run again.** Work on prompts, the fact vocabulary and tables, then rerun the same keys. Gate: the pass bars are met, or a result from the next section changes the design.
4. **A design partner's documents.** A company's own documents, ideally written in Chinese or Japanese, run the same way with their permission. Gate: one of their owners marks which todos were worth asking (claim 4).

### What the probe costs

The cap is a hard stop, not a forecast: the gateway refuses every call once a budget is spent, so a run overshoots only by the calls already in flight. The estimate below decides what the first run includes; real counts replace it before any paid call.

- **Dry run.** The stand-in run sends every call through the gateway with the inputs a real model would get, so the gateway's metering gives each task's input tokens, including any task the table below leaves out, by its rough count of about four characters a token and one per Han or kana character. The budget is redone from those counts. A stand-in's output says nothing about a real model's, so output stays an estimate.
- **Context check.** The long-context window (`--context`) is set to the selected model's real limit. The company-as-it-looks corpus is 311,106 tokens, more than a 200,000-token window; where the documents do not fit, the long-context rival reports that instead of running.

| Part of one run | Input tokens | Output tokens | Runs again when |
| --- | --- | --- | --- |
| Reading every corpus: claims and chunk headers | About 4 to 5 million: about a million tokens of text, and each 1,500-character window also carries about 2,000 tokens of instructions and fact vocabulary | About 1 million | The reading prompts or the fact vocabulary change |
| Multilingual embeddings of chunks and statements | About 1.5 million | None | Chunking changes |
| Inspiration's answers to 150 questions: a rerank of 60 candidates, then an answer from 16 sources, per question | About 1.5 million | About 0.1 million | Answering changes |
| Plain RAG's answers to 150 questions | About 1 million | About 0.1 million | Answering changes |
| Long context's answers to 150 questions over the 311,106-token corpus | About 46.7 million: every question reads the whole corpus | Under 0.1 million | Answering changes |

No prompt caching is assumed. The answer input puts the question before the documents, so a provider's cache cannot reuse the documents from one question to the next.

At an example list price of US$3 per million input tokens and US$15 per million output tokens, one run costs about US$30 for reading, US$10 for the two retrieval-based answers, under US$1 for embeddings at embedding prices of cents per million tokens, and about US$140 for long context on all 150 questions; a provider that charges more above 200,000 tokens of context makes that last part dearer. Long context alone would exceed a US$100 cap, so the first run is proposed as:

- reading, embeddings, and Inspiration and plain RAG on all 150 questions: about US$40;
- long context on a sample of 30 questions, 10 per language, with changed and unchanged facts in proportion: about 9.3 million input tokens, US$28.

That first run is about US$70. Rerunning reading costs about US$30, and rerunning the answers (long context still on the sample) about US$38. So a US$100 cap covers the first run and leaves about US$30: enough to rerun reading once, not the answers. A cap of US$200 covers the first run, one rerun of reading and two of the answers. Long context on all 150 questions needs either a larger cap or a change to the answer input that puts the documents first and the question last: a provider that charges a tenth of the input price for cached reads would then bring all 150 to about US$15, if the questions run back to back within its cache lifetime.

The public data needs no sensitivity clearance, so any provider the gateway supports will do.

## Results that would change the design

A validation is worth running only if some results would change what we build. These are proposed now, before any result, so that no result can be explained away afterwards.

| If we see | It means | We change |
| --- | --- | --- |
| Reading recall under 70% after prompt work | Fact slots are too rigid for real wording | Keep slots for high-value facts (amounts, limits, deadlines, owners); keep the rest as open statements grouped by meaning, governed less strictly |
| Plain RAG within 5 points of us on changed facts | The governed layer does not pay for itself in answers | Lead with change alerts and owner reviews; make extract-on-use the default; answer with RAG checked against known statements |
| Long context beats both on a small corpus | A model that reads everything is enough when everything fits | Aim at what no model can read at once (many documents, years of history), and say so in the product |
| More than 3 todos per changed fact, or under 60% marked worth asking | Governance asks people too much | Settle more by rule, raise the bar for a todo, and group by document change (the change-set review) |
| Reading costs more per 1,000 pages than a seat can carry | Full reading of everything is too expensive | New sources start as Reference (read on use); only governed folders are read in full |
| Deciding gets a case wrong that reading got right | A bug in the engine | Fixed before anything else runs |

## What we need from the product owner

- A model key with a hard spending cap for the probe in step 2. US$100 covers the first run and one rerun of reading; US$200 also covers two reruns of the answers ([What the probe costs](#what-the-probe-costs)).
- About 30 minutes to check 20 random answer-key entries (rule 3); the keys are now written (PR #34).
- Agreement on, or changes to, the pass bars and the design changes proposed in advance.
- Later, a design partner whose documents we may run in step 4.

Until claims 1 to 4 have real numbers, we suggest pausing engine work that does not serve them: the credential broker, sandbox, views and code graph.
