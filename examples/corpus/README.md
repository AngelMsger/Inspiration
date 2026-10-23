# Demo corpus: 青禾科技

A small, hand-written tenant for the ingest prototype and for design work: 19 documents
across a policy library, a team wiki, an archive folder, one Feishu wiki document and one
Feishu approval definition (its four instances are read with it). `corpus.yaml` declares
the tenant, its two spaces, its five sources and the directory that maps source principals
to engine principals. `vocabulary.yaml` is the tenant's predicate catalogue: the
single-valued facts (hotel caps, deadlines, leave days ...) that extraction puts into slots
so governance can compare values across documents.

Run it through the engine with `pnpm engine ingest examples/corpus` (see `apps/engine`).
With the mocked extraction model it gives about 147 claims, 58 of them in 15 slots, and
finds the four planted value conflicts below (hotel cap, meal allowance, first-year leave,
budget deadline). The travel reimbursement deadline is not among them because its
statements carry different qualifiers (差旅 and 日常费用), which is what governance has to
reconcile.

Governance then proposes the values the table below expects: 650 for the hotel cap (the
notice changed it on 2026-10-01, after the policy took effect) and 11-20 for the budget
deadline (the meeting on 2026-09-26 moved it), each a supersession of the policy-library
value; 5 days of first-year leave over the guide's 7, a contradiction; and it settles the
archive's 500 and 80 alone. That is three todo requests, two of them high priority.

Freshness gives twelve documents a yearly review clock (their claims are policy) and three
a 180-day one (process); the minutes are a record of their day, the archive is retired, and
two documents hold only general knowledge, so none of those is ever due by age. When the
travel policy changes, its forwarded copy in the HR folder no longer matches it, so
freshness asks for a look at the copy (evidence_changed); the archived 2023 edition is left
alone.

## Governance levels

Front matter and `.meta.yaml` set `governance` (kept in `metadata.extra.governance`):
`policy` (制度, approved and numbered), `guideline` (指引), `reference` (参考, FAQs),
`note` (纪要、周报、通知) and `process` (approval definitions). Source defaults set
authority: policies 0.9, the Feishu approval 0.7, the Feishu wiki 0.6, the team wiki 0.5,
the archive 0.3.

## Permissions

- `制度库` is readable by the whole tenant; finance and HR folders add their editors.
- `制度库/财务/内部` is finance only (`group:finance`), its budget note `confidential`.
- `制度库/人事/薪酬` is HR only, its payroll policy `confidential`.
- The Feishu FAQ is shared with the finance department and readable by the tenant by link.

## Planted duplicates

| Document | Duplicate of | Kind |
| --- | --- | --- |
| 制度库/人事/转发-差旅费管理办法.md | 制度库/财务/差旅费管理办法.md | exact (only front matter differs) |
| 归档/差旅费管理办法（2023 版）.md | 制度库/财务/差旅费管理办法.md | near (older numbers, archived) |

## Planted conflicts and stale statements

| Topic | Statements | What a reviewer should conclude |
| --- | --- | --- |
| First-tier city hotel cap | Policy: 600 元 (approved, from 2026-01-01). Notice, meeting minutes (2026-09-26), FAQ and Feishu FAQ: 650 元 from 2026-10-01. Archive: 500 元. | The policy is stale: a newer decision supersedes it until the revision is published. The archive is superseded, not a conflict. |
| Travel reimbursement deadline | Travel policy: 30 days after the trip. Expense policy: 60 days (general). FAQ: travel within 60 days. Onboarding guide: 60 days. | The travel policy is specific and wins for travel; the FAQ is wrong for travel. |
| Annual leave in the first year | Attendance policy: 5 days after one year. Onboarding guide: 7 days in the first year. | The guide is wrong. |
| Approval thresholds | Travel: 5000 元 department head, then CFO. Expenses: 2000 / 20000 tiers. Feishu approval: CFO from 5000 元. | Different scopes, not a conflict; the approval flow matches the travel policy. |
| 2027 budget deadline | Budget note: 11-15. Meeting minutes: moved to 11-20. | The note is stale. |
| Meal allowance | 2026 policy: 100 元 a day. Archive: 80 元. | Superseded by the newer version. |
