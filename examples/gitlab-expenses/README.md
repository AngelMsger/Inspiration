# GitLab expense policy, replayed

One real policy document, replayed through six years of its edit history, for measuring
extraction and governance on knowledge that changes. The document is GitLab's travel and
expense policy from its public handbook, at 21 versions between November 2020 and September
2026. The replay writes each version over the last one, with the engine's clock at the day
it was published, ingests, and asks governance what it would tell a reader about 14 facts
(hotel cap, meals per day, receipt threshold, claim deadline and so on). A Chinese copy is in
[README.zh.md](README.zh.md); if the two differ, this English version wins.

```bash
pnpm engine replay examples/gitlab-expenses          # in memory, about 6 seconds
pnpm engine replay examples/gitlab-expenses --stack  # Postgres and Valkey
```

`apps/engine/test/history.test.ts` runs it in memory and on Postgres and holds the result to
`timeline.yaml`.

## Files

| File | What it holds |
| --- | --- |
| `history/` | the 21 versions, byte for byte as GitLab published them, named `<date>-<commit>.md` |
| `history.yaml` | the steps in order: date, version, commit, link to the page at that commit, commit title |
| `timeline.yaml` | what a reader should be told about each fact from each day on, read from the versions by hand; and, per fact, where the engine says something else today and why |
| `vocabulary.yaml` | the 14 facts as 9 predicates with qualifiers, worded as the policy words them |
| `corpus.yaml`, `handbook/` | one governed folder source; the replay writes the versions to `handbook/finance/expenses.md` |

## Source and licence

