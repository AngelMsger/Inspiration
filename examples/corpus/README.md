# Demo corpus: 恒远机械

A small, hand-written tenant for the ingest prototype, the demo and design work: one
fictional machinery maker, 恒远机械, with 38 documents. The finance department's space holds
its policies (财务制度, 17 files), its team notes (财务团队: minutes, FAQs, a manual, a notice
and a weekly report), an archive folder, one Feishu wiki document and one Feishu approval
definition (its four instances are read with it). The company policies (公司制度, 7 files:
HR, administration, purchasing and information security) are a second space. Two small spaces
hold what only some may read: the budget note in 财务制度/预算/内部 (财务内部) and the payroll
policy in 公司制度/人事/薪酬 (人事薪酬). A Chinese copy
is in [README.zh.md](README.zh.md); if the two differ, this English version wins.

- `corpus.yaml` declares the tenant, its four spaces, its eight sources and the directory that
  maps source principals to engine principals.
- `vocabulary.yaml` is the tenant's predicate catalogue: the single-valued facts (hotel caps,
  deadlines, leave days, loan settlement ...) that extraction puts into slots, so governance
  can compare values across documents.
- `files.yaml` says when each file last changed, as the company drive would report it.
  `Corpus.stamp` gives each file that time on ingest and serve, so governance and freshness see
  the same ages on every checkout.
- `people.yaml` names nine members. The web app's stand-in backend signs in as the first and
  offers each one to act as; 赵琳 of IT, who wrote none of the documents, is the company's super
  admin, so the admin area has someone to show it. `script.yaml` is the demo in order (below).
- `updates/` holds the demo's upstream edit (below); no source reads it.

Run it through the engine with `pnpm bench ingest examples/corpus` (see `apps/bench`). With
the mocked extraction model it gives 183 claims, 60 of them in 16 slots, and finds the five
planted value conflicts below. Reference documents are read only where they name a catalogue
fact, so 11 of their claims outside any slot are left unused, and the weekly report is not
read at all.

## The story

Sales staff travel to Shenzhen often, and the hotels there cost about 650 yuan a night. The
travel policy (差旅报销管理办法, edition 6, from 2026-07-01, owned by 李娜) caps tier-1 cities
at 600. In October 王磊 wrote the Shenzhen hotel price list (深圳协议酒店价目表), a governed
document that sets 650 for Shenzhen; the October travel meeting noted the gap, and 李娜 said
600 holds until the policy is revised. The FAQ, the August and September minutes, the Feishu
FAQ and the copy forwarded to HR still say 600.

So when 陈晨 from Sales asks how much a night in Shenzhen may cost, the answer goes by the
price list's 650 and says the sources disagree. 李娜 decides in the inbox, and edition 7 of the
policy, which 李娜 revises, puts 650 in the policy itself.

## Governance

Two governed documents that disagree propose the newer one's value; the older one is only
superseded when it has gone unchanged for a year. A reference document never outvotes a
governed one, except with a dated change that is in effect.

| Slot | Statements | What governance does |
| --- | --- | --- |
| Tier-1 hotel cap | Travel policy 600 (changed 2026-06-20). Price list 650 (2026-10-18). October minutes 650 and 600. FAQ, Feishu FAQ, forwarded copy, August and September minutes 600. Archive 500. | Proposes 650 and asks 李娜, who owns the travel topic. Settles the archive's 500 alone. |
| 2027 budget deadline | Budget note 11-15 (confidential). September minutes, a reference document: moved to 11-20. | The minutes' dated change is in effect, so 11-20 holds; 周敏 is asked to update the note or reject the change. |
| Annual leave, 1 to 10 years | Attendance policy 5 days (from 2026-01-01). Onboarding guide 7 days (changed 2025-11-10). | Proposes 5 and asks 张敏. |
| Loan settlement | Loan policy 15 days. Loan FAQ 30 days. | The policy holds; 王磊 gets a note that the FAQ says otherwise. |
| Meal allowance | Policy, its forwarded copy and the Feishu FAQ 100 a day. Archive 80. | Settled alone: the archive is superseded. |

That is three todo requests, all high priority, and one note. Two cases are not conflicts:
the travel reimbursement deadline (30 days for travel, 60 for daily expenses) carries
different qualifiers, and the approval thresholds differ by scope (travel and loans 5000,
expenses 2000 and 20000), with the Feishu approval matching the travel policy.

## Governance levels

`governance_level` in front matter, `.meta.yaml` or the Feishu properties, else the source's
in `corpus.yaml`, says how far the engine governs a document:

- `governed` (28): the finance and company policies, the notice folder (财务团队/通知), the
  approval definition and the archive (governed, but archived). Extracted in full; their
  values decide a slot and their owners get reviews and todos.
- `reference` (9): the team's minutes, FAQs and manual, the Feishu wiki and the copy of the
  travel policy forwarded to HR. Read where a block names a catalogue fact, and only claims
  that fill a slot are kept.
- `search_only` (1): the weekly report. Searchable, never extracted.

Authority is separate and comes from the source defaults: policies 0.9, the Feishu approval
0.7, the Feishu wiki 0.6, the team notes 0.5, the archive 0.3.

