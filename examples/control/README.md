# Control corpus

A small tenant built so that every case has one right answer, for measuring the pipeline
case by case instead of by a single truth count. It has 14 documents in three sources: a
policy library and team handbooks, both governed with authority 0.9, and a team wiki of
reference documents with authority 0.5. All are in English except one Chinese translation.
`expected.yaml` holds the answers, and `vocabulary.yaml` the catalogue of facts extraction
puts into slots. A Chinese copy is in [README.zh.md](README.zh.md); if the two differ, this
English version wins.

Run it with `pnpm engine ingest examples/control`. After the usual report, the control check
prints each case as **right**, **known gap** (it differs the way `expected.yaml` records) or
**differs**. For every value of a slot it shows four things:

- which documents put the value in the slot, so a statement in the wrong slot shows;
- its independent sources, where documents that normalization found to be copies of each
  other count once;
- what governance counts: statements, the governed ones in effect, and documents;
- whether it is proposed, and if not, what became of it.

`apps/engine/test/control.test.ts` runs it in memory and on Postgres. With the stand-in
model, the extraction results measure the pipeline and the stand-in, not a model. The same
corpus is meant to be run again once a real model is configured.

## Cases

| Case | The question | Expected | Today |
| --- | --- | --- | --- |
| copied-faq | Do three copies of an outdated FAQ (180) outvote the travel policy (200)? | 200 holds; 180 is a note; the copies are one source | right |
| pasted-paragraph | Three 2025 handbooks paste one paragraph (50) and the 2026 travel policy says 60. Does 50 win? | 60 holds; 50 is superseded; one source | known gap: 50 is proposed, three statements against one |
| two-named-deadlines | "Refunds are paid within 14 days of approval; customers may object to a decision within 30 days." Both facts are in the catalogue. | 14 and 30, each in its own slot | right |
| unnamed-deadline | "Returns are accepted within 30 days of delivery, and damaged items must be reported within 7 days." Only the return window is in the catalogue. | 30 in the return window, 7 nowhere | known gap: the stand-in puts 7 in the return window, and claim IDs pick it |
| qualified-deadlines | "Travel expenses must be claimed within 30 days of the trip, other expenses within 60 days." | 30 for travel, 60 for other expenses | right |
| elliptical-deadline | "Standard orders ship within 3 days; express orders within 1 day." | 3 and 1, each with its qualifier | known gap: the express deadline is not read |
| reposted-notice | A notice (40) is copied into two handbook folders. Two handbooks say 45 in their own words. | 45 holds, two sources against one | known gap: 40 is proposed, three statements against two |
| translated-policy | The leave policy (20 days), its Chinese translation and an onboarding note | 20, two sources: the translation is a copy | known gap: three sources |

Each case's entry in `expected.yaml` explains why the engine gets it otherwise today.

## What the run shows

8 cases: 3 right, 5 known gaps.

- **Statements:** 22 of the 23 are in their slot with their value. The express deadline is
  missed, and the 7 days to report damage land in the return window.
- **Sources:** 11 of 14 values have the expected independent sources.
- **Proposals:** 7 of 11 slots get the expected proposal, and 8 the expected outcome for the
  other values.

What the gaps point at:

1. **Governance counts statements, not sources.** Between equally authoritative governed
   statements the tie-break counts statements in effect today. Exact copies count as often
   as there are copies, even though normalization reports them as duplicates
   (reposted-notice), and so does a paragraph pasted into several documents
   (pasted-paragraph). Reference documents never outvote a governed one, so copied-faq is
   right however often the FAQ is copied.
2. **A later effective date does not count between equals.** A newer policy wins only when
   it states a dated change ("from 1 January 2026"), not by its document's effective date
   (pasted-paragraph).
3. **Copies that normalization does not see:** a pasted paragraph, and a translation
   (translated-policy). Knowledge does not depend on its language, so a translation should
   count as a copy.
4. **The extraction stand-in, not the engine:** it reads each passage alone and gives a
   clause without a catalogue word the passage's fact (unnamed-deadline,
   elliptical-deadline). These two are the cases to watch when a model runs.

## Documents

| Document | Level | Effective | States |
| --- | --- | --- | --- |
| policies/travel-policy.md | governed | 2026-01-01 | hotel 200, meals 60, claims within 30 days (travel) and 60 (other) |
| policies/customer-policy.md | governed | 2026-01-01 | refunds 14, objections 30, returns 30 (damage 7, not in the catalogue), shipping 3 and 1 |
| policies/leave-policy.md | governed | 2026-01-01 | annual leave 20 days |
| policies/leave-policy.zh.md | governed | 2026-01-01 | the same, in Chinese |
| policies/taxi-notice.md | governed | 2025-01-01 | taxi 40 a day |
| handbooks/sales/taxi-notice.md, handbooks/support/taxi-notice.md | governed | 2025-01-01 | exact copies of the notice |
| handbooks/sales.md, handbooks/engineering.md | governed | 2025-01-01 | taxi 45 a day, each in its own words; meals 50 (pasted) |
| handbooks/support.md | governed | 2025-01-01 | meals 50 (pasted) |
| wiki/travel-faq.md and its copies in wiki/sales and wiki/support | reference | | hotel 180 |
| wiki/onboarding.md | reference | | annual leave 20 days |
