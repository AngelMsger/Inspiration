# Demo corpus: 青禾科技

A small, hand-written tenant for the ingest prototype and for design work: 19 documents
across a policy library, a team wiki, an archive folder, one Feishu wiki document and one
Feishu approval definition (its four instances are read with it). `corpus.yaml` declares
the tenant, its two spaces, its five sources and the directory that maps source principals
to engine principals. `vocabulary.yaml` is the tenant's predicate catalogue: the
single-valued facts (hotel caps, deadlines, leave days ...) that extraction puts into slots
so governance can compare values across documents. A Chinese copy is in
[README.zh.md](README.zh.md); if the two differ, this English version wins.

It is also the tenant of the demo (`pnpm demo`, see `apps/web`): `people.yaml` names three of
its members, whom the web app's stand-in backend offers to act as in place of signing in.

Run it through the engine with `pnpm bench ingest examples/corpus` (see `apps/bench`).
With the mocked extraction model it gives about 120 claims, 58 of them in 15 slots, and
finds the four planted value conflicts below (hotel cap, meal allowance, first-year leave,
budget deadline). Reference documents are read only where they name a catalogue fact, so 8
of their claims outside any slot are left unused, and the weekly report is not read at all.
The travel reimbursement deadline is not among the conflicts because its statements carry
different qualifiers (差旅 and 日常费用), which is what governance has to reconcile.

Governance then proposes 650 for the hotel cap (the notice changed it on 2026-10-01, after
the policy took effect), a supersession of the policy-library value, and 5 days of
first-year leave over the guide's 7, a contradiction; it settles the archive's 500 and 80
alone. It proposes the meeting minutes' 11-20 for the budget deadline: the minutes are a
reference document, but they record a decision dated 2026-09-26, after the budget note, so
the note's owner is asked to update it or reject the change. That is three todo requests,
two of them high priority, and no note.

Freshness keeps review clocks only for the 14 governed documents: eight get a yearly one
(their claims are policy) and three a 180-day one (process); the archive is retired and two
documents hold only general knowledge, so none of those is ever due by age. When the travel
policy changes, its forwarded copy in the HR folder no longer matches it; the copy is a
reference document, so nobody is asked to review it, and the archived 2023 edition is left
alone.

## Governance levels

`governance_level` in front matter, `.meta.yaml` or the Feishu properties, else the source's
in `corpus.yaml`, says how far the engine governs a document:

- `governed`: the policy library, the notice folder (团队知识/通知), the onboarding guide,
  the approval definition and the archive (governed, but archived). Extracted in full; their
  values decide a slot and their owners get reviews and todos.
- `reference`: the team wiki's minutes and FAQ, the Feishu wiki and the forwarded copy in
  the policy library. Read where a block names a catalogue fact, and only claims that fill a
  slot are kept; the rest of a passage is read when a page or an answer uses it. Their values
  never outvote or hold up a governed one, except a change they date that is in effect and
  later than it, such as the minutes' decision; a value only they state is a note for the
  owner.
- `search_only`: the weekly report. Searchable, never extracted.

Authority is separate and comes from the source defaults: policies 0.9, the Feishu approval
0.7, the Feishu wiki 0.6, the team wiki 0.5, the archive 0.3.

## Topics

Page-compiler clusters the 34 sections of current governed documents into 9 topics and one
area, using the fake embeddings, which only see shared characters:
- Similar headings across documents make topics: 住宿, 报销 and 审批权限.
- What is left of a document makes a topic when it holds five statements or more:
  差旅费管理办法, 新人入职指南, IT 设备申领说明 and so on.
- 报销 and 费用报销管理规定 form the area 报销相关.
- 17 of the 87 governed statements stay unfiled, those of the small documents
  (会议室管理规定, 薪酬管理办法, 数据分级与保护规范).
- The reference statements of a slot (the forwarded copy, the FAQ, the minutes) join the
  slot's topic.

## Owners and the inbox

The demo stands in for the business layer: each topic's owner is the member who wrote most
of its documents (front matter `owner`), so 9 of the 10 topics get one of two members. The
bench and `pnpm demo` assign them the same way (`assignOwners` in `apps/engine`). The inbox
then puts each todo in front of its topic's owner:
- the three conflicts (hotel cap, budget deadline, first-year leave) on their owners' cards
  for the week, within the weekly budget of 10 cards.

Over the next sixty days the three process documents come due for review and join their
owners' cards.

The hotel cap and the first-year leave land with 张敏: the notice that raises the hotel cap
sits in 团队知识/通知 and is placed in the 新人入职指南 topic, which 张敏 owns. The budget
deadline lands with 李娜, who owns the budget note's topic. In the demo, 张敏 confirms 5 days of
first-year leave; the onboarding guide's 7 days then reads as outdated in the guide, on the
年休假 topic page and in answers.

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
| 2027 budget deadline | Budget note: 11-15. Meeting minutes (reference): moved to 11-20. | The note is stale. The engine proposes 11-20 and asks the note's owner to update it, since only a reference document records the decision. |
| Meal allowance | 2026 policy: 100 元 a day. Archive: 80 元. | Superseded by the newer version. |