## Topics, owners and the inbox

Page-compiler clusters the 69 sections of current governed documents into 16 topics and two
areas (报销相关 and 固定资产), using the fake embeddings, which only see shared characters.
Similar headings across documents make topics (住宿, 交通, 报销, 审批), and what is left of a
document makes one when it holds five statements or more. 44 of the 142 governed statements
stay unfiled, those of the small documents.

The demo stands in for the business layer: each topic's owner is the member who wrote most of
its governed documents (front matter `owner`), so 16 of the 18 topics get one of seven
members. The bench and `pnpm demo` assign them the same way (`assignOwners` in
`apps/engine`). The inbox puts the hotel cap on 李娜's card, the budget deadline on 周敏's and
the annual leave on 张敏's, and the loan note on 王磊's.

Freshness keeps review clocks for the 28 governed documents: policies yearly, processes every
180 days, the archive and four documents of general knowledge never by age. Two documents are
past their review date on the first day; over the next sixty days four more come due and one
rests on an assumption that has drifted.

## Space owners

周敏 owns the finance space and 张敏 the company policies (`owner` in `corpus.yaml`). The web
app offers a space owner a way to maintain the space: what is waiting in it, its topics and
their owners, its folders and the governance level each is read at. Todos of topics nobody
owns go on the space owner's steward card.

## The demo script and the upstream edit

`script.yaml` is the demo in order: each step names the person who takes it, the page it
opens and what to look at or do there, in each interface language. Two steps move the demo on
(`do`): 李娜 confirms 650 for tier-1 cities, and 周敏 puts in the upstream edit.

1. 陈晨 asks about the Shenzhen hotel: the answer gives 650 and says the sources disagree.
2. 陈晨 opens edition 6 of the policy in its Annotated view: the tier-1 row is disputed.
3. 李娜 confirms the suggestion in the inbox.
4. 陈晨 asks again: the FAQ's and minutes' 600 reads as outdated.
5. 周敏 looks over the finance space and puts in edition 7.
6. 陈晨 opens the policy again: the tier-1 row says 650 and is current.

`updates/travel-policy-revised` is the upstream edit: edition 7 of the travel policy, in
effect from 2026-11-01, with the tier-1 cap at 650. Putting it in copies its files over the
served copy of the corpus, dated 2026-11-04 as its `update.yaml` says, so a recording made on
another day reads the same, and syncs 财务制度 as 周敏. The policy's 600 row is superseded and its
tier-1 row holds 650, the hotel todo has nothing left to ask, and the space overview lists the
policy as updated. Answers still give 650 and mark the FAQ's and minutes' 600 as outdated; they
cite the price list, not yet the revised policy.

`pnpm snapshot` records the script: after reading everything each person can see, it takes the
next action and reads again, and builds a static page that answers from that recording. The
engine's day stands still while it records, so identical pages are stored once. The hotel
question is put in Chinese, English and Japanese, and the guide opens the one in the language
the page shows. With `--gateway config/gateway.demo.yaml --valkey <url>`, DeepSeek writes the
answers and translates the questions, while reading stays on the stand-ins, so the story above
holds exactly. The guide names the model the config prefers for answers and says that any
answer may still come from another model or a local stand-in: the gateway falls back on a
retryable error, and an answer from confidential content goes to a model cleared for it. In the
recording below, DeepSeek wrote every answer. The recording of 2026-11-04 made 12
DeepSeek calls for about CNY 0.03, off-peak. Its replies are kept in the project files
(demo/recording-2026-11-04/replies.jsonl): `pnpm bench cache import` puts them back, and
recording again then pays only for answers that changed.

## Permissions

A space's audience decides who reads its documents (`corpus.yaml`, `spaces`). The ACLs the
folders' `.acl.yaml` files and the Feishu fixtures carry are kept as each source reports them
and decide nothing.

- 财务部 (`财务制度`, `财务团队`, the archive and both Feishu sources) and 公司制度 are read by
  the whole tenant; 周敏 and 张敏 own them.
- 财务内部 holds `财务制度/预算/内部`, its budget note `confidential`. 周敏 owns it, and the
  finance department (李娜, 王磊, 高燕, 刘洋) reads it.
- 人事薪酬 holds `公司制度/人事/薪酬`, its payroll policy `confidential`. Only 张敏, its owner,
  reads it.
- A `confidential` document opens only for a reader cleared for it. `people.yaml` clears 周敏
  and 张敏; everyone else holds `internal`, so the finance department reads 财务内部 without
  its budget note.
- What the folders say: `财务制度` is edited by the finance group, `财务制度/预算/内部` is finance
  only, `公司制度` is edited by the administration office and `人事` adds HR editors,
  `人事/薪酬` is HR only, and the Feishu FAQ is shared with the finance department and
  readable by the tenant by link.

## Planted duplicate

| Document | Duplicate of | Kind |
| --- | --- | --- |
| 公司制度/人事/转发-差旅报销管理办法.md | 财务制度/差旅/差旅报销管理办法.md | exact (only front matter differs) |

The archived 2023 edition differs in too many numbers to count as a copy.
