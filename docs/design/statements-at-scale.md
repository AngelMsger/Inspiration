# Statements at scale: structure and review load

Status: adopted design, 2026-10-24. The measurements come from the mocked prototype of pull requests #8, #9 and #10, merged on 2026-10-26. Companion document: [UI principles](ui-principles.md). A Chinese copy is in [docs/zh/design/statements-at-scale.md](../zh/design/statements-at-scale.md).

## The problem

The engine turns sources into statements. A statement is one fact, with its status, its owner, the date it takes effect and the passages it was taken from. Extraction produces a great many of them: extracting every passage of every source in a synthetic company of 10,000 documents yields about 137,800 statements. As one flat list per space, that volume can be neither browsed nor maintained, and if every statement carried its own review, the people who keep knowledge current would drown in work.

The design has three parts:

1. **Every statement has a home in two outlines**, and statements about the same fact share one **fact slot**.
2. **Not every source is governed.** Each source or folder has a governance level.
3. **People review groups, not statements.** Work is grouped per owner, topic and week, under a weekly budget.

Together they make an owner's work grow with topics and source changes rather than with the number of statements.

## Terms

| Term | Meaning | Contract |
| --- | --- | --- |
| Company | The shared area of a business or a team, for example Hengyuan Machinery | Tenant |
| Space | An area of a company, such as Finance or Procurement. Its owner and the super admin set who can read it | Space |
| Member | A person in a company | Principal |
| Source | A document as written in its own app: a Feishu wiki page, a spreadsheet, an upload. It is kept as is | Source, SourceRef |
| Passage | A span of a source that the engine cuts out. Every later layer points back to passages | Span |
| Statement | The smallest governed unit: one fact with its status, owner, effective date and passages | Claim |
| Topic | A node of a space's knowledge outline, at most three levels deep (area, topic, subtopic) | TaxonomyNode |
| Knowledge page, procedure, card | The forms readers see. They are written from statements; a card describes one thing, such as a city, a supplier or a role | PageSpec, Sop |
| Topic owner | The member who answers for a topic's statements: confirms where they belong, reviews them and decides conflicts. Never a bare "owner" in the UI | TaxonomyNode.owner_id |
| Space owner | The owner of a whole space, who takes over topics without an owner | Space role `owner` |
| Todo | A piece of work for a person, shown on a card in the inbox | Todo |

## Part 1: two outlines and the fact slot

A statement always sits in two outlines at once, and people browse it through one of them, never as a flat list.

- **Source outline: where it came from.** Source, document, section, paragraph. A statement inherits the section of the passage it cites. This needs no model call: every block of a normalized source carries its heading path, and blocks keep stable IDs across versions. A long paper shows as its own table of contents, with its statements folded under each section.
- **Knowledge outline: where it is used.** Space, topic, page, page section, sentence. A placement record (`Placement`) stores the topic a statement sits in and, when a page cites it, the page block. A placement is made by clustering, by a page that cites the statement, or by a member. Once an owner confirms it, re-clustering never moves it.
- **Fact slot: what it is about.** Statements with the same slot key (`Claim.slot_key`: subject, predicate and qualifiers, normalized) state the same fact. A slot holds every variant by source and every version over time, so ten statements from three documents and four versions are one row to maintain, and a conflict lives inside one slot. Numbers, dates, limits and named owners fit slots well. Free-text rules often do not, and they stay grouped by page section.

Example from the demo corpus: the slot "Shenzhen · hotel cap per night · manager and below" holds 600 yuan from version 6 of the travel policy (disputed), 650 yuan from the price list (fresh) and 550 yuan from version 5 of the policy (superseded). The knowledge page, the procedure and the Shenzhen card that use the slot all read the same value.

Topics come from clustering. A topic made by clustering is proposed until its owner confirms it, and readers never see a proposed topic. Topic keys stay stable across re-clustering and are never reused. A statement from a governed document that has no topic yet is **unfiled**: it shows under its source section, with a suggested topic and a closeness score, until an owner files it.

## Part 2: governance levels

Most of what a company imports is reference material. Governing it statement by statement is where the volume comes from, so the governance level (`GovernanceLevel`) is set per source, and folders inherit it down the Sources tree.

| Level | Typical sources | What is extracted | Owner, review, conflicts | What readers see |
| --- | --- | --- | --- | --- |
| Governed (`governed`) | Policies, price lists, SOPs, approval flows, official specifications | Rules, facts, metrics, definitions, procedure steps | Topic owner, review clock, conflict todos | Knowledge pages, procedures, cards |
| Reference (`reference`) | Papers, articles, research reports, meeting minutes, vendor documents | Only on use: when a page cites a passage, an answer uses it, or it touches a known fact slot | No owner and no review. A value that differs from a governed one becomes a note to that owner, never a conflict todo | Original and Annotated views; citations in answers are marked Reference |
| Search only (`search_only`) | Chats, drafts, personal notes, large archives | Nothing. Passages are indexed for search and answers | None | Sources tree and search |

- **Defaults.** Uploads and web pages start as Reference. The super admin picks the level of each connected source, such as a Feishu wiki space, when connecting it. The space owner can change the level of any folder in the Sources tree.
- **Promotion is one action.** When an owner adopts a reference statement into a page, the statement becomes governed and gets a fact slot and an owner.
- **Statement type matters too.** Opinions, conclusions, assumptions and plans never get review todos of their own, even in a governed source. They follow the page that uses them.
- **A reference document still reads well.** Its Original view, its outline and cited answers all work without a single governed statement.

## Part 3: grouped review

A person sees work in the units they think in: a document that changed, a topic that is due, a value in dispute. Never one row per statement.

