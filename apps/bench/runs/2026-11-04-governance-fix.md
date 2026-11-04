# 2026-11-04: the governance fix and the decisive test's answers again

The follow-up the product owner chose on 2026-11-04 at 02:32 UTC after
[the decisive test](2026-11-02-decisive.md) missed its bar: "Fix the loss, rerun governed arms. I
fix the provisional rule and the audit, rerun the governed arms for about CNY 2 (at most 3) within
the approved CNY 23, then report before any change of direction." At 12:10 the product owner
raised the stop to CNY 3.20 for a run of all five arms, after the free dry run priced it at CNY
3.01. The governance fix landed in PRs #96, #102 and #103; the 276 questions were answered again on
`deepseek-flash` from 12:16 to 15:10 UTC, off-peak, for CNY 2.38. A Chinese copy is in
[2026-11-04-governance-fix.zh.md](2026-11-04-governance-fix.zh.md).

The full record is in the project's shared files, `inspiration/validation/runs/2026-11-04-governance-fix/`:
the process log with every decision, approval, mistake and cost (`process-log.md`, `.zh.md`), each
audit and dry run with its config, the DeepSeek balance before and after (`balances.txt`), the
hand check's verdicts and the scoring scripts (`scoring/`), and every model reply the cache gained
since the decisive test's export (`replies-2026-11-04-new.jsonl.gz`, 3,121 lines, 471 of them this
run's paid answers).

## Conclusions

