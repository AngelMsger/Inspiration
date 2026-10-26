# Coding agent over a clone: questions, right answers and the agent's answers

Run on 2026-10-26, about 17:15 to 17:20 UTC. Each question went to a fresh general-purpose coding agent on a frontier-class model, with:

- a clean clone of this repository's `main` at 4d5ea00 (before the code-repositories design was added), with its full git history;
- read-only access to the discussions of pull requests #1 to #20 through the GitHub tools;
- no access to anything else, and no hint that documents and code might disagree, except in question 4.

The right answers were written down before any run, from the code, the documents and the pull request discussions. Scores: 2 = correct and complete on the key points, with citations; 1 = partly correct; 0 = wrong. Tokens, tool calls and seconds are as the agent runtime reported them for each run.

| Question | Score | Disagreement raised without being asked | Tokens | Tool calls | Seconds |
| --- | --- | --- | --- | --- | --- |
| 1. Card size and overflow | 2 | No | 80,954 | 19 | 81 |
| 2. Is the weekly budget a hard cap? | 2 | Yes | 79,512 | 18 | 94 |
| 3. Why a soft limit, and when decided? | 2 | No | 73,269 | 17 | 71 |
| 4. Do the documents describe the budget correctly? | 2 | (asked) | 100,783 | 15 | 125 |
| 5. How fast are changes and deletions noticed? | 2 | Yes | 101,488 | 21 | 141 |
| 6. Default review intervals | 2 | Not applicable | 55,751 | 5 | 28 |
| 7. Default governance level of an upload | 2 | Not applicable | 71,606 | 13 | 67 |
| 8. When and why the packages moved | 2 | Not applicable | 66,045 | 14 | 60 |
| **Median** | | | **76,391** | **16** | **76** |

## 1. How many todos fit on one inbox card, and what happens when a card is full?

**Right answer.** At most 20 (`INBOX_DEFAULTS.cardSize` in `engine/collaboration/src/inbox.ts`). When full, the next todo goes on a continuation part of the card (`<card>:2`), in the same week if the owner has fewer than 10 cards that week, otherwise the first later week with room, up to 26 weeks. Copy reviews, campaign and steward cards also use continuation parts.

**Agent's answer.**

> A card holds at most 20 todos. A card collects one owner's todos about one topic for one week. When it is full, the next todo doesn't push anything off. It starts a continuation card for the same owner, topic and week, which you can think of as "Hotel policy, week 43, part 2", then part 3, and so on.
>
> The continuation card is a real second card, so it counts toward the owner's weekly limit of 10 cards. If that week already has 10 cards, the todo moves to the next week that has room, up to 26 weeks ahead. If no week in that range has room, it stays in its original week anyway, over the limit. Urgent and high-priority todos always stay in their week.
>
> A few exceptions: copy reviews stay with their conflict, on its card or a continuation of it, even over the weekly limit. Day-one campaign cards and cards for topics with no owner also cap at 20 and continue onto part 2, but don't count toward anyone's weekly limit. Notes cards: the code puts no 20-item cap on these, and they sit outside the weekly limit.

Cited `inbox.ts:24-31`, `:447-448`, `:462-481`, `:484-509`, `index.ts:18-34`, `collab.yaml:288-292`, `inbox.test.ts:243-276`, `:329-345`, `overview.md:400`, `statements-at-scale.md:65,120`, commit e224a5d, PR #10 comments 6395142043, 6395234967 and 6406652794. It found a rule the right answer had missed: notes cards have no 20-todo cap, which no document states.

## 2. Is "at most 10 cards per owner per week" a hard cap? What can go over it?

**Right answer.** A soft limit. High and urgent todos stay in their due week; a conflict and its copy reviews stay together in their week; when no week within 26 has room, the due week, over the budget; notes, campaign and steward cards are outside owners' budgets.

**Agent's answer.**

> No, it isn't a hard cap. It's a soft limit, and that was a deliberate choice. Only an owner's ordinary topic cards count toward the 10. When a week is full, new cards normally move to the next week that has room. Three things can still push a week past 10: urgent and high-priority items always stay in the week they're due; a conflict and the copy reviews it caused stay together in the conflict's week; if none of the next 26 weeks has room, the item goes back to its due week, over the budget. Some cards don't count at all: the weekly notes card, the day-one first-review campaign cards and the steward's cards for topics nobody owns. [...] In practice the limit has never been reached: the busiest owner-week in the simulated year had 4 cards.
>
> One thing to watch: the overview doc says only "except urgent ones", so it leaves out high-priority items and conflict groups.

