# Validating the knowledge core

Status: proposed, 2026-10-27; revised after each run since, with the bars the product owner set on 2026-10-28 for [the decisive test](#the-decisive-test), and with a cost model on 2026-10-29 at the product owner's suggestion; reorganized on 2026-10-29 to give the current state first and the history last ([The runs so far](#the-runs-so-far)). The pass bars and the design changes below are proposals until the product owner agrees them. The engine thread owns the benchmark code and this specification. A Chinese copy is in [docs/zh/design/validation.md](../zh/design/validation.md).

## Where we stand

Five runs so far, two of them paid. DeepSeek V4.1 Flash read the company drive, answered its 150 questions three ways and replayed GitLab's expense policy history, for CNY 8.07 (about US$1.14) in all. Each run has a log in `apps/bench/runs/` ([The runs so far](#the-runs-so-far)). The numbers below are the latest: a real embedding, whole passages, and where marked, the answer key with the two gaps the second run found corrected.

1. **On a corpus that fits the window, long context answers most.** Long context reads the whole 311,106-token drive in a 1M-token window and answers 140 of the 150 questions right, Inspiration 116 and plain RAG 109 (140, 120 and 112 with the key corrected). Most of the gap lies before governance. Of the 25 questions long context gets and Inspiration misses, 14 are search, since an answer reads 1.7% of the drive. 4 are stale values from a renamed 2023 copy that normalization does not pair with its policy, 4 are the key's gaps, and 3 are the model, given the passage. The product owner set the direction on 2026-10-28: one topic's material in a company seldom exceeds 1M tokens, and stale and conflicting information is the common problem. So the test stays within one topic, and Inspiration should answer from everything the asker may read, after governance, whenever it fits (governed long context).
2. **Over plain RAG the lead is small, and the bar is now 10 points over a mature RAG.** On the 66 changed facts Inspiration answers 44 and plain RAG 40 (47 and 42 with the key corrected, 8 points). Stale answers are 6 against 10 of 150. The margin proves little either way: on changed facts the two differ on only 8 questions (6 for Inspiration, 2 for plain RAG), a split chance alone gives about 3 times in 10, and the drive's 11 changed facts are too few to measure a gap this size. Plain RAG was untuned, too: 9 of its 10 stale answers cite an older copy, which a mature RAG's rule "prefer the governed source, then the newest file" would likely drop. The product owner's verdict (2026-10-28): governance costs people's effort and the system's running, so Inspiration must lead a mature RAG by at least 10 points.
3. **Search no longer decides the drive.** With a real reranker, bge-reranker-v2-m3 run locally, the answer is in what Inspiration's model reads for 125 of the 135 questions with one, and in a mature RAG's 16 passages for 128. That is answer-input coverage, not accuracy: the answer is within the model's reach, not yet given. So a gap in the decisive test's step 2 points mainly at governance and the model's reading, but not at governance alone: 3 answers the mature RAG's input holds are missing from Inspiration's. Of the 10 questions search still misses, 6 ask in Chinese or Japanese about the Tokaido line, whose answer only the English article states; query translation targets them.
4. **The audit sees no value governance loses, with the stand-ins; the real reads are not audited yet.** The evidence audit of bar 1 reads what governed and raw long context give the model, never the answers. With the stand-ins, what governance gives keeps the right value and its document for all 135 keyed questions on the drive and all 11 on Kubernetes. Governed long context still answers one fewer right than the raw drive (48 against 49): that is reading, not a value the audit sees lost. The audit matches a value and its document only: a sentence that negates the value or narrows it to a condition still counts as kept (issue #68).
5. **A real model reads far better than the stand-in, and still below the bar.** On the drive, recall is 77% (59 of 77 keyed values) and precision 53%, against a bar of 85% and 90% (the stand-in: 55% and 14%). One slot drawn too wide, the network's top speed (`shinkansen_max_operating_speed`), takes 44 of the 53 values no key gives; without it, recall is 78% and precision 86%. On the GitLab replay, 249 of 294 slot-versions are right (85%). Deciding has not yet been scored apart from reading on the real reads.
6. **Asking meets its count bar; whether the asks were worth it is not yet checked.** After the first read, 20 GitLab versions change 20 facts, and people are asked 7 times: 0.35 asks per changed fact, against a bar of at most 1. The other half of the bar, at least 80% worth asking, needs a reviewer to mark each ask.
7. **Runs are cheap; whether the product costs less depends on the prefix cache.** A full run, reading the drive and answering 150 questions three ways, costs about CNY 4.96 off-peak, CNY 2.37 of it reading. With DeepSeek's prefix cache, a long-context answer costs about what Inspiration's does (CNY 0.006 against 0.005), so reading once takes over 2,000 questions to earn back; without the cache, about 8. No large saving is proven ([A cost model](#a-cost-model)).
8. **Real text found engine faults, and every one is fixed** ([What the runs taught](#what-the-runs-taught)).

**Next** is the decisive test's step 2, on the drive (about CNY 5), then its two topics (about CNY 18), once the product owner approves the spending. Still on the list: pairing a renamed copy with its document as an older edition (the 4 stale answers), a top-speed slot per line, re-reading less when only headings change, a reviewer's verdict on the replay's 7 asks, the 3 answers the mature RAG's passages hold and Inspiration's sources leave out, and negation and conditions in the audit (issue #68).

Until reading and answering pass, we suggest still pausing engine work that does not serve them: the credential broker, sandbox, views and code graph.

## What we need from the product owner

- **Approval of the decisive test's two paid steps**, about CNY 23 (asked 2026-10-28).
- **The faster, cheaper model** for the test's second arm. Only a DeepSeek key is configured; a small open model can run in the container for nothing, but on CPUs it measures quality, not speed.
- **Agreement on, or numbers for,** bars 3 and 4 of the decisive test (the fast model, and review load).
- **About 30 minutes** to check 20 random answer-key entries (rule 3). The second run showed why: it found two gaps a second reader would have caught.
- **Agreement on, or changes to,** the other pass bars and the design changes proposed in advance.
- Later, a design partner whose documents we may run ([How the work is done](#how-the-work-is-done), stage 4).

### Decided and received

- **2026-10-27:** the DeepSeek key, with under US$20 of credit (CNY 101.56 is left after the second run), and network access to api.deepseek.com, huggingface.co and `*.hf.co`. DeepSeek bills from the prepaid balance, so the credit is the hard cap; a daily gateway budget of US$5 is a soft stop meant to end a day's runs well before the balance does. Every run leaves a trace a later evaluation can reuse, so nothing is paid for twice ([Where each run is kept](#where-each-run-is-kept)).
- **2026-10-28:** the long-context result (conclusion 1). The test stays within one topic, on stale and conflicting information, and a test beyond the window is dropped. Inspiration must lead a mature RAG by at least 10 points. Organising knowledge must never lose the right value.
- **2026-10-29:** argue also from needing no flagship model, from speed and from cost, and derive cost from a model, since governance costs too ([A cost model](#a-cost-model)).

## The decisive test

Proposed 2026-10-28, to the bars the product owner set that day. It asks one question: when information is stale, conflicting or distorted, does Inspiration lead a mature RAG by at least 10 points, on a fast, cheap model as well as on a strong one? The company drive cannot answer it. Its versions are dated and in order, the newest file always holds, the policy writes its own history ("previously $80"), and only 11 facts changed. There a rule as simple as "prefer the governed source, then the newest file" does most of governance's work.

**Corpus.** Two topics of real public text, each well under 1M tokens, since one topic's material in a company seldom exceeds that. Travel and expenses comes from GitLab's handbook: 4,195 pages at main, with the public history of every edit. It already holds real restatements, such as the Navan expense guide repeating the expense rules, and real older versions, such as the legacy contract pages. Its text is English, asked in all three languages. One area of the Kubernetes docs brings real lagging translations in Chinese and Japanese, and changes between releases. The free scan of step 1 found that the handbook's current pages rarely disagree: every version since 2023 of 16 travel and expense pages, 1,447 in all, holds 4 real cases. A card retired on one page is still described in the policy, two values changed on dated edits, and the policy page was removed and restored. So each pattern below is built on the real text, from its real history where it has one and by a documented edit otherwise, and gets at least 10 facts. Each case records which it is. A natural case is real history, kept byte for byte. A constructed case is an edit, kept as its own file beside the untouched original, with what it changed and why. Results are reported for each apart: passing a constructed case shows that Inspiration handles the pattern, not how often companies meet it.

| Pattern | How it is built | The simple rule it defeats |
| --- | --- | --- |
| Restated and lagging | a team page or guide restates a policy value; the policy changed later; the page was edited since for another reason | newest file wins |
| Newer but not authoritative | a personal copy or draft saved after the policy, with a proposed value | newest file wins |
| Renamed or moved | the policy under its old title or path (GitLab moved its handbook in 2023) | near-duplicate detection |
| Lagging translation | a Chinese or Japanese page edited recently, its content from an older English revision | newest file, governed source |
| Governed sources disagree | two current governed pages give different values, neither replacing the other | any rule that picks one: a right answer names both |
| Changed elsewhere | an announcement, changelog or release note changes a value the page still states | governed source wins |
| Distorted restatement | a summary rounds a value or drops its condition | governed source wins, when the summary is governed too |

**Arms**, each on the same documents and model:

| Arm | What it is |
| --- | --- |
| Mature RAG | today's search, plus a cross-lingual reranker, query translation, 12 to 16 passages, and "prefer the governed source, then the newest file" |
| Inspiration | the same search, plus statements and governance |
| Raw long context | the topic's documents, where the model's window holds them |
| Governed long context | the topic after governance, where it fits |

**Models.** `deepseek-flash` with thinking off, as before, and a faster, cheaper, somewhat weaker model, because response speed is a product advantage too. The product owner picks the second. Long context runs only where a model's window holds the topic.

**Measures.** Right; stale; silent conflict, one value given where governed sources disagree, without a word of the other; cost per answer and of reading; latency per answer, median and p90; review load, as todos per 100 documents and how many "Decide for me" settles; and evidence retention, audited offline (bar 1). Today an answer of about 4,900 input tokens on `deepseek-flash` takes a median 1.3 seconds and a p90 of 1.8; long context's latency was not recorded.

**Beyond answering right.** An answer reads about 5,000 tokens already sorted by governance, so it may also need no flagship model, since which value holds was decided at reading, and answer faster; bar 3 measures both on a fast model. Whether it also costs less is not certain, because governance costs too: [A cost model](#a-cost-model) derives it from the measures above.

**Pass bars**, fixed before any paid call:

1. Governance removes no right value. An offline audit checks this apart from the answers: for each keyed fact, whether what governance keeps still holds its value, its conditions and who may read it. The question check runs it on every run (`retention`): what the governed long context gives its model must still state the right value, from a document the key cites and not marked as no longer holding, wherever the raw documents state it; any document governance cites beyond what the reader may read is listed. The keys name no conditions yet; the decisive test's key adds them where a value has one. Until the audit reads conditions and negation, it matches a value and its document only: "not covered up to $120" or "$120 only for executives" still counts as keeping $120 (issue #68). Governed long context should also be at least as right as raw long context on every pattern. A lower score there shows where to look but proves no loss by itself, and an equal score proves no retention, since prompts, order and the model move answers too (the product owner's review of PR #63). If the audit finds a loss, it is fixed first.
2. On each model, Inspiration answers at least 10 points more questions right than the mature RAG, and no fewer on the unchanged control. This bar is the product owner's. If it is missed, governance does not pay for its cost: keep a light layer of editions, dates and conflict notes on a mature RAG, and drop statement-level governance.
3. On the fast model, Inspiration is at least as right as the mature RAG on `deepseek-flash`, with a lower median latency. Proposed; the product owner sets it.
4. Review load is at most 5 todos per 100 documents after "Decide for me". Proposed; the product owner sets it.

**Size.** About 80 changed or conflicting facts and about 30 unchanged ones as a control, each asked once in English, Chinese and Japanese: about 330 questions. A 15-point gap needs about 80 such facts to show reliably; the drive has 11. Gaps are reported with 95% intervals, resampling facts rather than questions.

**Steps and cost**, at the off-peak prices measured in the first run:

| Step | What it settles | Cost |
| --- | --- | --- |
| 1. **Done 2026-10-28.** A reranker on the drive, checked with `--search-only`; a scan of the handbook for real conflicts | search recovers 9 answers: 125 of 135 within reach, 128 for the mature RAG; the handbook holds 4 real conflicts, too few, so the cases are built | nothing; query translation moves to step 2, under CNY 0.1 |
| 2. The drive with the mature RAG, Inspiration on the stronger search and governed long context; the rest from saved replies | whether the 6 points survive a mature baseline; bar 1 on the tidy case | about CNY 5 |
| 3. The two topics and their key, with a second reader for the key | | nothing; a few days |
| 4. The two topics on `deepseek-flash`: reading, then the four arms, with latency | bars 1, 2 and 4: the decision | about CNY 18 |
| 5. The same questions on the fast model | bars 2 and 3 | nothing on a local model; an API model is priced once chosen |

A test beyond the window was dropped: the product owner judged it rare in companies, and it would have cost about CNY 20 more.

## What we must prove

Inspiration is worth building if it does three things on the documents a company already has. It gives readers and agents the value that holds today, with the passage behind it. It does that more often than search over the same documents. And it asks people only about what the documents cannot settle.

Those documents repeat each other, contradict each other, lag in translation and change without notice. Every test below runs on real public documents of that kind, never on sentences we wrote. The business layer, accounts and permissions are left out: they are standard and certainly buildable.

### Five claims, and how each is tested

The core value breaks into five claims. Each needs its own test, because a miss in one hides behind the others: a right answer can come from luck in reading and a wrong one from a bug in deciding. The pass bars are proposals until the product owner agrees them. The last column gives the latest real numbers; [The runs so far](#the-runs-so-far) has the earlier ones.

| Claim | What it means | Measured as | Proposed pass bar | Today |
| --- | --- | --- | --- | --- |
| 1. Reading | A model turns real text into statements: the right value in the right fact slot, with a verbatim quote | Recall and precision per followed fact against the answer key; values invented where the text states none | Recall at least 85%, precision at least 90%, invented values at most 1% | Company drive: 59 of 77 keyed values found, 4 misread, 14 missed: recall 77%, precision 53%, or 78% and 86% without the Shinkansen top-speed slot. GitLab replay: 249 of 294 slot-versions right. Invented values are not yet counted apart from the values no key gives |
| 2. Deciding | From those statements, governance gives the value that holds: a newer version replaces an older one on its date, an original holds over its translation, copies count once, a fact a page stops stating is kept and marked, and one fact in English, Chinese and Japanese is one piece of knowledge | Share of fact-versions where the reader gets the key's value, counting only the cases reading got right | 100%: the rules are deterministic, so any miss is a bug to fix | With the stand-ins, right in every case the engine owns: GitLab 21 versions, Kubernetes 15 pages in three languages, control 6 of 8 (the other 2 are the stand-in's). Not yet scored apart from reading on the real reads |
| 3. Answering | On questions about facts that changed, conflict or exist in several languages, answers from governed knowledge beat a mature RAG over the same documents and model, on a fast, cheap model too | Right answers; stale answers; wrong answers given with confidence; conflicts answered with one value and no word of the other; citations that quote the source; "not stated" when nothing states it; latency | Set by the product owner (2026-10-28): at least 10 points more right answers than a mature RAG, on cases built from stale and conflicting facts; no worse on facts that never changed; stale answers at most 5% | Right (stale) of 150: Inspiration 116 (6), plain RAG 109 (10), long context 140 (6); 120, 112 and 140 with the key corrected. Changed facts, 66: 44 (4), 40 (5), 62 (0). Unchanged, 69: 62, 59 and 69, none stale. Not stated, 15: 10 (2), 10 (5), 9 (6). Inspiration by language: English 45 of 50, Japanese 37, Chinese 34; where search brought the answer, 105 of 116 right. The mature RAG has not run yet |
| 4. Asking little | People are asked only what the documents cannot settle, and agree the question was worth asking | Todos per changed fact; share settled without a person; share of todos a reviewer marks "worth asking" | At most 1 todo per changed fact; at least 80% marked worth asking | GitLab replay, after the first read: 20 versions change 20 facts and people are asked 7 times (2 todos raised, and open todos given more to decide 5 times), 0.35 per changed fact; a reviewer has not yet marked them |
| 5. Cost | Reading and answering cost little enough for a seat price to carry | Tokens per 1,000 words read; tokens per answer; share of documents that need a model at all | Reported, not gated, until pricing is set | Off-peak: reading the company drive CNY 2.37 (about US$1.1 per million tokens of documents), a full run about CNY 4.96, the GitLab replay CNY 1.91 |

## Results that would change the design

A validation is worth running only if some results would change what we build. These were proposed before any result, so that no result can be explained away afterwards. The last column is what the real runs showed.

| If we see | It means | We change | Real runs |
| --- | --- | --- | --- |
| Reading recall under 70% after prompt work | Fact slots are too rigid for real wording | Keep slots for high-value facts (amounts, limits, deadlines, owners); keep the rest as open statements grouped by meaning, governed less strictly | Not seen: 77% before any prompt work |
| Plain RAG within 5 points of us on changed facts | The governed layer does not pay for itself in answers | Lead with change alerts and owner reviews; make extract-on-use the default; answer with RAG checked against known statements | **Nearly seen:** 6 points ahead with real search (44 against 40 of 66), 8 with the key corrected. The product owner judged it too small and replaced the row with the next one |
| Under 10 points ahead of a mature RAG on the decisive test (bar set by the product owner, 2026-10-28) | Statement-level governance does not pay for its cost | Keep a light layer (editions, dates, conflict notes) on a mature RAG or on long context, and drop statement-level governance | Not run yet |
| The evidence audit finds a right value governance dropped; governed long context less right than raw long context only points where to look | Governance removed or hid a right value | Fixed before anything else runs | Not seen with the stand-ins: the right value and its document kept for all 135 keyed questions on the drive, though governed long context answers one fewer right (48 against 49). Not run on the real reads, and the audit does not yet read negation or conditions (issue #68) |
| Long context beats both on a small corpus | A model that reads everything is enough when everything fits | Aim at what no model can read at once (many documents, years of history), and say so in the product | **Seen:** 140 of 150 right, against 116 and 109. The product owner chose (2026-10-28) to stay within one topic, where companies' material fits a window, and to answer from everything when it fits, after governance |
| More than 3 todos per changed fact, or under 60% marked worth asking | Governance asks people too much | Settle more by rule, raise the bar for a todo, and group by document change (the change-set review) | Not seen on the count: 0.35 per changed fact; worth asking not yet marked, so the row is still open |
| Reading costs more per 1,000 pages than a seat can carry | Full reading of everything is too expensive | New sources start as Reference (read on use); only governed folders are read in full | Not judged until pricing is set: about US$1.1 per million tokens of documents, off-peak |
| Deciding gets a case wrong that reading got right | A bug in the engine | Fixed before anything else runs | Not yet scored on the real reads |

## Real documents to test on

Three corpora are built, a fourth is fetched, and a fifth would close a gap. All are public, licensed for reuse, and kept byte for byte with their source and revision in a manifest. The decisive test adds constructed cases: each is an edit kept as its own file beside the untouched original, with what it changed and why ([The decisive test](#the-decisive-test)).

| Corpus | Languages | What it tests | State |
| --- | --- | --- | --- |
| GitLab's expense policy, 21 versions from 2020 to 2026 ([examples/gitlab-expenses](../../examples/gitlab-expenses)) | English | Values that change, appear and stop being stated; a page that moves away and comes back | Built (PR #27) |
| Kubernetes documentation, 5 pages with their official translations ([examples/kubernetes-docs](../../examples/kubernetes-docs)) | English, Chinese, Japanese | One fact in three languages; Japanese pages two to three years behind | Built (PR #29) |
| Wikipedia: Kubernetes, Tokyo, Shinkansen, today and two years ago | English, Chinese, Japanese | Long, loosely written text; facts that changed in two years; three articles written separately, not translated | The Shinkansen articles in all three languages, current and October 2024, are in the company-as-it-looks corpus (PR #34); the rest are not used yet |
| Two topics for [the decisive test](#the-decisive-test): travel and expenses from the GitLab handbook (4,195 pages at main, with the history of every edit), and one area of the Kubernetes docs; each well under 1M tokens | English for the handbook, asked in all three; all three for Kubernetes | Stale and conflicting facts where "newest file" and "governed source" fail: restatements that lag, newer drafts, renamed copies, lagging translations, governed sources that disagree, changes made elsewhere, distorted summaries | Proposed |
| A company as it really looks, built only from the texts above ([examples/company-drive](../../examples/company-drive)) | All three | Old versions left beside new ones ("the copy someone saved in 2022"), lagging translations, an old article next to the current one | Built (PR #34): GitLab's policy now, a 2024 backup and three older copies on a reference shared drive, the Kubernetes pages and the Shinkansen articles; 311,106 tokens |

In the last corpus every sentence is real. Only the arrangement is staged, and the manifest records which file is a stale copy. That is the situation where plain search goes wrong and Inspiration should not.

One gap remains: policy-like text written first in Chinese or Japanese, with dated revisions. All our Chinese and Japanese policy text is translated from English. The Chinese and Japanese Wikipedia articles are originals, but not policies. The best fix is a design partner's real documents, used with their permission, as the last stage.

## Answer keys written by hand before any run

A result means something only if the right answer was fixed before the run, from the documents themselves. The GitLab timeline, the Kubernetes answers and the company-as-it-looks key (PR #34) work this way. That key has 36 facts and 114 entries, each with its file, revision and verbatim quote, and a test checks every quote and revision. Its 150 questions are 50 per language: 69 about unchanged facts, 66 about changed ones (two phrasings per language) and 15 that the documents in use do not answer.

1. **Read from the documents.** Every expected value names its file, revision and the quoted passage.
2. **A value per date.** Each fact gets its value from each date it changed, so "what is the hotel cap on 2023-09-01?" has one right answer.
3. **A second reader.** Someone other than the author checks 20 random entries, and every disagreement is settled and recorded. Our first key already needed this: it said GitLab's phone cap stopped being stated in August 2023, but the page still states it under its Phone Service heading ($80, then $100 from 2026-06-19). We propose the product owner or a teammate does this; it takes about 30 minutes.
4. **The question set.** About 150 questions, a third each in English, Chinese and Japanese. Half ask about facts that never changed, half about facts that changed, conflict or appear only in a lagging translation. One in ten has "not stated" as its right answer, to catch invented values.
5. **Frozen.** A key is never edited to match a result. When a document changes, the key is written again and old runs are kept as they were. When a run shows the key missed what a file says, the key is corrected from the file, the correction is listed in the corpus's README, and the run keeps the score it had.
6. **Scored by rule.** A value matches when it equals the key after units are normalized. Where a model judges a free-text answer, it judges only against the key, and a sample of its judgements is checked by hand. A right answer can still mention an old value beside the new one, so the judge also checks whether it hedges between them.

## The baselines

The value of the knowledge layer shows only against what people use today. So every question runs through Inspiration and through its rivals, with the same documents and model. The engine thread builds the rival runs and scores them side by side.

- **Plain RAG.** The same retrieval with statements and governance turned off: passages are retrieved and the model answers from them with citations. This is what most knowledge products do, RAGFlow among them. It is a hybrid, but untuned: 400 to 800-token chunks with a contextual header each, a multilingual embedding, BM25, reciprocal rank fusion of the 50 best from each, and the 8 best passages read whole; no reranker, no query translation, and every copy found is read.
- **Mature RAG** (from [the decisive test](#the-decisive-test)). Plain RAG plus what a carefully built RAG has: a cross-lingual reranker, the question translated into the corpus's languages, 12 to 16 passages, and the rule "prefer the governed source, then the newest file". Inspiration gets the same search, so only governance differs.
- **Long context, where it fits.** For a small corpus, the model reads every document with its date and answers. It is the strongest simple rival, and on both real runs it won at the drive's size (conclusion 1). Where Inspiration cannot beat it on answers, the layer has to earn its place on what does not fit one window, on cost, on change alerts and on owners' work instead.
- **Governed long context, where it fits** (from the decisive test). Everything the asker may read after governance, replaced editions left out and outdated values marked. It should be at least as right as raw long context. Where it is less right, the evidence audit of bar 1 tells whether governance dropped a right value or the model read the same evidence otherwise; a score alone proves neither.

Every arm reports the same numbers as claim 3, plus tokens and time per answer. Whatever Inspiration wins is what reading once, governing and keeping history are worth.

## Cost

### What a run costs

The model is `deepseek-flash` (listed as DeepSeek-V4.1-Flash, with a window of 1,048,576 tokens, so the 311,106-token corpus fits whole). It thinks by default, which bills its reasoning as output, so the config turns thinking off. DeepSeek bills this account in CNY, and its price page cannot be reached from our environment, so the first run measured the prices from the balance around calls of known size, off-peak at 12:00 UTC: CNY 1 per million input tokens, CNY 0.02 per million served from DeepSeek's cache, and CNY 4 per million output tokens. At about 7.1 CNY to the dollar that is half the reported peak prices of US$0.30, 0.006 and 1.20, as the off-peak discount would make it. Peak is seven hours on weekdays, 01:00 to 04:00 and 06:00 to 10:00 UTC; its prices were not measured.

A full run costs about CNY 4.96 off-peak, so the loop can turn several times a day. Reading the drive costs CNY 2.37 however many questions are asked. Since the second run an answer reads whole passages, about 4,960 input tokens instead of 1,180, so Inspiration's and plain RAG's answers cost about CNY 1.35 for 150 questions instead of the first run's CNY 0.40. Embedding and reranking are not in the figure: Qwen3-Embedding-0.6B and bge-reranker-v2-m3 run locally for nothing. Embedding the drive takes about 27 minutes on the container's 4 CPUs, and the reranker reads about 1,000 tokens a second there, about 12 seconds a question; a product would rerank on a GPU server. The GitLab replay for claim 4 runs separately; it cost CNY 1.91.

The first real run's parts, beside the dry run (PR #39), which sent every call of the stand-in run through the gateway with the inputs a real model would get and priced them before any paid call:

| Part of one full run: the company drive, 150 questions, three rivals | Dry run, off-peak | First real run, off-peak | Runs again when |
| --- | --- | --- | --- |
| Extraction, 339 windows | US$0.18 | CNY 1.99, US$0.28 | The reading prompts or the fact vocabulary change |
| Chunk headers | US$0.05 | CNY 0.33, US$0.05 | Chunking changes |
| Topic names | Under US$0.01 | CNY 0.05, US$0.01 | Topics change |
| Long context's answers: 43 million input tokens, all but 0.3 million from DeepSeek's cache | US$0.22 | CNY 1.24, US$0.17 | Answering changes |
| Inspiration's and plain RAG's answers | US$0.08 | CNY 0.40, US$0.06 | Answering, reading or chunking changes |
| **Total** | **US$0.52** | **CNY 4.01, US$0.56** | |

The dry run's output lengths are the stand-ins', so it underestimated extraction, where a real model writes about 1,150 tokens per window, twice as much.

### A cost model

The product owner asked on 2026-10-29 that the case also rest on needing no flagship model, on speed and on cost, and noted that cost is not always lower, since governance costs too. An answer from Inspiration reads about 5,000 tokens already sorted by governance, so a faster, cheaper model may answer it as well, which bar 3 measures. Its total cost has three parts:

- **Reading:** every document once, then what changes.
- **Governance:** todos per 100 documents times a person's time per todo, plus the model calls of "Decide for me".
- **Answering:** questions times what an answer reads.

A mature RAG reads ahead only embeddings and chunk headers, and answers from 12 to 16 passages. Long context reads nothing ahead and answers from the whole corpus, at about a fiftieth of the price on a prefix-cache hit. The cache hit rate decides most. On the drive, reading once costs about CNY 2.37. With the cache, a long-context answer costs about CNY 0.006 against Inspiration's 0.005, so on these rounded figures it takes over two thousand questions to earn the reading back. Without it, a long-context answer costs about CNY 0.29 off-peak, and about 8 questions do. Hits fall as documents change, as readers split into permission groups (one cache prefix each) and as questions fall further apart than the cache lasts. When everything fits and is read whole after governance, answering costs what long context costs, and only right answers or a cheaper model pay for the rest. The decisive test measures the inputs above; from them, the cost model gives what the three approaches cost at a few typical company sizes.

### How runs stay cheap

1. **The response cache.** The gateway answers a call whose model, prompt, input and settings are unchanged from its cache, at no cost, and keeps replies in Valkey for 30 days; the export ([Where each run is kept](#where-each-run-is-kept)) keeps them longer. So a change pays only for what it touches: a new answer prompt pays for the answers (CNY 1.64 for all 150 questions in the first run), not for reading again.
2. **Corpus first in long context.** The long-context rival puts the documents before the question, so DeepSeek's cache serves the corpus from the second question on, for 99.9% of each call. With the question first, every call would pay for the whole 285,000 tokens it sends, about CNY 43 for 150 questions instead of CNY 1.24. The question after long documents is also the usual advice for answer quality, so the change does not weaken the rival.
3. **Off-peak.** Full runs are scheduled outside DeepSeek's weekday peak hours, at half price.
4. **Spending limits.** The prepaid balance is the hard cap: the provider stops everything when it runs out. Inside it, one gateway budget of US$5 a day covers all calls together. On a database it counts the day's earlier runs, and dry runs never count. The budget is a soft stop. The gateway refuses a call once the day's spend, plus what calls in flight in the same process hold, reaches the limit. A call admitted under the limit can still cost more than it held, through a schema retry or a dearer fallback model, and runs in other processes count only once they have metered. So a day may exceed US$5, and nothing but the prepaid balance bounds by how much.

## How the work is done

Four stages, each closed by a gate. What they need from the product owner is listed [above](#what-we-need-from-the-product-owner).

1. **Without a model (done).** The answer keys and the 150 questions (PR #34), the plain-RAG and long-context runs (PR #32), todos per changed fact on the GitLab replay (PR #33) and the company-as-it-looks corpus (PR #34). Gate met: all three runs score the same 150 questions end to end with the stand-ins, in 52 seconds in memory.
2. **Real runs on DeepSeek V4.1 Flash (done, 2026-10-27).** The model goes through the model gateway, with a multilingual embedding beside it, because the stand-in search cannot match a Chinese or Japanese question to English text. Gate met: claims 1, 3 and 5 have real numbers.
3. **Fix and run again (now).** Work on prompts, the fact vocabulary, tables and search, then rerun the same keys. It began with the embedding and whole passages (the second run) and goes on with [the decisive test](#the-decisive-test). Before a reading result changes the design, reading runs once on a larger model, for a few dollars, to tell a limit of Flash from a limit of the design. Gate: the pass bars are met, or a result from [Results that would change the design](#results-that-would-change-the-design) changes the design.
4. **A design partner's documents.** A company's own documents, ideally written in Chinese or Japanese, run the same way with their permission. Gate: someone who maintains their documents marks which todos were worth asking (claim 4).

**Reading is checked in full.** Reading every window costs about CNY 2, no more than a sample of windows would, so there is no sample. The reading check scores the whole read against the answer key without calling a model: for each place the key gives a value, whether governance holds that value (found), other values only (misread) or nothing (missed), plus the values the key does not give (extra), which give precision. The 12 facts without a catalogue entry are reported apart, because only answers can find them.

**Slot fits are held to the catalogue.** Extraction holds a model's slot fits to the fact catalogue: each value has one written form, and a fit with a wrong unit or an unknown qualifier loses its slot and is counted. Without this, "$300" and "300 USD" would be two values and a false conflict. On the first real run, 8 of 3,241 statements were kept without their slot.

**Sensitivity.** The public data needs no sensitivity clearance, so DeepSeek's own API may read it. A design partner's documents in stage 4 go only to a provider the gateway clears for their sensitivity; DeepSeek publishes the model's weights, so a host the partner trusts can serve the same model.

### Where each run is kept

Every paid run leaves a trace that a later evaluation can reuse, so nothing is paid for twice. A run log in `apps/bench/runs/` records the commits, commands, prompt versions, costs and results; a run log is a record and is not edited once reported. The raw reply of every call is exported with `pnpm bench cache export` to the project's shared files, beside each run's reports and every metered call. `pnpm bench cache import` loads the replies into a fresh stack, and a rerun then pays only for the calls a change touches.

## The runs so far

Newest last. Each log has a Chinese copy beside it.

| When | Run | Cost | What it showed | Log |
| --- | --- | --- | --- | --- |
| Before 2026-10-27 | The stand-in model and search, in memory | nothing | Right (stale) of 150: Inspiration 47 (6), plain RAG 42 (7), long context 49 (8); reading 55% recall, 14% precision; GitLab replay 174 slot-versions right, 4 asks | PRs #27 to #34 |
| 2026-10-27 | First real run: DeepSeek reads the drive, answers 150 questions three ways on the stand-in search, and replays GitLab | CNY 6.61 | Reading 77% and 53%; 71 (3), 60 (5) and 140 (6) right; 0.35 asks per changed fact; two engine faults | [2026-10-27-deepseek.md](../../apps/bench/runs/2026-10-27-deepseek.md) (PR #50) |
| 2026-10-27 | Where answers were lost, from the saved replies | nothing | Search, before the model saw anything: stand-in vectors that cannot cross languages, a stand-in reranker, snippets of about 80 tokens | [2026-10-27-search.md](../../apps/bench/runs/2026-10-27-search.md) |
| 2026-10-27 | Second run: a real embedding and whole passages | CNY 1.46 | 116, 109 and 140 right (120, 112 and 140 with the key corrected); the answer within reach for 116 of 135, not 64 | [2026-10-27-whole.md](../../apps/bench/runs/2026-10-27-whole.md) (PR #59) |
| 2026-10-28 | The decisive test's step 1: a real reranker (`--search-only`) and the handbook's history | nothing | 125 of 135 within reach, 128 for the mature RAG; 4 real conflicts in 1,447 versions | [2026-10-28-rerank.md](../../apps/bench/runs/2026-10-28-rerank.md) (PR #64) |

The evidence audit and the equal-cache search came after, in PR #66, and run on every question check; their stand-in results are in conclusion 4.

### What the runs taught

These are what real text taught that invented sentences never would have.

- **Real text is hard to read.** The stand-in missed "$10K", amounts in table cells, HTML tables, a rule with no number ("receipts are required for all expenses" means a threshold of 0), numbers in words ("up to three minor versions older") and another unit ("5分" in Japanese). These are the cases a real model must get right. The real model's misses left are amounts in a sentence that names neither the catalogue's words nor the unit ("Policy is set at $80" under "Phone Service"), a rule with no number, and figures in the older copies and the Shinkansen articles.
- **A real model reads more, and writes more.** It finds 3,241 statements on the drive where the stand-in found 1,339, writes about 1,150 tokens per extraction window, twice the stand-in, and leaves 26 conflict cases where the stand-in left 135.
- **A slot drawn too wide costs precision.** The catalogue's one top speed for the whole network collected every line's top speed: 44 of the 53 values no key gives. The fix is in the catalogue, not the model.
- **Search lost answers before the model saw them.** A passage used to reach the answer as about 80 tokens picked by the words it shares with the question, so across languages, or worded differently, the snippet left the answer out. Read whole, with a real embedding, the answer is within reach for 116 of 135 questions instead of 64, at about 4,960 input tokens an answer instead of 1,180; with a real reranker, for 125. Where search brought the answer, Inspiration was right on 91% of the questions, before and after.
- **Real text and real output found engine faults, all fixed.** A line break in the HTML split a sentence, "…)," ended one, and a long real heading made the gateway refuse every topic name in an answer. Statements were crowding the answer's own passages out of its sources; an answer now reads 8 passages plus 8 statements. A fact stated in two places raised a todo when one of the places was removed. A model quoted one span twice for one claim, which the Postgres store rejected (PR #49), and one topic name over 40 characters failed the naming of its whole call (PR #51).
- **Real text found missing rules, now built.** A fact a page stopped stating used to vanish without notice (20 of GitLab's fact-versions); it is now kept and marked, with one todo. Copies and translations used to count as separate sources; they now count once. A value that only a reference copy states, older than the governed document, is now out of date: the 2021 copy's 30 days no longer answers beside the policy's 90, while plain RAG still answers 30. An old revision whose fact has no governing slot was read as current, as with the Chuo Shinkansen's opening in the 2024 Shinkansen articles; PR #38 recognises old copies and revisions of one document and answers from the latest, which cut Inspiration's stale answers from 5 to 3.
- **Old translations leave out rather than contradict.** The Japanese Kubernetes pages from 2023 and 2024 state the same values as the English ones, and simply lack the newer sections.
- **Real policies rarely disagree.** Every version since 2023 of 16 GitLab travel and expense pages, 1,447 in all, holds only 4 real conflicts, so the decisive test builds its cases on the real text.
- **Re-reading follows the edit.** On the GitLab replay, each version reads only its added and changed blocks: 448 windows over 21 versions, where reading each version in full would take about 1,000. The one over-read is a renamed title with re-levelled sections, which re-reads every block under them, because extraction reads a block with its headings (2023-10-05: 49 windows for a 28% edit).
- **The stand-in's asks were mostly its own misreadings.** With the stand-ins, the replay asked 4 times, 0.2 per changed fact, and only 1 was worth asking; the other 3 came from text the stand-in misread.
- **The dry run was close.** It estimated US$0.52 for a full run; the first real run cost US$0.56. Extraction cost half again more than estimated, because a real model writes twice the stand-in's output.
- **The answer key needs its second reader.** The second run's answers showed two places the key missed: a date written with its era year inside ("1964年（昭和39年）10月1日") and a Chinese article that states the Chuo opening. Both are corrected and recorded (rule 5).
