# The MVP: a usable product that closes the business flow

Status: proposed, 2026-11-04. It follows the product owner's decision of 2026-11-04 to accept the validation's result, keep the 10-point aim for later, and build a usable prototype next ([Validating the knowledge core](validation.md#where-we-stand)). It cuts the [business layer](business-layer.md)'s phase 1 and the remaining engine stages ([overview](../overview.md#24-next-steps-and-effort)) down to one company's full loop. A Chinese copy is in [docs/zh/design/mvp.md](../zh/design/mvp.md).

## Conclusions

- **The MVP is one company's whole loop, on real sign-in and the company's own documents.** A person signs in, creates a company and invites colleagues. Documents are uploaded into spaces. Anyone asks in English, Chinese or Japanese and gets a cited answer that is fast and cheap. Owners see a short inbox, because "Decide for me" settles the routine reviews and conflicts. Uploading a changed document changes the answer. An agent reads the same knowledge through MCP, with the member's rights and no more.
- **Today's evidence measures three of the six advantages and estimates a fourth; the MVP builds the fixes for the other two.** Measured on our test corpora: answers more right than a mature RAG, though on the same corpus the governance fix was designed on; no flagship model and no thinking; much smaller and cheaper answers. Estimated, not measured: that reading repays its model cost on a read-heavy topic, at today's saving per answer and a given traffic and rate of change; people's time on todos is not in that figure. Not yet shown: that governance takes little of people's time (33 todos per 100 documents, with nothing settled for them), and that a whole answer is fast (search takes 11 seconds on our CPU-only machine). The MVP builds "Decide for me" and a faster search, then measures both on real use ([What the MVP must show](#what-the-mvp-must-show)).
- **About 16 person-weeks in six slices, with a first usable cut after three of them** ([Slices](#slices)). Left out: My space and publishing, joint approval, email and chat-app notifications, live Feishu and other connections, research, views, the code graph and billing ([Scope](#scope)).
- **Five decisions are the product owner's:** who tries it first, where it runs, whether live Feishu sync is in, the trial's model budget, and whether owners are offered a standing "Decide for me" on their first visit. Each has a recommended default ([Decisions for the product owner](#decisions-for-the-product-owner)).

## What the MVP must show

The product owner's test, 2026-11-04: the qualitative direction must be right, and the numbers may lag. A lead under 10 points, or a 40% cost cut where 60% was hoped for, is acceptable. Governance costing far more than expected while answers save far less is not. The evidence is from [the validation](validation.md#where-we-stand), on `deepseek-flash` with thinking off.

| Advantage | Evidence today | What the MVP does | Measured in the trial |
| --- | --- | --- | --- |
| Answers more right than a mature RAG | 248 against 234 of 276 after the governance fix, measured on the corpus the fix was designed on: +5.1 points (95% interval +1.1 to +9.4), +6.9 on changed or conflicting facts. The compact answer: 242 | Answers from governed knowledge, as tested | Wrong answers reported by people, with their reason; with consent, kept as cases for the larger dataset |
| No flagship model, no thinking | Every result above on a cheap model with thinking off; on GPT-6 Luna, at US$0.10 per million input tokens, Inspiration and the mature RAG tied on the drive (134 each) | One cheap model for reading and answering, thinking off | The model and settings behind each answer |
| Smaller input, cheaper answers | Per answer: the mature RAG 8,954 tokens and CNY 0.0083; Inspiration 5,024 and CNY 0.0050 (40% less); compact 1,961 and CNY 0.0012 (86% less) | The compact answer by default, the standard one on request | Model cost per answer, against the mature RAG's input for the same question, counted offline at no model cost |
| Reading repays its model cost | **Estimated.** About CNY 6.6 per million document tokens (measured); at today's saving per answer, repaid by what about 260 compact answers save on a topic the size of the drive, 1,000 on the decisive test's two topics. The model cost only: people's time on todos and continuing changes are not counted | New uploads are read on use; a folder is read in full once it is governed or asked often | Reading cost per document and per company a month, against what that company's answers save |
| Governance takes little of people's time | **Not shown.** 60 todos for 183 documents, 33 per 100, none settled, since "Decide for me" is not built; one ask a person settles costs what about 1,260 compact answers save (modeled) | "Decide for me" settles what it may, leaves the rest with reasons, and every decision can be undone | Todos per 100 documents raised, settled for people and left to them; minutes per ask |
| A fast whole answer | **Narrow.** The answering model: compact 1.40 s against the mature RAG's 1.73 s; the whole answer without search 3.06 s against 3.27, and long context 13.1 s. Search takes a median 11.4 s on our CPU-only machine, 9.1 of it the reranker | A reranker off the CPU, or a shallower one, chosen with the free search-only check | Whole-answer time, search included, median and p90 |

## The flow

1. **Sign in and create a company.** The first person is its super admin. A sample company, the demo's 恒远机械 corpus, opens for anyone who wants to look around before uploading.
2. **Spaces and owners.** The super admin creates spaces and names their owners; each space owner sets who reads it, top down. Source permissions are not inherited, as decided.
3. **Invite.** A link joins a colleague to the company as a member.
4. **Upload.** Files or a folder go into a space: Markdown, text, HTML and CSV as today, plus Word, PowerPoint, Excel and PDF. The Documents tree shows them at once in their own shape; reading runs in the background, with progress and a company day budget. New uploads start as Reference (宽松) and are read on use; the space owner marks the folders that hold policy as governed (严格), or accepts the suggestion once a folder is asked often.
5. **Ask.** A member asks in any of the three languages and gets a cited answer from the compact sources; a citation opens the line it rests on.
6. **The inbox (待办).** "Decide for me" settles what it may, with a reason for each; the owner sees what is left, plus a sample of what was settled, and can undo any of it.
7. **A document changes.** Uploading a new version re-reads only the changed blocks. A value it changes holds or asks its owner, by the rules already built, and the next answer follows.
8. **An agent.** A member creates a token under Apps with access (使用知识的应用). An MCP client searches, asks and reads with that member's rights; on its own it only reads.
9. **Usage.** The super admin sees answers, model cost, answer time and todos per 100 documents, per member and space, never content.

## Scope

**In:** sign-in with Logto, companies, members, spaces and their audiences, three product roles; uploads of files and folders, with new versions; the parsing worker; reading on a real model with budgets; the Documents tree, topic pages and the inbox, as in the demo; "Decide for me"; cited answers in three languages; the agent API over MCP with personal tokens; one deployed server; usage and feedback.

**Out, for now:**

| Left out | Why it can wait |
| --- | --- |
| My space and publishing | The trial runs in shared spaces, audiences set top down. The two-domain rule stays the design; My space comes with the pilot |
| Joint approval, deadlines and fallback deciders | One decider per todo is enough for a small team |
| Email and chat-app notifications | The inbox count in the web app does |
| Live Feishu and other connections, the credential broker | A changed document is uploaded again; see decision 3 |
| SSO, SCIM, directory sync, verified domains | Invites by link |
| OAuth for agents | Personal tokens; OAuth when a third-party client needs it |
| Research, views and the sandbox, the code graph, Trace view, the personal library | Not in the loop being tested |
| Billing, plans and seats | The trial's budget is set by hand |
| Phone layout | Desktop first, as in the demo |
| Validation runs | Paused until the product owner resumes the line ([validation](validation.md#where-we-stand)) |

## Slices

Each slice lands through pull requests as usual. The estimates are on the [overview](../overview.md#24-next-steps-and-effort)'s basis; agents built the first engine stages in days, so calendar time depends more on review and integration than on these figures.

| Slice | What it builds | Person-weeks |
| --- | --- | --- |
| 1. Identity and companies | Engine: verifying the business layer's principal token, provisioning of tenants, members and spaces, and space audiences in access-control in place of source ACLs (the tenant domain of the two-domain rule). Business layer: accounts on Logto (email and password, invites by link), tenancy with the three roles, and the admin of spaces, owners and audiences. Web app: sign-in, members and spaces, the browser reaching the engine only through the business backend | 5 |
| 2. Documents in | Uploads of files and folders, and new versions, into a space; the parsing worker for Word, PowerPoint, Excel and PDF behind normalization's parser contract; reading on the real model with a company day budget and progress; the sample company | 3 |
| 3. Fast cited answers | The compact answer by default; a reranker off the CPU or a shallower one; a stable tie-break in search, so a question gets the same sources each time; disputed values marked in what an answer reads, so it says that sources differ; cost and time recorded for every answer | 1.5 |
| **Gate A, first usable** | Sign in, create a company, upload your own files, ask in any of the three languages, get a cited answer; open the sample company | |
| 4. Governance that asks little | "Decide for me" on inbox piles and on each card, with reasons and undo; reading by demand (a folder in full once governed or asked often) | 2.5 |
| 5. Agents | The agent API: an MCP server with search, ask and read, acting as the member; personal tokens under Apps with access, with revocation | 2 |
| **Gate B, the flow closed** | A colleague invited by link reads only their spaces; the owner's inbox shows what "Decide for me" left, with reasons and undo; a new version changes the answer; an MCP client sees only what its member may read | |
| 6. Trial | The server, Docker Compose as in `infra/`, TLS, backups and logs; the usage page and a feedback button; the gate scripts | 2 |
| **Gate C, the trial** | Three to five people outside the team use it for two weeks with their own documents; the usage page reports the measures above | |
| **Total** | | **about 16** |

Each gate is a script that runs the flow end to end against the real engine and business layer, as the business layer's integration gates do, and runs in CI where the stack allows. Who builds what is for the coordinator to assign; a natural split is the engine thread for the engine side of every slice, the demo thread for the web app, which grows from the demo, and a business thread for accounts, tenancy and admin.

## Decisions for the product owner

1. **Who tries it first, in which language.** Recommended: three to five people on one team the product owner knows, in Chinese, with their own documents that are not confidential, for two weeks.
2. **Where it runs.** Recommended: one cloud server in Hong Kong or Singapore, where a public site needs no ICP filing and DeepSeek is reachable; about 8 vCPU and 32 GB, plus a small GPU or a hosted reranker for search; a domain the product owner owns. Mainland China later, with the filing.
3. **Live Feishu sync.** Recommended: not in the first cut; a changed document is uploaded again. Feishu right after Gate B, for about 2 more person-weeks: the credential broker and the live connector on the existing Feishu client.
4. **The trial's model budget.** Recommended: CNY 100 a month in all, with a day budget per company. A company with 500 documents of about 3,000 tokens costs about CNY 10 to read and, at twice the off-peak price, about CNY 5 for 2,000 compact answers. DeepSeek is cleared for internal content only, so confidential documents stay out of the trial.
5. **A standing "Decide for me".** Recommended: on an owner's first inbox visit, offer "Always decide routine reviews and conflicts for me", preselected, accepted with one press and pausable at any time. It is a request made in advance, the case open question 9 of the overview asks about ([Decide for me](decide-for-me.md)); without it, owners would face the 33 todos per 100 documents the validation measured.

## Risks

| Risk | Mitigation |
| --- | --- |
| People's time on governance stays high | "Decide for me" by default, reading by demand, and todos per 100 documents on the usage page from day one |
| Office files and scans read badly | The parsing worker reports what it could not read; a document that failed stays search-only and says so |
| Search stays slow | Slice 3 picks the reranker with the free search-only check before the trial |
| Sensitive content reaches a model provider | Sensitivity labels on every call, as built; the trial's documents are not confidential |
| A member reads what they may not | Space audiences replace source ACLs in slice 1, with the permission tests on both backends; the red-team set before a pilot |
| The scope grows | Only what this plan lists is built (AGENTS.md, "Keeping the code simple"); anything else waits for the product owner |

## After the MVP

The [pilot](../overview.md#8-releases-scope-and-success-measures) with a design partner, live Feishu, My space and publishing, and joint approval. Once the engine's shape is stable, the validation line resumes on a larger dataset close to real use, aiming at the 10 points as a long-term goal inside the engine; the trial's wrong answers, kept with consent, can start that dataset.