Cited `index.ts:18-34`, `inbox.ts:24-31`, `:62-67`, `:447-458`, `:461-481`, `inbox.test.ts:240-279`, `:347-369`, `architecture.md:175-180`, `statements-at-scale.md`, `overview.md:458`, `:770`, commits e224a5d, 4f52a72, 8296fc7 and PR #10 comments 6406627458 and 6406652794.

## 3. Why is the weekly inbox budget a soft limit rather than a hard cap, and when was that decided?

**Right answer.** Decided on 2026-10-26 in PR #10's merge comment, answering the review's question of the same day: the conflict group is the unit of work; at 10,000 documents the budget never binds (at most 4 cards per owner and week); a hard cap would need a rule to defer whole groups, which the product owner would decide.

**Agent's answer.**

> Each person gets about 10 "cards" a week. Extra cards normally wait for a later week, so nobody gets flooded. But some work has to stay together. When a source document changes, it can open a conflict and also send review requests for copies of that document. The team chose to treat the conflict and its copy reviews as one piece of work. They stay in the conflict's week, even if that means an extra card that week. The alternative was splitting them up, or making up a rule that pushes the whole group to a later week. Urgent and high-priority to-dos already broke the limit the same way, from the start. The 10-card limit also never came into play in tests at scale: the busiest person got 4 cards a week.
>
> When: a reviewer raised it on PR #10, and the agent chose "soft limit" in its reply on 26 Oct 2026. It said the project owner could still ask for a hard cap. The docs and a test were added in PR #12, merged the same day.

Cited PR #10 comments 6406627458 and 6406652794, PR #12's description, commits 8296fc7 and e224a5d, `index.ts:18-29`, `architecture.md:175-178`, `inbox.test.ts:347-350`. The reason exists only in the pull request discussion, not in the clone.

## 4. Do the product documents describe the inbox's weekly card budget correctly? Point out any disagreement with the code, or a rule the documents leave out.

**Right answer.** The overview names "urgent ones" as the exception, while the code and Architecture say high and urgent; the overview's governance section leaves out that conflict groups go over the budget; the 26-week horizon is in no document.

**Agent's answer.**

> Mostly yes. The main numbers match the code: up to 20 todos per card, 10 cards per owner per week, and notes don't count toward the 10. But there are five places where the documents and the code don't line up:
>
> 1. High-priority todos also skip the wait. The overview says only "urgent" todos skip the queue. In the code, "high" todos skip it too. The architecture and "Statements at scale" documents get this right.
> 2. The 10 is a soft limit. The overview leaves out that a conflict and the copy reviews riding on it stay together in their week, even past 10 cards. The team decided this in PR #10, but only the architecture document says it.
> 3. There is a 26-week cutoff. No document mentions it.
> 4. Closed todos still use up room. Done or dismissed todos still count toward a card's 20 and the week's 10. So clearing an inbox on Monday frees no room that week. No document says this, and it may not be on purpose.
> 5. Some cards sit outside every budget. The notes card has no 20-todo cap. Campaign cards and steward cards have no assignee and count against nobody's budget. The documents say "the space owner" gets these cards.

Cited `overview.md:400`, `:458`, `:770`, `architecture.md:175-180`, `statements-at-scale.md:64,66,71`, `ui-principles.md:119`, `inbox.ts:24-31`, `:88`, `:437`, `:447-448`, `:451`, `:458`, `:462-466`, `:475-481`, `:505`, `index.ts:18-43`, `inbox.test.ts`, PR #10 comments and commits 4f52a72 and 039ee5f. Points 4 and 5 were not in the right answer; point 4 is a possible bug for the collaboration component to look at.

## 5. How quickly does Inspiration notice that a Feishu document changed, and how does it find documents that were deleted upstream?