- **Inspiration still does not lead the mature RAG by 10 points.** It answers 248 of the 276
  questions right (239 on 2026-11-03), the mature RAG 234 (233): +5.1 points, and +6.9 on the 204
  changed or conflicting questions, where the aim is 10. Resampling facts, the 95% interval of that
  gap is +1.5 to +12.7, so the lead is now clear but its size is not. Both answer 70 of the 72
  controls. The decision table says what follows: keep a light layer on a mature RAG or long
  context. The product owner decided otherwise on 2026-11-04 at 18:03 UTC: accept the lead as
  stable, keep the 10 points as a long-term goal on a larger dataset close to real use, pause this
  line and build an MVP next ([the validation spec](../../../docs/design/validation.md#where-we-stand)).
- **Governance no longer makes long context worse: 257 against 252.** Governed long context
  answers all 27 questions on changes announced outside the policy page (8 before; raw long
  context 16) and all 36 on restated copies that lag. Its lead over raw long context, +1.8 points
  (interval −5.1 to +9.1), is within chance. Over the mature RAG it leads by 10.3 points on changed
  or conflicting facts (interval 0.0 to +20.6), the aim's size; raw long context alone leads by
  7.8, so governance's own share is +2.5 (interval −6.9 to +11.8).
- **The fix was designed on this corpus's failures, so this is not an independent test.** Both
  rules came from reading the 20 questions governed long context lost on 2026-11-03. Of those 20,
  12 are now right. A claim that governance adds answers needs cases the fix never saw.
- **One loss remains: governed sources that disagree, 11 against raw long context's 21 of 24.**
  The audit finds both values in what governed long context gives the model, but in 13 answers the
  model names only one. The answer prompt asks for "the one that holds" and a note that sources
  differ, and a passage carries no standing, so when two governed values are disputed the model
  picks one and often drops the note. Marking disputed values in that input, as outdated ones are,
  is the likely fix; it is not tested.
- **Inspiration and the compact answer each gain 9 and lose none,** 7 and 8 of them on changes
  announced elsewhere (`frequent_traveler_trips`, `coworking_approval_days`, `flight_upgrade_hours`
  and others). The compact answer now leads the mature RAG by 8 questions. At the cost per
  answer measured on 2026-11-03 it costs about a seventh as much; this run's charges cover only the
  calls that changed, so they give no cost per answer of their own.
- **Review load rose: 60 todos and 4 notes for 183 read documents, against 52 and 13.** A
  reference document's dated change now holds and asks the governed page's owner, a todo rather
  than a note, and decides 13 values against 4. That is 33 todos per 100 documents, with no
  "Decide for me"; bar 4 is 5 per 100 after it.
- **Two runs of the same arm differ by a few questions, with no change to its inputs.** The mature
  RAG has no governance, yet 51 of its 276 prompts changed and it gained 3 and lost 2. Search breaks
  ties between equal scores by IDs that are new in each run, and the corpus holds many identical
  copies, so which copy comes first changes from run to run. A stable tie-break would make reruns
  cheaper (CNY 0.29 of this one) and comparisons cleaner.

## Results

Right answers of 276, scored as on 2026-11-03: citation markers removed, then every answer that
names an old value beside the current one read by hand (58 this time: 47 verdicts reused where the
answer was identical, 11 new). "Stale" says or implies an old value holds; "one-sided" names one
of two governed values; "hedged" names the current and an old value and leaves open which holds (a
lenient count adds them: 241, 250, 245, 255 and 257).

| Arm | Right, 2026-11-03 | Right now | Changed or conflicting, 204 | Control, 72 | Stale | One-sided | Hedged |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Mature RAG | 233 | 234 | 164 | 70 | 6 | 5 | 7 |
| Inspiration | 239 | 248 | 178 | 70 | 5 | 2 | 2 |
| Compact | 233 | 242 | 173 | 69 | 7 | 2 | 3 |
| Long context | 252 | 252 | 180 | 72 | 15 | 3 | 3 |
| Governed long context | 243 | 257 | 185 | 72 | 3 | 13 | 0 |

The gaps, resampling the 92 facts with their three languages (10,000 draws):

| Gap | All 276 | Changed or conflicting, 204 | Control, 72 |
| --- | --- | --- | --- |
| Inspiration − mature RAG | +14, +5.1 points (+1.1 to +9.4) | +14, +6.9 (+1.5 to +12.7) | 0 |
| Compact − mature RAG | +8, +2.9 (−1.8 to +8.0) | +9, +4.4 (−2.0 to +11.3) | −1 |
| Governed long context − mature RAG | +23, +8.3 (+0.7 to +15.9) | +21, +10.3 (0.0 to +20.6) | +2 |
| Long context − mature RAG | +18, +6.5 (0.0 to +13.4) | +16, +7.8 (−1.0 to +17.2) | +2 |
| Governed − raw long context | +5, +1.8 (−5.1 to +9.1) | +5, +2.5 (−6.9 to +11.8) | 0 |

By pattern, with 2026-11-03 before the arrow where it changed:

| Pattern | Questions | Mature RAG | Inspiration | Compact | Long context | Governed long context |
| --- | --- | --- | --- | --- | --- | --- |
| Restated and lagging | 36 | 33 → 32 | 34 → 35 | 33 | 32 | 36 |
| Newer but not authoritative | 27 | 20 | 23 | 22 | 27 | 27 |
| Renamed or moved | 33 | 30 | 31 | 29 | 33 | 31 → 30 |
| Lagging translation | 33 | 27 → 26 | 29 | 30 | 27 | 32 → 30 |
| Governed sources disagree | 24 | 18 | 20 → 21 | 20 → 21 | 21 | 13 → 11 |
| Changed elsewhere | 27 | 14 → 17 | 11 → 18 | 11 → 19 | 16 | 8 → 27 |
| Distorted restatement | 24 | 21 | 21 | 19 | 24 | 24 |
| Control | 72 | 70 | 70 | 69 | 72 | 72 |

Governed long context gained 23 and lost 9. The gains: 19 changes announced elsewhere
(`auto_accept_hours`, `coworking_approval_days`, `domestic_flight_advance`,
`flight_upgrade_hours`, `frequent_traveler_trips` and `hotel_booking_lead` in three languages each,
and one question on `production_kubernetes_version`), the LoadBalancer limit per namespace, whose
runbook and FAQ values it had dropped (3), and one lagging translation of `csi_migration_state`. The losses: one side of a
governed disagreement on `life_event_gift_limit` (2), `rental_car_lead_time` (2) and
`travel_insurance_trip_duration` (1), where the audit finds both values in its input; the home
internet allowance (3), whose governance records are the same in both runs, so its input changed
only around other facts; and `volume_populators_state` (1), which reading misreads (below). Raw
long context's answers all came from the cache, so it is the same run as on 2026-11-03.

Against the pass bars:

1. **Governance removes no right value: not met, by one misread fact.** The free audit on main
   keeps 267 of 276, demotes 6 and drops 3. The 9 are three facts reading gets wrong whatever the
   rule: the purchasing card's limit (reading put the $125 cap on gifts in its slot) and the gold
   storage class's IOPS, demoted; and the volume populators' state, dropped, since reading put
   another feature's alpha state, dated 2022-12-09, in its slot, and a dated change makes the beta
   statements out of date. Governed long context is less right than raw on two patterns: by 10
   questions on governed disagreements, where the audit keeps both values, and by 3 on renamed or
   moved facts, the misread volume populators.
2. **At least as right as the mature RAG, no fewer on the control: met** (248 against 234; 70
   each). **10 points more on changed and conflicting facts: missed** (+6.9).
3. **The fast model:** not run.
4. **Review load:** 60 todos for 183 read documents, 33 per 100, with no "Decide for me" (28 per 100
   before); the bar is 5 per 100 after it.
5. **Cost, at most a third of the mature RAG's input:** unchanged, since the arms' inputs are the
   same size as on 2026-11-03: Inspiration 56%, missed; compact 22%, met.
6. **Speed, the answering model faster than the mature RAG and long context:** not tested again.
   This run timed only the calls that missed the cache, a different subset for each arm, and none
   for raw long context, so its medians describe those subsets and do not test the bar: the
   answering model took 1.60 s for Inspiration (80 timed), 1.47 s for compact (64), 1.71 s for the
   mature RAG (51) and 2.83 s for governed long context (276). The 2026-11-03 result stands: met,
   narrowly.

## What changed in governance

Both rules are in `engine/governance/src/slots.ts`, with their tests on memory and Postgres:

- **A change a reference document dates holds** (#96, #103). An announcement on the shared drive
  that a value changes on a stated day, once that day has come, now holds over the governed
  policy's older value and asks the policy's owner to update it (a high todo, not a note). Once a
  new edition of the policy adopts the value, the announcement's change still dates it, so the old
  edition's value stays out of date. This is an exception to "a reference document never outvotes
  a governed one", limited to a dated change already in effect; how much authority a reference
  document needs before its change may hold is a product call, open (the product owner's review of
  #96).
- **Two governed documents that disagree are a contradiction unless one has stood still for a
  year** (#96, #102). The older is superseded only when it last changed at least 365 days before
  the other (`IN_USE_DAYS`, the yearly review a policy gets); otherwise both are in use and both
  values stay, disputed. "Last changed" is the document's modified time, else its own date, so a
  policy in effect since 2020 and edited last week counts as in use.

A folder source dates a document by its file's modified time, and a checkout dates every file the
day it was made, so each corpus records when its files last changed in `files.yaml` (the control
corpus gained one in #103, after #102's control test failed on CI). The audit became stricter in
the same day's other pull requests (#105, #106, #111: negation, conditions and a changed meaning,
issue #68), with no change to the engine.

## What ran

- **Code:** main at `f6987b1` for the answers, with #96, #102, #103, #105 and #106; the last free
  audit on `32b969c`, which adds only #111, a correction to one key entry.
- **Model, options and prompts:** as on 2026-11-02: `deepseek/deepseek-flash`, `thinking: {type:
  disabled}`, the off-peak prices of 2026-10-27; `answer_question@3`, `translate_question@1`,
  `write_context@1` (stand-in); the reading replayed from the cache (`extract_claims@4`,
  `name_topics@2`). The gateway is the decisive test's with its budget at CNY 3.20.
- **Commands**, each on a fresh database under a name never used before, detached from the
  session:

  ```bash
  # free audit, replies only (cache_only), 10:23-11:30 UTC
  pnpm bench ingest examples/decisive-test --today 2026-11-02 --context 1000000 --gateway gateway.cache-only.yaml --stack --sample 1 --search-only --json audit-4.json
  # free dry run, 08:58-12:00 UTC: saved replies replay, stand-ins answer and price the rest
  pnpm bench ingest examples/decisive-test --today 2026-11-02 --context 1000000 --gateway gateway.dry-main.yaml --dry-run --stack --sample 1 --json answers-dry-main.json
  # the paid run, 12:16-15:10 UTC
  pnpm bench ingest examples/decisive-test --today 2026-11-02 --context 1000000 --gateway gateway.rerun.yaml --stack --sample 1 --json answers-rerun.json
  ```

- **Rescoring**, at no cost, the same for both runs: the report's outcomes with citation markers
  removed, then the hand check's verdicts (`scoring/verdicts-full.json` and
  `scoring/verdicts-rerun.json`), and the intervals from `scoring/boot-rerun.py`.

## What it cost

By DeepSeek's balance, CNY 2.38: 81.52 before, 79.14 after. The decisive test has now spent CNY
19.44 of the CNY 23 approved. The audits and dry runs cost nothing.

| Arm | Priced by the config | Calls (from the response cache) | Input tokens (from the prefix cache) | Output tokens |
| --- | --- | --- | --- | --- |
| Governed long context | CNY 1.73 | 276 (0) | 56,945,079 (56,431,744) | 22,793 |
| Inspiration | CNY 0.33 | 276 (196) | 397,281 (99,968) | 7,921 |
| Mature RAG | CNY 0.29 | 276 (225) | 467,443 (205,952) | 5,464 |
| Compact | CNY 0.07 | 276 (212) | 127,063 (78,208) | 6,013 |
| Long context | 0 | 276 (276) | 0 | 0 |
| All | CNY 2.43 | 1,380 (909) | 57,936,866 (56,815,872) | 42,191 |

Tokens are counted for the calls that reached DeepSeek. The dry run had priced CNY 3.01 and
DeepSeek charged 79% of it, mostly because the real calls drew more from its prefix cache than the
stand-ins' forecast assumes. Governed long context's answers cost CNY 0.0063 each against 0.0049 on
2026-11-03: raw long context, which reads the same documents first, came from the
response cache this time, so governed long context warmed the prefix cache itself (99.1% of its
input from it, against 99.8%). The mature RAG's CNY 0.29 bought nothing new: its inputs differ
only by the tie-break above.

## What the run taught

The process log has each mistake as it happened; these are the lessons, added to the spec's
"How runs stay cheap" in this pull request:

1. **A dry run reads the shared cache and never writes to it** (`ReadOnlyCache`). A route that may
   only replay cannot price answers, because answering stops at the first changed question; a dry
   run replays what is saved, answers the rest with stand-ins and prices exactly what a real run
   would pay for.
2. **A job longer than two hours runs detached from the session.** The plan already said so, and
   the first dry run still ran as a background command and was stopped at two hours; it cost two
   hours, nothing else.
3. **A run's name is used once.** Its events go through Valkey streams named after its database,
   and those outlive a stopped run; two restarted runs under the same names read the stopped runs'
   events (13,133 documents fetched against 6,735, 158 dead letters) and were discarded. The run
   scripts now refuse a name with streams left.
4. **A corpus records when its files changed**, since the in-use rule reads it and a checkout
   dates every file the same day. #102 was pushed after the governance, demo and drive tests but
   not the whole suite, and its control test failed on CI; `make check` runs in full before every
   push.
5. **A rerun is compared under one scorer.** Both runs were scored here by the same script and hand
   check, and an answer identical to one already read keeps its verdict.
6. **Search should break ties by something stable.** Until it does, an arm's count moves by a few
   questions between runs, and a rerun pays again for prompts that changed only in order.

Engine follow-ups this run surfaced, none fixed here: disputed values unmarked in governed long
context's input (above); the tie-break; and citations, where a real model's paraphrase makes an
answer cite every line of a passage (up to 35 markers in one governed long context answer), which
the scoring strips but a reader would see.