- **Who gets it.** A todo goes to the owner of the topic its statements are placed in, or to the nearest owner up the topic tree. Topics with no owner go to the space owner.
- **One card per owner, topic and week.** Todos for one owner about one topic in one ISO week share an inbox card (`Todo.batch_key`, with `taxonomy_key`, `slot_key` and `week`). A card holds at most 20 todos, ordered by priority and then by age, with a conflict before the reviews that depend on it.
- **A weekly budget.** An owner gets at most 10 cards a week. When a week is full, further cards move to later weeks; high and urgent work never moves.
- **A source that changes its own value asks nothing.** New wording, renumbered clauses and a changed value in the same source sync silently, and the old value stays in the history. A person is asked only when they had corrected or decided that value, or when sources disagree.
- **Copies ride with their conflict.** Documents that repeat a disputed value are reviewed inside that slot's conflict todo ("used in 5 places, all update together after the decision"), not as separate items.
- **Notes stay out of the budget.** When only reference documents state a different value, the owner gets a note (`TodoKind` `note`) on a weekly notes card. A note asks for no decision and is acknowledged in one action; its title and detail name the reference document, its date, the slot and both values.
- **Work withdraws itself.** A conflict or a note whose reason goes away, for example because the reference document was corrected, is withdrawn without anyone acting.
- **Day one is a campaign.** Reviews that are already due when a company first connects its sources go to first-review campaign cards per space and topic, at most 20 todos each, for the space owner to work through in compact mode. Owners' inboxes start at the normal weekly pace.

What readers see of all this is deliberately little. Fresh and aging knowledge shows nothing. Stale and at-risk statements show Review due only in the citation popover and the Trace view. The only marks inline in text are Outdated and Disputed.

## What owners see

- **The inbox** holds a handful of cards a week: a review card per topic that is due, a conflict card with its copy reviews, the notes card and, for space owners, campaign cards.
- **The topic overview** in the Trace view is designed for a topic of about 1,000 statements and never lists them one by one. It shows the fact slots first, one row each with their variants and status; then the pages, procedures and cards that use them; then everything else folded by source document, with counts only; then unfiled statements with their suggested topic. The engine serves it as one read.
- **The page-level Trace view** groups a page's statements by page section, because a page cites 5 to 30 statements.

## Measured on the prototype

The setup is a synthetic company of 10,000 documents: 1,366 governed (14%), 5,530 reference and 3,104 search only. The model is a deterministic mock and the embeddings are fake, so the numbers measure volume, not quality.

**Ingest.** Sync takes 71 s and normalization 240 s, producing 161,000 blocks and 205,000 passages. A typical document has 16 blocks (p90 22). Block IDs stay stable across versions, and every new version comes with a diff. Editions of one policy match at 0.83 to 0.93 similarity, enough to chain versions into one slot history.

**Extraction and governance** (pull request #8):

| Measure | Value |
| --- | --- |
| Statements extracted | 39,900 (137,800 if every source were governed) |
| After merging duplicates | 17,500 |
| Statements in a fact slot | 59% |
| Model calls | 5,635 (10,001 if every source were governed) |
| Documents with a review clock | 1,283 |
| Reviews falling due per week, median / max | 11 / 91 |
| Conflict todos | 30 (28 normal, 2 high priority) |

Reference documents yield a median of one statement each, only where they touch a known fact slot. The first citation of a reference passage adds about one statement. That takes 13 ms in the mock and longer with a real model, so the citation popover shows the passage at once and never waits for extraction.

**Topics** (pull request #9): 41 topics, at most three levels deep. Statements per topic: median 1,143, p90 2,375, max 6,206. Distinct statements per topic, a fact slot counted once: median 540. Fact slots per topic: median 1, max 30. No statement changed topic on a second run or after a round of edits (0 of 25,660). On the hand-written demo corpus, 20% of governed statements stay unfiled, all from three small documents.

**Grouped review** (pull request #10), over one simulated year with 15 owners:

| Measure | Value |
| --- | --- |
| Review cards | 606 |
| Cards per owner per week, median / max | 1 / 4 |
| Todos per owner per week, median / p90 / max | 2 / 5 / 26 |
| Day-one reviews | 605, on 44 campaign cards |

The weekly budget never had to move a card. The maximum of 26 todos falls in the first week, when 30 conflicts arrive together, so one owner's first week can hold two full cards for one topic. No notes survive at 10,000 documents, because governed guides later state every value that reference documents mention; the demo corpus keeps one.

## Decisions

All adopted on 2026-10-24:

- The three parts above: two outlines with fact slots, governance levels, grouped review.
- Uploads and web pages start as Reference; the super admin picks the level of each connected source.
- The weekly budget is 10 cards per owner, each holding up to 20 todos, to be tuned on later volume reports.
- A reference source never blocks a governed statement. It raises a note, outside the budget.
- The design builds on the knowledge views: Original, Annotated and Knowledge views of a source, and the Sources and Knowledge trees.

## Still open

- **Topic splits need real embeddings.** The synthetic company restates the same 30 subjects across many department guides, and fake embeddings cannot tell those sections apart, so topics grow with the corpus instead of splitting. Automatic splits can be judged only with real embeddings.
- **Ranking by use and risk.** The design ranks todos by how much a statement is used (cited by pages, procedures or cards, or used in recent answers), by risk class (pricing, policy) and by extraction confidence. The prototype ranks by priority and age today.
- **Load with real owners.** The synthetic owners are assigned at random, so per-owner load needs a real company to confirm.
- **Fact slots across languages.** The same fact stated in a Chinese policy and a Japanese memo should share one slot. Today a slot key keeps its qualifiers in the words of the source, so the normalization has to become language-independent. See Internationalisation in the [UI principles](ui-principles.md).