**Right answer.** Designed: push events as hints, a 15-minute poll and a nightly full listing that finds deletions. In the code a sync lists the source, compares hashes and writes a tombstone for items gone from the listing; it runs when called or on `source.changed`. No timer or poll interval exists in the code, while the overview marks this requirement Built.

**Agent's answer.**

> The plan is that Feishu sends a notice when a document changes, a check every 15 minutes catches what the notices miss, and a full check every night catches the rest. The overview calls this "Built", but the timing is not in the code. Nothing runs the check on a schedule, nothing receives Feishu's notices, and the Feishu connection reads saved sample files, not a live account. What is built is the check itself: list every document, compare each one's fingerprint with the saved copy, and re-read only what differs. Today it runs only when someone runs the demo.
>
> Deleted documents are found by their absence. If a document seen last time is missing from a new full list, Inspiration adds a "deleted" version and keeps the earlier versions. [...] Designed but not built: if more than 10% of a source, or more than 50 documents, vanish at once, it pauses and asks an admin.
>
> The docs disagree with each other. The overview says only the nightly check finds deletions. The deletion design says the 15-minute check finds them too. In the code, any full check finds them.

Cited `overview.md:198`, `:348`, `:457`, `components.yaml:41`, `source-changes.md`, `source-sync/src/index.ts:6`, `sync.ts:168-223`, `:377-415`, `apps/engine/src/ingest.ts:171-172`, `connectors/src/feishu/api.ts:165-171`, `docx.ts:161-171`, `interfaces.ts:192-195`, `sync.test.ts`, commits 66c9cb3 and 506b79c, PR #3. It also ran a search for any timer or cron in `engine/`, `apps/` and `libs/` and found none.

## 6. By default, how often must a policy document be reviewed, and a process document?

**Right answer.** Policy every 365 days, process every 180 (`DEFAULT_INTERVALS` in `engine/freshness/src/rules.ts`); pricing and market 90; general none. The documents agree.

**Agent's answer.**

> By default, policy knowledge is reviewed once a year (every 365 days) and process knowledge every 180 days. Other defaults: product, org and technical knowledge also get 180 days, pricing and market knowledge get 90 days, and "general" knowledge never falls due because of age. The clock attaches to the type of knowledge, not to the document's label. [...] So a policy document that also states prices is due after 90 days, not 365. Plans don't count toward this. [...] These numbers are only defaults. Each company can set its own; nothing does that yet.

Cited `rules.ts:24-33`, `:5-9`, `freshness.ts:127-128`, `:167`, `overview.md:387`, commit e86729c.

## 7. When someone uploads a document, which governance level does it get by default?

**Right answer.** Reference: `DEFAULT_LEVEL = "reference"` in `engine/source-sync/src/sync.ts` applies when neither the item, its folder nor the source sets one; the documents agree.

**Agent's answer.**

> An uploaded document starts at Reference, the middle of the three governance levels (Governed, Reference, Search only). [...] Statements are pulled out of it only "on use". [...] When the system picks a level, the most specific setting wins: the document's own setting, then the source's setting, then Reference. Uploads and web pages usually set neither, so they end up as Reference. [...] One edge case: documents stored before levels existed have no level, and they count as Governed.

Cited `sync.ts:85-86`, `:309`, `source-sync/src/index.ts:16-17`, `source.yaml:66-71`, `:332-340`, `levels.ts:12-14`, `statements-at-scale.md`, `architecture.md:133-135`, `overview.md:350`, commit c11abdd and PR #8.

## 8. When and why were the code packages moved into the engine/ and libs/ folders?

**Right answer.** On 2026-10-26, commit aa2dc29, PR #15. The product owner decided that engine and business layer share one repository with a folder per layer; nothing in `engine/` or `libs/` may depend on `business/`, which the manifest test checks.

**Agent's answer.**

> The move happened on 26 October 2026. The code was moved in commit aa2dc29, and it was merged into main as pull request #15. [...] Why: the product owner decided that the engine and the business layer would share one repository. Each layer gets its own folder [...] Dependencies may point only one way: the engine and the libraries must never depend on business code, and a test fails if they do. [...] The move only renamed folders.

Cited commits aa2dc29, b87eac4 and d08cc27, the descriptions of PRs #14 and #15, `architecture.md:34-73`, `overview.md:589`, `:1080`.
