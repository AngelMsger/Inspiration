# Validating the knowledge core

Status: proposed, 2026-10-27; revised the same day to put conclusions first, to plan real runs on DeepSeek V4.1 Flash, and with the first real run's results. The pass bars and the design changes below are proposals until the product owner agrees them. The engine thread owns the benchmark code and this specification. A Chinese copy is in [docs/zh/design/validation.md](../zh/design/validation.md).

## Conclusions so far

The first real run, on DeepSeek V4.1 Flash on 2026-10-27, read the company drive, answered its 150 questions three ways and replayed GitLab's expense policy history for CNY 6.61, about US$0.93. Search still ran on the stand-in embedding and reranker. Its run log is `apps/bench/runs/2026-10-27-deepseek.md` (PR #50).

1. **A real model reads far better than the stand-in, and still below the bar.** On the company drive, recall is 77% (59 of 77 keyed values) and precision 53%, against the stand-in's 55% and 14% and a bar of 85% and 90%. One slot takes 44 of the 53 values no key gives: the catalogue offers only the network's top speed (`shinkansen_max_operating_speed`), so the model files every line's top speed under it. Without that slot, recall is 78% and precision 86%. On the GitLab replay, 249 of 294 slot-versions are right (85%), against the stand-in's 174. The misses left are amounts in a sentence that names neither the catalogue's words nor the unit ("Policy is set at $80" under "Phone Service"), a rule with no number, and figures in the older copies and the Shinkansen articles.
2. **Answering is held back by search, which is still a stand-in.** Of 150 questions, Inspiration answers 71 right, plain RAG 60 and long context 140. Where search found the expected passage (64 of the 135 questions with an answer), Inspiration was right on 58 (91%); where it did not, on none. The stand-in search cannot cross languages, so Inspiration gets 34 of 50 English questions right, 19 Japanese and 18 Chinese. On changed facts it beats plain RAG by 11 points (18 against 11 of 66), not the 20 the bar asks. Stale answers are 3 of 150 (2%), within the bar.
3. **On a corpus that fits the window, long context is the strongest rival, except on facts no longer stated.** The drive is 311,106 tokens, inside the 1M-token window, and DeepSeek's prefix cache served 99.9% of it from the second question on, so a question costs about CNY 0.006. Long context answered 62 of 66 changed facts, none stale. On the 15 questions the documents in use no longer answer, it gave 6 stale answers, and Inspiration none (13 right). This is the result we registered in advance as "long context beats both on a small corpus" ([Results that would change the design](#results-that-would-change-the-design)). Even if search found every passage and Inspiration stayed right on 91% of them, it would answer about 136 of 150, still short of long context's 140. So we propose the change that table names: aim at what no model can read at once, and measure there next.
4. **Asking little holds.** After the first read, 20 GitLab versions change 20 facts, and people are asked 7 times (2 todos raised, and open todos given more to decide 5 times): 0.35 asks per changed fact, against a bar of at most 1. Whether each was worth asking still needs a reviewer.
5. **The real run found two engine faults, both fixed.** The Postgres store rejected a claim that quotes one span twice (PR #49), and one topic name over 40 characters failed the naming of its whole call (PR #51). Deciding has not yet been scored apart from reading on the real reads.
6. **Real runs are cheap, and the dry run was close.** Off-peak, reading the drive costs CNY 2.37 (about US$0.33) and answering all 150 questions three ways CNY 1.64 (US$0.23): about US$0.56 for a full run, against the dry run's US$0.52. Extraction cost half again more than estimated, because a real model writes about 1,150 tokens per window, twice the stand-in. With the replies kept, the 150-question run reused every reading call and cost CNY 1.33 ([Cost, and how it stays low](#cost-and-how-it-stays-low)).
7. **Next, in order:**
   - The free multilingual embedding, then answering again, for about CNY 0.5 with the replies kept. It waits only on network access to `*.hf.co`.
   - Where long context cannot follow: a corpus larger than the window (more GitLab handbook pages with their history), readers with different permissions (each needs its own prefix, so one cache no longer serves them all), and the cost of keeping up as documents change.
   - Two changes measured as registered in advance: a top-speed slot per line, which means one more paid reading of the drive (about CNY 2), and re-reading less when only headings change (a renamed title re-read the whole GitLab page: 49 windows for a 28% edit).
   - A reviewer's verdict on the replay's 7 asks.

### What we need from the product owner

- **Network access to `*.hf.co`.** huggingface.co answers, but its model files download from `*.hf.co`, which is still blocked. It is all the free multilingual embedding needs; without it, the cross-language questions keep measuring the stand-in search.
- **A decision on the long-context result** (conclusion 3): whether Inspiration aims at what no model can read at once, and says so in the product.
- **About 30 minutes** to check 20 random answer-key entries (rule 3); the keys are written (PR #34). Still open.
- **Agreement on, or changes to,** the pass bars and the design changes proposed in advance. Still open.
- Later, a design partner whose documents we may run in step 4.
- Received: the DeepSeek key (2026-10-27 11:45 UTC, with under US$20 of credit; CNY 103 is left after the first run) and network access to api.deepseek.com and huggingface.co. DeepSeek bills from the prepaid balance, so the credit is the hard cap, and a daily gateway budget of US$5 is a soft stop that ends a day's runs well before the balance does.

Until reading and answering pass, we suggest still pausing engine work that does not serve them: the credential broker, sandbox, views and code graph.

## What we must prove

Inspiration is worth building if it does three things on the documents a company already has. It gives readers and agents the value that holds today, with the passage behind it. It does that more often than search over the same documents. And it asks people only about what the documents cannot settle.

Those documents repeat each other, contradict each other, lag in translation and change without notice. Every test below runs on real public documents of that kind, never on sentences we wrote. The business layer, accounts and permissions are left out: they are standard and certainly buildable.

## Five claims, and how each is tested

The core value breaks into five claims. Each needs its own test, because a miss in one hides behind the others: a right answer can come from luck in reading and a wrong one from a bug in deciding. The pass bars are proposals until the product owner agrees them; the first real run's numbers are now beside them.

| Claim | What it means | Measured as | Proposed pass bar | Today |
| --- | --- | --- | --- | --- |
| 1. Reading | A model turns real text into statements: the right value in the right fact slot, with a verbatim quote | Recall and precision per followed fact against the answer key; values invented where the text states none | Recall at least 85%, precision at least 90%, invented values at most 1% | First real run: on the company drive, 59 of 77 keyed values found, 4 misread, 14 missed: recall 77%, precision 53%, or 78% and 86% without the Shinkansen top-speed slot. GitLab replay: 249 of 294 slot-versions right. Invented values are not yet counted apart from the values no key gives. The stand-in found 42, misread 21 and missed 14 (14% precision), and got 174 slot-versions right |
| 2. Deciding | From those statements, governance gives the value that holds: a newer version replaces an older one on its date, an original holds over its translation, copies count once, a fact a page stops stating is kept and marked, and one fact in English, Chinese and Japanese is one piece of knowledge | Share of fact-versions where the reader gets the key's value, counting only the cases reading got right | 100%: the rules are deterministic, so any miss is a bug to fix | With the stand-ins, right in every case the engine owns: GitLab 21 versions, Kubernetes 15 pages in three languages, control 6 of 8 (the other 2 are the stand-in's). Not yet scored apart from reading on the real reads |
| 3. Answering | On questions about facts that changed, conflict or exist in several languages, answers from governed knowledge beat plain RAG over the same documents and model | Right answers; stale answers; wrong answers given with confidence; citations that quote the source; "not stated" when nothing states it | No worse than plain RAG on facts that never changed, at least 20 points better on facts that changed or conflict, stale answers at most 5% | First real run, right (stale) of 150: Inspiration 71 (3), plain RAG 60 (5), long context 140 (6), the whole 311,106-token corpus in a 1M-token window. Changed facts, 66: 18 (3), 11 (3), 62 (0). Unchanged, 69: 40, 36 and 69, none stale. Not stated, 15: 13 (0), 13 (2), 9 (6). Inspiration by language: English 34 of 50, Japanese 19, Chinese 18, because the stand-in search cannot cross languages; where search found the passage, 58 of 64 right. With the stand-ins: 47 (3), 44 (6), 49 (8) |
| 4. Asking little | People are asked only what the documents cannot settle, and agree the question was worth asking | Todos per changed fact; share settled without a person; share of todos a reviewer marks "worth asking" | At most 1 todo per changed fact; at least 80% marked worth asking | First real run, GitLab replay: after the first read, 20 versions change 20 facts and people are asked 7 times (2 todos raised, and open todos given more to decide 5 times), 0.35 per changed fact; a reviewer has not yet marked them. With the stand-ins: 4 asks, 0.2 per changed fact, and only 1 worth asking, because the other 3 were the stand-in misreading the text |
| 5. Cost | Reading and answering cost little enough for a seat price to carry | Tokens per 1,000 words read; tokens per answer; share of documents that need a model at all | Reported, not gated, until pricing is set | First real run, off-peak: reading the company drive CNY 2.37 (about US$0.33, or US$1.1 per million tokens of documents), answering 150 questions three ways CNY 1.64 (US$0.23), the GitLab replay CNY 1.91. The dry run (PR #39) had estimated US$0.52 for the drive and the questions |

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
- **Long context, where it fits.** For a small corpus, the model reads every document with its date and answers. It is the strongest simple rival, and on the first real run it won at the drive's size (conclusion 3). Where Inspiration cannot beat it on answers, the layer has to earn its place on what does not fit one window, on cost, on change alerts and on owners' work instead.

All three runs report the same numbers as claim 3, plus tokens and time per answer. Whatever Inspiration wins is what reading once, governing and keeping history are worth.

## What the real documents have already shown

Reading is still the open risk, and search now decides most answers. The runs on real text, first with the stand-in model and then with DeepSeek, taught these things invented sentences never would have.

- **Real text is hard to read.** The stand-in missed "$10K", amounts in table cells, HTML tables, a rule with no number ("receipts are required for all expenses" means a threshold of 0), numbers in words ("up to three minor versions older") and another unit ("5分" in Japanese). These are the cases a real model must get right.
- **Real text found engine bugs.** A line break in the HTML split a sentence, "…)," ended one, and a long real heading made the gateway refuse every topic name in an answer. All three are fixed.
- **The baseline and the todo count found two more.** Statements were crowding the answer's own passages out of its sources; an answer now reads 8 passages plus 8 statements. And a fact stated in two places raised a todo when one of the places was removed. Both are fixed.
- **Real text found two missing rules, now built.** A fact a page stopped stating used to vanish without notice (20 of GitLab's fact-versions); it is now kept and marked, with one todo. Copies and translations used to count as separate sources; they now count once.
- **The company-as-it-looks corpus found one more fix and one gap, now closed.** A value that only a reference copy states, older than the governed document, is now out of date: the 2021 copy's 30 days no longer answers beside the policy's 90, while plain RAG still answers 30. The gap: an old revision whose fact has no governing slot was read as current, as with the Chuo Shinkansen's opening in the 2024 Shinkansen articles. PR #38 closed it by recognising old copies and revisions of one document and answering from the latest, which cut Inspiration's stale answers from 5 to 3.
- **Old translations leave out rather than contradict.** The Japanese Kubernetes pages from 2023 and 2024 state the same values as the English ones, and simply lack the newer sections.
- **A real model reads more, and writes more.** It finds 3,241 statements on the drive where the stand-in found 1,339, writes about 1,150 tokens per extraction window, twice the stand-in, and leaves 26 conflict cases where the stand-in left 135.
- **A slot drawn too wide costs precision.** The catalogue's one top speed for the whole network collected every line's top speed: 44 of the 53 values no key gives. The fix is in the catalogue, not the model.
- **Real output found two engine faults.** A model quoted one span twice for one claim, which the Postgres store rejected (PR #49), and one topic name over 40 characters failed the naming of its whole call (PR #51). Both are fixed.
- **Re-reading follows the edit.** On the GitLab replay, each version reads only its added and changed blocks: 448 windows over 21 versions, where reading each version in full would take about 1,000. The one over-read is a renamed title with re-levelled sections, which re-reads every block under them, because extraction reads a block with its headings (2023-10-05: 49 windows for a 28% edit).
- **DeepSeek's prefix cache holds.** After the first question, 99.9% of each long-context call came from it, as the dry run assumed.

## Order of work and cost

Four steps, each closed by a gate. What they need from the product owner is listed above.

1. **Without a model (done, engine thread).** Write the answer keys and the 150 questions (PR #34), add the plain-RAG and long-context runs (PR #32), count todos per changed fact on the GitLab replay (PR #33), and assemble the company-as-it-looks corpus (PR #34). Gate met: all three runs score the same 150 questions end to end with the stand-ins, in 52 seconds in memory.
2. **Real runs on DeepSeek V4.1 Flash (first run done, 2026-10-27).** The model goes through the model gateway, with a multilingual embedding beside it, because the stand-in search cannot match a Chinese or Japanese question to English text. The first run read the drive, answered all 150 questions and replayed GitLab's history for CNY 6.61, about US$0.93, and the response cache replays whatever a change does not touch ([Cost, and how it stays low](#cost-and-how-it-stays-low)). Gate: claims 1, 3 and 5 have real numbers. Met, except that answering still runs on the stand-in search until the multilingual embedding can be downloaded.
3. **Fix and run again.** Work on prompts, the fact vocabulary and tables, then rerun the same keys. Before a reading result changes the design, reading runs once on a larger model, for a few dollars, to tell a limit of Flash from a limit of the design. After the first run this step starts with the embedding, the top-speed slot per line and a corpus larger than the window (conclusion 7). Gate: the pass bars are met, or a result from [Results that would change the design](#results-that-would-change-the-design) changes the design.
4. **A design partner's documents.** A company's own documents, ideally written in Chinese or Japanese, run the same way with their permission. Gate: one of their owners marks which todos were worth asking (claim 4).

### Where each run is kept

Every paid run leaves a trace that a later evaluation can reuse, so nothing is paid for twice. A run log in `apps/bench/runs/` (the first is `2026-10-27-deepseek.md`, PR #50) records the commits, commands, prompt versions, costs and results. The raw reply of every call is exported with `pnpm bench cache export` to the project's shared files, beside each run's reports and every metered call. `pnpm bench cache import` loads the replies into a fresh stack, and a rerun then pays only for the calls a change touches.

### Cost, and how it stays low

A full run costs about US$0.56 off-peak on DeepSeek V4.1 Flash, so the loop can turn several times a day. The dry run (PR #39) estimated US$0.52 before any paid call: it sends every call of the stand-in run through the gateway with the inputs a real model would get, and prices them at DeepSeek's rates with a prefix cache like DeepSeek's. Its output lengths are the stand-ins', so it underestimates extraction, where a real model writes twice as much.

The model is `deepseek-flash` (listed as DeepSeek-V4.1-Flash, with a window of 1,048,576 tokens, so the 311,106-token corpus fits whole). It thinks by default, which bills its reasoning as output, so the config turns thinking off. DeepSeek bills this account in CNY, and its price page cannot be reached from our environment, so the first run measured the prices from the balance around calls of known size, off-peak at 12:00 UTC: CNY 1 per million input tokens, CNY 0.02 per million served from DeepSeek's cache, and CNY 4 per million output tokens. At about 7.1 CNY to the dollar that is half the reported peak prices of US$0.30, 0.006 and 1.20, as the off-peak discount would make it. Peak is seven hours on weekdays, 01:00 to 04:00 and 06:00 to 10:00 UTC; its prices were not measured.

| Part of one full run: the company drive, 150 questions, three rivals | Dry run, off-peak | First real run, off-peak | Runs again when |
| --- | --- | --- | --- |
| Extraction, 339 windows | US$0.18 | CNY 1.99, US$0.28 | The reading prompts or the fact vocabulary change |
| Chunk headers | US$0.05 | CNY 0.33, US$0.05 | Chunking changes |
| Topic names | Under US$0.01 | CNY 0.05, US$0.01 | Topics change |
| Long context's answers: 43 million input tokens, all but 0.3 million from DeepSeek's cache | US$0.22 | CNY 1.24, US$0.17 | Answering changes |
| Inspiration's and plain RAG's answers | US$0.08 | CNY 0.40, US$0.06 | Answering, reading or chunking changes |
| **Total** | **US$0.52** | **CNY 4.01, US$0.56** | |

Reading the drive costs CNY 2.37 however many questions are asked, and each question adds about CNY 0.011 across the three rivals, three quarters of it long context. Embeddings and reranking are not in the figure: they stay stand-ins until an open multilingual model can be downloaded (`*.hf.co`), and then run locally for nothing. The GitLab replay for claim 4 runs separately; it cost CNY 1.91.

Four things keep runs cheap:

1. **The response cache.** The gateway answers a call whose model, prompt, input and settings are unchanged from its cache, at no cost, and keeps replies in Valkey for 30 days; the export above keeps them longer. So a change pays only for what it touches: a new answer prompt pays for the answers (CNY 1.64 for all 150 questions), not for reading again.
2. **Corpus first in long context.** The long-context rival puts the documents before the question, so DeepSeek's cache serves the corpus from the second question on. With the question first, every call would pay for the whole 285,000 tokens it sends, about CNY 43 for 150 questions instead of CNY 1.24. The question after long documents is also the usual advice for answer quality, so the change does not weaken the rival.
3. **Off-peak.** Full runs are scheduled outside DeepSeek's weekday peak hours, at half price.
4. **Spending limits.** The prepaid balance is the hard cap: the provider stops everything when it runs out. Inside it, one gateway budget of US$5 a day covers all calls together. On a database it counts the day's earlier runs, and dry runs never count. The budget is a soft stop. The gateway refuses a call once the day's spend, plus what calls in flight in the same process hold, reaches the limit. A call admitted under the limit can still cost more than it held, through a schema retry or a dearer fallback model, and runs in other processes count only once they have metered. So a day can end a little over US$5.

**Reading is checked in full.** Reading every window costs about CNY 2, no more than a sample of windows would, so there is no sample. The reading check scores the whole read against the answer key without calling a model: for each place the key gives a value, whether governance holds that value (found), other values only (misread) or nothing (missed), plus the values the key does not give (extra), which give precision. The 12 facts without a catalogue entry are reported apart, because only answers can find them.

**Slot fits are held to the catalogue.** Extraction holds a model's slot fits to the fact catalogue: each value has one written form, and a fit with a wrong unit or an unknown qualifier loses its slot and is counted. Without this, "$300" and "300 USD" would be two values and a false conflict. On the first real run, 8 of 3,241 statements were kept without their slot.

The public data needs no sensitivity clearance, so DeepSeek's own API may read it. A design partner's documents in step 4 go only to a provider the gateway clears for their sensitivity; DeepSeek publishes the model's weights, so a host the partner trusts can serve the same model.

## Results that would change the design

A validation is worth running only if some results would change what we build. These were proposed before any result, so that no result can be explained away afterwards. The last column is what the first real run showed.

| If we see | It means | We change | First real run |
| --- | --- | --- | --- |
| Reading recall under 70% after prompt work | Fact slots are too rigid for real wording | Keep slots for high-value facts (amounts, limits, deadlines, owners); keep the rest as open statements grouped by meaning, governed less strictly | Not seen: 77% before any prompt work |
| Plain RAG within 5 points of us on changed facts | The governed layer does not pay for itself in answers | Lead with change alerts and owner reviews; make extract-on-use the default; answer with RAG checked against known statements | Not seen: 11 points ahead, with the stand-in search |
| Long context beats both on a small corpus | A model that reads everything is enough when everything fits | Aim at what no model can read at once (many documents, years of history), and say so in the product | **Seen:** 140 of 150 right, against 71 and 60; the change waits on the product owner |
| More than 3 todos per changed fact, or under 60% marked worth asking | Governance asks people too much | Settle more by rule, raise the bar for a todo, and group by document change (the change-set review) | Not seen: 0.35 per changed fact; worth asking not yet marked |
| Reading costs more per 1,000 pages than a seat can carry | Full reading of everything is too expensive | New sources start as Reference (read on use); only governed folders are read in full | Not judged until pricing is set: about US$1.1 per million tokens of documents, off-peak |
| Deciding gets a case wrong that reading got right | A bug in the engine | Fixed before anything else runs | Not yet scored on the real reads |
