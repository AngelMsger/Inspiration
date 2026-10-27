# Validating the knowledge core

Status: proposed, 2026-10-27; revised the same day to put conclusions first and to plan real runs on DeepSeek V4.1 Flash, at a cost low enough to repeat often. The pass bars and the design changes below are proposals until the product owner agrees them. The engine thread runs every measurement and owns the benchmark code; this document is its specification. A Chinese copy is in [docs/zh/design/validation.md](../zh/design/validation.md).

## Conclusions so far

1. **The pipeline runs end to end on real documents in English, Chinese and Japanese; quality is not measured yet.** Every number so far comes from a deterministic stand-in for the model, so it measures the pipeline, not reading.
2. **Deciding is right in every case the engine owns:** 21 versions of GitLab's expense policy, 15 Kubernetes pages in three languages, and the company-as-it-looks corpus. One gap is being closed (PR #38): old copies and revisions of a document answering as if current. With the fix, Inspiration's stale answers fall from 5 to 3 of 150, and its right answers move from 48 to 47.
3. **On facts that changed, governance already beats plain RAG and matches long context.** Of 66 questions about changed facts, Inspiration answers 14 right, plain RAG 10 and long context 13; on the 69 about unchanged facts the three are close (32, 32 and 34). Questions asked in Chinese or Japanese about the English policy wait on a multilingual embedding: with the stand-in search, 1 of 52 is right. With the PR #38 fix, Inspiration's answers on changed facts are 13 right and 3 stale, against long context's 13 and 6.
4. **Reading is the open risk.** The stand-in reads 92 of the 212 values GitLab's policy states. On the company drive, the new reading check finds 42 of the 77 values the key places in catalogued facts, at 14% precision, because the stand-in takes a number from every sentence with a fact's words. Only a real model shows whether reading reaches the bar.
5. **A real run is now cheap enough to repeat often.** The dry run (PR #39) prices one full run on DeepSeek V4.1 Flash, reading the company drive and answering all 150 questions three ways, at about US$1 at peak and US$0.50 off-peak, within half either way because output lengths are the stand-ins'. Long context is the largest part, 48 million input tokens, but all but 0.4 million come from DeepSeek's cache because the corpus now comes before the question ([Cost, and how it stays low](#cost-and-how-it-stays-low)).
6. **Next:** with the key and network access, a first real run, then a run after each change to reading or answering until they settle. Its gate: claims 1, 3 and 5 have real numbers.

### What we need from the product owner

- **A DeepSeek API key with US$20 of credit.** DeepSeek bills from a prepaid balance, so the credit is the hard cap. It is enough for about 20 full runs at peak prices and twice that off-peak, and a daily gateway budget of US$5 stops a day's runs before the balance does.
- **Network access for the runs.** Our build environment cannot reach api.deepseek.com yet, nor huggingface.co, where an open multilingual embedding and reranker can be downloaded to run for free (DeepSeek offers no embedding). Without huggingface.co the first run still works, but search stays on the stand-in and cannot cross languages.
- **About 30 minutes** to check 20 random answer-key entries (rule 3); the keys are written (PR #34).
- **Agreement on, or changes to,** the pass bars and the design changes proposed in advance.
- Later, a design partner whose documents we may run in step 4.

Until claims 1 to 4 have real numbers, we suggest pausing engine work that does not serve them: the credential broker, sandbox, views and code graph.

## What we must prove

Inspiration is worth building if it does three things on the documents a company already has. It gives readers and agents the value that holds today, with the passage behind it. It does that more often than search over the same documents. And it asks people only about what the documents cannot settle.

Those documents repeat each other, contradict each other, lag in translation and change without notice. Every test below runs on real public documents of that kind, never on sentences we wrote. The business layer, accounts and permissions are left out: they are standard and certainly buildable.

## Five claims, and how each is tested

The core value breaks into five claims. Each needs its own test, because a miss in one hides behind the others: a right answer can come from luck in reading and a wrong one from a bug in deciding. The pass bars are proposals; we set them for good after the first run with a real model.

| Claim | What it means | Measured as | Proposed pass bar | Today |
| --- | --- | --- | --- | --- |
| 1. Reading | A model turns real text into statements: the right value in the right fact slot, with a verbatim quote | Recall and precision per followed fact against the answer key; values invented where the text states none | Recall at least 85%, precision at least 90%, invented values at most 1% | Cannot be measured yet. The stand-in reads 92 of the 212 values GitLab's policy states, reads 13 wrongly and invents none; on the company drive the reading check (PR #39) scores it at 42 of 77 keyed values found, 21 misread, 14 missed, and 14% precision; a real model is needed |
| 2. Deciding | From those statements, governance gives the value that holds: a newer version replaces an older one on its date, an original holds over its translation, copies count once, a fact a page stops stating is kept and marked, and one fact in English, Chinese and Japanese is one piece of knowledge | Share of fact-versions where the reader gets the key's value, counting only the cases reading got right | 100%: the rules are deterministic, so any miss is a bug to fix | Right in every case the engine owns: GitLab 21 versions, Kubernetes 15 pages in three languages, control 6 of 8 (the other 2 are the stand-in's) |
| 3. Answering | On questions about facts that changed, conflict or exist in several languages, answers from governed knowledge beat plain RAG over the same documents and model | Right answers; stale answers; wrong answers given with confidence; citations that quote the source; "not stated" when nothing states it | No worse than plain RAG on facts that never changed, at least 20 points better on facts that changed or conflict, stale answers at most 5% | Runs end to end with stand-ins (PRs #32, #34). On the 150 questions over the company-as-it-looks corpus, right and stale answers are 48 and 5 for Inspiration, 44 and 6 for plain RAG, and 49 and 8 for long context (the whole 311,106-token corpus in a 1M-token window). On the 66 questions about changed facts: 14 and 4, 10 and 5, 13 and 6. On the 69 about unchanged facts: 32, 32 and 34 right, none stale. In English alone, where the stand-in search works, the 22 changed facts get 11, 8 and 11 right. Of 52 questions asking about the policy in Chinese or Japanese, 1 is right, because the stand-in search cannot cross languages. The stand-ins say "not stated" for 2 of 15. These numbers measure the pipeline, not reading |
| 4. Asking little | People are asked only what the documents cannot settle, and agree the question was worth asking | Todos per changed fact; share settled without a person; share of todos a reviewer marks "worth asking" | At most 1 todo per changed fact; at least 80% marked worth asking | GitLab replay with stand-ins (PR #33): after the first read, 20 versions change 20 facts and people are asked 4 times (2 todos raised, and an open todo given more to decide twice), 0.2 per changed fact; one todo is withdrawn later without a person. Only 1 of the 4 is worth asking (the 2026-03-18 notice that the page moved); the other 3 are the stand-in misreading the text, so 25% today, waiting on a real model |
| 5. Cost | Reading and answering cost little enough for a seat price to carry | Tokens per 1,000 words read; tokens per answer; share of documents that need a model at all | Reported, not gated, until pricing is set | Priced by the dry run (PR #39): about US$1.04 at peak to read the company drive and answer 150 questions three ways, US$0.47 of it reading the drive. Real output lengths need a real model |

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
- **The company-as-it-looks corpus found one more fix and one gap.** A value that only a reference copy states, older than the governed document, is now out of date: the 2021 copy's 30 days no longer answers beside the policy's 90, while plain RAG still answers 30. The gap: an old revision whose fact has no governing slot was read as current, as with the Chuo Shinkansen's opening in the 2024 Shinkansen articles. The engine thread is closing it by recognising old copies and revisions of one document and answering from the latest; its first run (PR #38) cuts Inspiration's stale answers from 5 to 3.
- **Old translations leave out rather than contradict.** The Japanese Kubernetes pages from 2023 and 2024 state the same values as the English ones, and simply lack the newer sections.

## Order of work and cost

Four steps, each closed by a gate. Only step 2 needs anything from the product owner, listed above.

1. **Without a model (done, engine thread).** Write the answer keys and the 150 questions (PR #34), add the plain-RAG and long-context runs (PR #32), count todos per changed fact on the GitLab replay (PR #33), and assemble the company-as-it-looks corpus (PR #34). Gate met: all three runs score the same 150 questions end to end with the stand-ins, in 52 seconds in memory.
2. **Real runs on DeepSeek V4.1 Flash.** The model goes through the model gateway, with a multilingual embedding beside it, because the stand-in search cannot match a Chinese or Japanese question to English text. The dry run has priced it (PR #39); each real run reads the drive and answers all 150 questions for about US$1, and the response cache replays whatever a change does not touch ([Cost, and how it stays low](#cost-and-how-it-stays-low)). Gate: claims 1, 3 and 5 have real numbers.
3. **Fix and run again.** Work on prompts, the fact vocabulary and tables, then rerun the same keys. Before a reading result changes the design, reading runs once on a larger model, for a few dollars, to tell a limit of Flash from a limit of the design. Gate: the pass bars are met, or a result from [Results that would change the design](#results-that-would-change-the-design) changes the design.
4. **A design partner's documents.** A company's own documents, ideally written in Chinese or Japanese, run the same way with their permission. Gate: one of their owners marks which todos were worth asking (claim 4).

### Cost, and how it stays low

A full run costs about US$1 at peak and US$0.50 off-peak on DeepSeek V4.1 Flash, so the loop can turn several times a day. The dry run (PR #39) measured it: it sends every call of the stand-in run through the gateway with the inputs a real model would get, and prices them at DeepSeek's rates with a prefix cache like DeepSeek's. Output lengths are the stand-ins', so treat every figure as within half either way.

The prices are as reported in September and October 2026 and still to be confirmed on DeepSeek's own price page, which our environment cannot reach; the model ID is to be confirmed too. Per million tokens: US$0.30 for input, US$0.006 for input served from DeepSeek's cache, and US$1.20 for output. Off-peak they are half that; peak is seven hours on weekdays, 01:00 to 04:00 and 06:00 to 10:00 UTC. The window holds 1 million tokens, so the 311,106-token corpus fits whole.

| Part of one full run: the company drive, 150 questions, three rivals | Peak | Off-peak | Runs again when |
| --- | --- | --- | --- |
| Extraction, 339 windows | US$0.36 | US$0.18 | The reading prompts or the fact vocabulary change |
| Chunk headers | US$0.10 | US$0.05 | Chunking changes |
| Topic names | US$0.01 | Under US$0.01 | Topics change |
| Long context's answers: 48 million input tokens, all but 0.4 million from DeepSeek's cache | US$0.43 | US$0.22 | Answering changes |
| Inspiration's and plain RAG's answers | US$0.15 | US$0.08 | Answering, reading or chunking changes |
| **Total** | **US$1.04** | **US$0.52** | |

Reading the drive costs about US$0.47 however many questions are asked, and each question adds about US$0.004 across the three rivals; 30 questions come to US$0.66. Embeddings and reranking are not in the figure: they stay stand-ins until an open multilingual model can be downloaded (huggingface.co), and then run locally for nothing. The GitLab replay for claim 4 runs separately and is not in the figure either.

Four things keep runs cheap:

1. **The response cache.** The gateway answers a call whose model, prompt, input and settings are unchanged from its cache, at no cost, and keeps replies in Valkey for 30 days. So a change pays only for what it touches: a new answer prompt pays for the answers (about US$0.58 at peak for all 150 questions), not for reading again.
2. **Corpus first in long context.** The long-context rival puts the documents before the question, so DeepSeek's cache serves the corpus from the second question on. With the question first, long context alone would cost about US$14 at peak instead of US$0.43. The question after long documents is also the usual advice for answer quality, so the change does not weaken the rival.
3. **Off-peak.** Full runs are scheduled outside DeepSeek's weekday peak hours, at half price.
4. **Hard caps.** The prepaid balance stops everything when it runs out. Inside it, one gateway budget of US$5 a day covers all calls together; on a database it counts the day's earlier runs, and dry runs never count. Once it is spent the gateway refuses every further call, so a run overshoots only by the calls already in flight.

**Reading is checked in full.** Reading every window costs about US$0.36, no more than a sample of windows would, so there is no sample. The reading check scores the whole read against the answer key without calling a model: for each place the key gives a value, whether governance holds that value (found), other values only (misread) or nothing (missed), plus the values the key does not give (extra), which give precision. The 12 facts without a catalogue entry are reported apart, because only answers can find them.

**Ready for a real model.** Extraction now holds a model's slot fits to the fact catalogue: each value has one written form, and a fit with a wrong unit or an unknown qualifier loses its slot and is counted. Without this, "$300" and "300 USD" would be two values and a false conflict.

The public data needs no sensitivity clearance, so DeepSeek's own API may read it. A design partner's documents in step 4 go only to a provider the gateway clears for their sensitivity; DeepSeek publishes the model's weights, so a host the partner trusts can serve the same model.

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