The versions are from the GitLab handbook: until October 2023
[`sites/handbook/source/handbook/finance/expenses/index.html.md`](https://gitlab.com/gitlab-com/www-gitlab-com/-/commits/master/sites/handbook/source/handbook/finance/expenses/index.html.md)
in `gitlab-com/www-gitlab-com`, then
[`content/handbook/finance/expenses.md`](https://gitlab.com/gitlab-com/content-sites/handbook/-/commits/main/content/handbook/finance/expenses.md)
in `gitlab-com/content-sites/handbook`. They are © GitLab Inc. and contributors, licensed
under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/), and copied unchanged;
`history.yaml` links each one to its commit. The rest of this folder is ours.

From the 500 most recent commits of the page in the two repositories (200 in the old one,
back to November 2020, and 300 in the new one, up to September 2026), the versions kept are those in which one of the 14
facts changed, appeared or went away, plus edits that change none of them (the move between
repositories, a rename, payroll dates), which should change no knowledge. Commits that only
repeat a change already kept were left out to keep the run short.

## What happened to the policy

| Day | What changed for the facts followed |
| --- | --- |
| 2020-11-17 | First version kept. "Itemized receipts are required for all expenses" (a threshold of 0), "submitted within 30 days", a hardware table with external monitors at $380 and portable ones at $200 |
| 2021-05-10 | Monitors $400 |
| 2021-06-23 | Monitors $500, ultra-wide $1,000 |
| 2021-12-03 | Page reorganised; the hardware table leaves the page, and the policy summary is indented four spaces |
| 2021-12-13 | Year-end holiday budget; none of the facts |
| 2022-01-20 | "Itemized receipts are required for all business related expenses that are greater than $75" |
| 2022-01-27 | "submitted within 90 days"; phone service "$200 monthly threshold" |
| 2022-05-31 | Page rewritten and shortened; "Cell phone service is reimbursable up to $200" |
| 2023-02-08 | Receipts for all expenses again; phone $50; monthly limit "$5K"; home office stipend $1,500 for new hires and $500 a year, in table cells; no claim deadline stated |
| 2023-05-17 | "Expense claims over 90 days ... will not be reimbursed"; the phone cap moves into an HTML table as "Policy is set at $50" |
| 2023-08-29 | The Global Travel and Expense Policy: hotels $300 a night, meals $100 a day, internet $50 a day, US team members' receipts over $50, monthly limit "$10K", E-Group "$20K", the stipend in sentences; phone "Policy is set at $80" |
| 2023-10-05 | Email addresses highlighted; none of the facts |
| 2023-10-16 | The page moves to the new handbook repository; none of the facts |
| 2024-01-22, 2024-02-06, 2024-02-08 | Wording edits; none of the facts |
| 2026-02-17 | Payroll cutoff dates; none of the facts |
| 2026-03-18 | The page is replaced by a two-line notice: "This page has moved" to the internal handbook |
| 2026-05-14 | The page comes back, unchanged in the facts |
| 2026-06-19 | Meals $120 a day; phone "Policy is set at $100" |
| 2026-09-13 | HelpLab renamed Compass; none of the facts |

Where a version stops stating a value without replacing it (the hardware table, the moved
notice), `timeline.yaml` keeps the value: knowledge never disappears silently
([source changes](../../docs/design/source-changes.md), rule 1), and in this replay nobody
retires it.

## What the run shows

With the stand-in model, **174 of 294** fact-versions (14 facts after each of 21 versions)
lead with the value a reader should be told. That splits into two very different halves:

- Of the 82 fact-versions in which the policy stated nothing yet, all 82 are right: nothing
  is invented, though one statement lands in a slot of its own (below).
- Of the 212 in which it stated a value, 92 are right. 13 lead with a wrong value:
  `receipt_threshold` takes "$5,000 USD" from the line above an indented summary twice, and
  `phone_service_monthly_cap` keeps the $50 of 2023 in 11 versions that say $80 and then
  $100 in words the stand-in does not read. The other 107 lead with nothing.

Every miss is the stand-in's; the part the engine owns is right throughout:

- A new version supersedes the old value on the day it is published: the claim deadline goes
  from 30 to 90 days on 2022-01-27, the phone cap from 200 to 50 on 2023-02-08, meals from
  100 to 120 on 2026-06-19. Edits that change none of the facts change nothing.
- A version that stops stating a fact keeps it, marked "no longer stated", and gives the
  document's owner one todo that lists everything it stopped stating. The moved notice of
  2026-03-18 keeps all nine facts the page held until it comes back on 2026-05-14, which
  removes the marks and withdraws the todo. The phone cap, which the stand-in stops reading
  in 2023, is still 50, marked, today; the page says $100. Keeping a fact is the engine's
  rule; not reading the new value is the stand-in's miss.

Before the engine kept such facts, the run was 165 of 294: the moved notice and two values
the stand-in stopped reading made 9 fact-versions disappear silently, against rule 1 of the
[source-change design](../../docs/design/source-changes.md).

The 120 misses all come from the stand-in not reading a value. It reads digits next to
catalogue words, which real policy text often does not offer. It misses:

- amounts in thousands ("$10K");
- table cells with a currency sign ("$380" under "Average Price in USD");
- HTML tables;
- a rule with no number ("required for all expenses", which means 0);
- wording outside the catalogue ("**Phone** \| $200", or "new Team Members" for new hires);
- a cap written as a setting under its heading ("Policy is set at $80" under "Phone
  Service"), with neither the catalogue's words nor a month in the sentence.

The same corpus is meant to run again once a real model is configured. Then the 120 measure
extraction quality.

Two more findings from real text:

- **A statement in a slot of its own.** "providing new Team Members with a $1,500 USD ...
  stipend" names the stipend without the qualifier's words, so it lands in an unqualified
  `home_office_stipend` slot next to the two qualified ones. The check reports it as a slot
  `timeline.yaml` does not name.
- **One overlong topic name loses every name in the answer.** The page compiler's stand-in
  cut English names at 60 characters, but a `name_topics` answer allows 40, so a long real
  heading made the gateway refuse the whole answer, and every topic in it fell back to its
  first heading ("no valid names for topics"). The English pack now cuts at 40. A real model
  can make the same slip, so the refusal of a whole answer for one name is worth revisiting
  in the page compiler.

`timeline.yaml` gives each fact's reason in full. When a change closes one of these gaps, the
history test fails until its entry there is deleted, so every improvement shows up as a diff
of that file.

## What it asks of people

The replay also counts what each version asks a person to decide (`review` in the report and
the `review:` line). After the first read, the 20 versions change 20 facts: a value appears,
changes or stops being stated. They raise 2 todos and give the open todo more to decide twice,
so people are asked 4 times, 0.2 per changed fact. One of the todos is withdrawn a week later
without a person. The first read asks nothing.

One of the four asks is worth a person's time, and the other three are the stand-in's:

- **2026-03-18, worth asking:** the page becomes a moved notice, and the open todo lists the
  nine facts it no longer states.
- **2022-01-20, the stand-in's:** a conflict between 5,000 and 75 for the receipt threshold,
  where 5,000 is the stand-in's misreading of the indented summary. The next version ends the
  conflict and withdraws the todo.
- **2023-02-08, the stand-in's:** "Items over 90 days from purchase date will not be
  reimbursed" is the claim deadline in other words, which the stand-in does not read, so the
  two statements of 90 days are listed as no longer stated.
- **2023-05-17, the stand-in's:** the phone cap moves into an HTML table as "Policy is set at
  $50", which the stand-in does not read. The page goes on stating the cap, as $80 and then
  $100, and the todo stays open.

Counting found one gap of the engine's own, now fixed. On 2022-01-20 the page dropped the
second of its two copies of the policy summary, and the 30-day deadline stated there was
listed as no longer stated, though the page still states it elsewhere. A statement whose
place goes is now superseded by a current statement of the same fact that the version still
makes, so a fact stated twice asks nothing when one place goes.

Writing the answer keys of the next benchmark, a company drive built from these versions,
found a mistake in this one: `timeline.yaml` had the phone cap no longer stated from
2023-08-29, where the page says "Policy is set at $80" under the heading "Phone Service", and
later $100. The key is corrected, which took the run from 185 to 174 and the changed facts
from 18 to 20. A key written by one person needs a second reader, as the validation design
asks.
