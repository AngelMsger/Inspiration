# Inspiration UI: design philosophy

Status: adopted, 2026-11-05; the second version of the design canvas and the MVP web app follow it.

## Conclusions

- **Minimal on the surface, complete underneath.** Each screen shows what one person needs for the job in front of them, at the size that job really has, and everything else is one step away, in a panel, a link or ⌘K. Every screen passes three tests: whose one job it serves, how it looks with the real number of items, and what the assistant can say at the top so that the person need not read it.
- **One grammar, four places you can tell apart.** Every screen has the same top bar, left column, centre and right panel, but reading, managing a space, Admin and Account each look different at a glance, and every screen says where you are, where you came from and how to go elsewhere. What is used most sits closest.
- **Settings follow who answers for them:** you, a space owner, or the super admin, who decides who and how but never what knowledge says.
- **Every list is drawn at its real size:** up to 10 items are all shown, up to 100 are grouped or folded, and above that a search or a summary comes first.
- **The assistant is quiet:** an overview before every pile, its suggestion already selected, Decide for me on piles rather than on every item, a reason when it leaves a decision to a person, and Why and Undo on everything it did. It has no avatar, no colour and no chat sidebar.
- **The second version of the design canvas applies these rules** ([screens](screens/README.md)). Still open: the numbers on each overview's cards and some Japanese terms ([Still open](#still-open)).

## 1. The stance: a quiet surface over complete depth

Minimal or comprehensive? Minimal on the surface, complete underneath. Each screen shows what one person needs for the job in front of them, at the size that job really has. Everything else is one step away, in a panel, a link or the command palette (⌘K), and is not on the screen until someone asks for it. Nothing the product can do is hidden for good; it is only out of the way.

Every screen has to pass three tests:

1. **Who is it for, and what is their one job here?** A screen has one main action. Other actions go into a menu or ⌘K.
2. **What does it look like with the real number of items?** Section 6 gives the sizes. A list drawn with three rows that really holds three hundred is a wrong drawing.
3. **What does the assistant already know that the person would otherwise have to read?** Say it at the top, and let the person act on it with one press.

## 2. Five beliefs

1. **People come for their work, not for our model.** People know documents, answers and decisions. Statements, fact slots and lineage are how we keep those right. Screens speak in the first; the second stays in the Trace view for owners. This is why imported documents come first and readers never see the knowledge machinery.
2. **The assistant does the reading; people own the decisions.** The assistant reads everything, sums up the piles, fills in its suggestion and, when asked, decides. Every decision still belongs to a named person, who can see why and undo it.
3. **Attention is the scarcest thing we handle.** A screen that makes someone read forty rows to find the three that matter has failed. Summaries come before lists, groups before items, exceptions before routine.
4. **Everything has one place, where the person who answers for it looks.** Navigation follows where you are. Settings follow who is responsible for them. A setting lives in one place, and other places link to it.
5. **Trust is shown, not claimed.** Why, from where, by whom and since when are one step away on everything. Anything the assistant did can be undone.

## 3. One grammar, four places you can tell apart

Consistency is in the philosophy, not in identical screens. The product owner pointed out that when every screen looks the same, people cannot tell where they are, and that reading something and managing it must not feel alike. So every screen uses the same grammar (a top bar, a left column, the centre and a right panel), but the four areas look different at a glance, and every screen answers three questions: where am I, where did I come from, and how do I get somewhere else.

| Region | Answers | Holds | Never holds |
| --- | --- | --- | --- |
| Top bar | Find anything. Who am I, and in which company? | The current company's name as plain text, search and ask (⌘K), the account menu, which also switches companies and opens the personal library | Spaces, page titles, filters, or the screen's own actions |
| Left column | Which area am I in, and what is here? | The navigation of the area you are in, under a header that names the area and the way back | Actions on the selected item, or a list's filters |
| Centre | The thing itself, and where it sits | Breadcrumbs that start at the area, then one document, page, list or decision | |
| Right panel | What about the selected thing? | A title that names the selection, then what fits its kind (see below) | Navigation |
| Command palette | Everything, by name | Every place and action, with its shortcut and CLI command | |

The left column shows one of four areas, and each one looks like itself:

| Area | For | Entered from | How it looks | Its left column |
| --- | --- | --- | --- | --- |
| Knowledge, the default | Everyone | Signing in, Home | The paper ground. Folds away while reading | Home, Inbox, My space, then each space the person can read, with its Documents and Knowledge |
| Managing a space | That space's owners | "Manage" on the space, or a card in the inbox | A blue-tinted column under an indigo header: "Managing a space · Finance", "← Back to reading" | Overview, Work (reviews, conflicts, publish requests, batch changes), Topics and owners, Documents and governance levels, Readers, Rules, Settings |
| Admin | The super admin | The account menu | A dark column under the header "Admin · the company", "← Back to knowledge" | Grouped by concern, as in section 5 |
| Account | Everyone | The account menu | The paper ground under the header "Account and settings", with Done | You (profile and language, sign-in, companies, notifications), then the current company (your source connections, apps with access, Always decide for me, your usage) |

Reading stays on paper with nothing tinted, so a glance tells reading from managing.

### Where am I, where did I come from, how do I go elsewhere

- **Where am I.** The area: the left column's colour and its header. The place: breadcrumbs at the top of the centre that start at the area, such as "Managing a space › Finance › Batch changes › Version 4". The item: the selection in the left column and the page title.
- **Where did I come from.** When a link crosses areas or leaves a page for its source, the breadcrumbs start with a way back, such as "← Back to Travel expense rules". The area header's "← Back to reading" returns to where you left. The browser's Back always works, because every state has its own address.
- **How do I go elsewhere.** Reading and managing link to each other: Manage next to a space, and "Read this area" in a managing inspector. ⌘K reaches any place, including "Switch to…". The account menu leads to Account and Admin.

### The right panel follows the selection

One rule everywhere: the right panel always has a title that names what it is about, and it is only about the selected thing. What it holds depends on the kind of thing:

| In the centre | The panel's title | What it holds |
| --- | --- | --- |
| An original document | The selected passage | Comments, proposing a revision, the knowledge that uses it (V2-doc) |
| A knowledge page | This page | The page's outline, what is in progress on this page, related pages, sources (V2-page) |
| A decision in the inbox | About this conflict | Both sides' passages, the votes, what happens once it is decided (V2-decision) |
| A list in a managed space | Inspector · the selected area | Its owner, this week's work, who reads it, a link to read it (V2-space) |
| A list in Admin | Inspector · the selected connection | Authorisation, where it is used, what happens when it expires (V2-sources) |
| Nothing selected | No panel | The centre takes the width |

A revision to an original document never changes it in place: the document lives in its source, so a revision goes to its author as a suggestion and comes back with the next sync.

Rules:

- **The top bar never changes,** in Admin and Account included. It never switches spaces. Companies and the personal library are switched from the account menu.
- **The left column has at most two levels of headings.** Trees, such as Documents and Knowledge, can go deeper, but open one branch at a time.
- **A screen's filters and views sit above its content,** never in the left column. The inbox's kinds are a menu above the list, and its metric cards also filter it.
- **Reading folds the left column away** to give the text room. Breadcrumbs above the text say where you are and, after a jump, where you came from; they never replace the left column.
- **Compact is a density setting** (⌘.), not a place. It never changes what the navigation holds.

### Placed by how often it is used

The prime places go to what people do most. The product owner put it this way after seeing a company switcher in the top bar's most visible spot, although most people belong to one company and seldom switch. The more often something is used, the closer it sits: daily things in the middle of the top bar and the top of the left column, weekly things in the left column, monthly things in a menu or at the end of a list, and anything rarer in settings or only in ⌘K.

| Element | Who uses it | How often | Where it goes |
| --- | --- | --- | --- |
| Search and ask | Everyone | Several times a day | The middle of the top bar, ⌘K |
| Reading a page or document | Everyone | Daily | The centre, with the left column folded |
| The spaces you read | Members | Daily to weekly | The left column, the ones you use first |
| Inbox | Owners daily; most members 0 to 2 todos a month | Daily to monthly | Second in the left column, with a count when something waits |
| Managing a space | Space and topic owners (6 in the Finance story) | Daily to weekly | Manage, next to the space |
| My space | Members who draft and publish | Weekly | The left column |
| Switching company, opening the personal library | Most people never (one company); a few weekly | Rarely | The top of the account menu, and ⌘K "Switch to…". The top bar only names the current company, as plain text |
| All spaces | Members | Monthly | The last line of the spaces |
| Admin | The one super admin | Weekly | The account menu, shown only to them |
| Always decide for me | Owners | Set once, looked at now and then | Turned on from a one-line question under a decision in the inbox; seen and paused in Account, under the company, which the inbox's "Decided for you" line links to |
| Compact | Owners | Set once | A switch in the account menu, ⌘. |
| Profile, language, sign-in | Everyone | A few times a year | Account |

The same test applies to every new element: who uses it, how often, and does its place match that.

## 4. Two speeds: reading and working

The same structure serves two very different uses, and only the density changes:

- **Reading** is calm. A page or document fills the centre, the left column folds away, and only the Outdated and Disputed marks show in the text. Most members only ever read.
- **Working** is dense. Owners and the super admin clear queues, so compact mode shows tables, keyboard shortcuts and an inspector on the right. A queue is still introduced by its overview (section 7).

### In reserve: key phrases in bold

Not scheduled. The product owner proposed it on 2026-11-04: set the phrases that carry a paragraph's point in bold, so a reader can skim the paragraph and still get what it says. V2-skim on the canvas draws this recommendation.

- **Where.** Knowledge pages, procedures, the text on cards, and answers, on by default. Never in the Original view, which shows a document as its author wrote it; the author's own bold stays as it is. In the Annotated view, only the value inside each quote. A card's value is already prominent and gets no more.
- **What is bold.** What the reader is looking for: the value of a fact (an amount, a limit, a period, a date) and the condition that changes it (a city, a grade). At most one phrase in a sentence, never a whole sentence, and no more than about a tenth of a paragraph's characters.
- **Who picks.** Knowledge first: when a sentence states a statement, that statement's value and condition are bold, so every language emphasises the same fact. The same model call that writes the page marks the rest; there is no extra call. Neither readers nor owners mark phrases by hand.
- **Next to the marks.** A Disputed or Outdated value is not bold; it keeps only its mark, so emphasis never makes an unsettled value look settled. Bold in page text means a key phrase and nothing else, so the switch can turn it off cleanly. Bold has no colour and screen readers do not announce it, so it never carries meaning alone.
- **The reader's switch.** "Key phrases in bold" in the page's Aa menu, on by default. It is kept in the account, so it is the same in every company, and is also in Account › Profile and language and in ⌘K.
- **Three languages.** Lengths count characters, since Chinese and Japanese have no spaces, and a phrase never splits a word. Bold only, never italics, which Chinese and Japanese fonts only fake by slanting. A Chinese or Japanese serif at weight 600 barely differs from 400 on screen, so key phrases take 700. Japanese could later use emphasis dots (bouten) instead, set in its language pack; it starts with bold until a Japanese reader has looked.
- **Cost and timing.** About 1.5 to 2 person-weeks, built together with knowledge pages, which do not exist yet. PageSpec's inline text already allows strong emphasis, so the page contract does not change. The Annotated view needs one additive field: where a value sits in its quote. Writing the rule into the page prompt from its first version costs less than adding it later. A short reading test, the time to find an answer with and without bold, decides whether it stays on by default.

## 5. Settings follow who answers for them

| Who answers for it | Settings | Where |
| --- | --- | --- |
| You, everywhere | Name, interface language, sign-in methods, the companies you belong to, notifications | Account, under You |
| You, in one company | Your source connections, apps with access, what the assistant may decide for you, your usage | Account, under the company |
| A space owner | Who reads the space, owners of areas and topics, governance levels of its documents, approval and conflict settings (modes, deadlines, kinds of decision kept for people), content language, rules | Managing the space |
| The super admin: the company | Name, default languages, data region | Admin › Company |
| The super admin: people | Members and seats, invitations, sign-in and joining (verified email domains, the company's Feishu organization, single sign-on, directory sync) | Admin › People |
| The super admin: spaces | Spaces, their owners and readers, the publish queue | Admin › Spaces |
| The super admin: sources and apps | Company source connections, company agents, which apps members may allow | Admin › Sources and apps |
| The super admin: security | Sensitivity labels and which model providers may see them, the audit log, turning Decide for me off for the company | Admin › Security |
| The super admin: usage | Usage per member and kind of work, plan, seats | Admin › Usage and billing |

The super admin decides who and how, never what knowledge says. That is why owners of topics are a space owner's setting, not an admin page.

## 6. Every list at its real size

Measured numbers come from the prototype's synthetic company of 10,000 documents (see [Statements at scale](statements-at-scale.md)); the rest are estimates to check with a design partner.

| List | Typical | Large | How it is shown |
| --- | --- | --- | --- |
| Companies in the account menu | 1, plus the personal library | 5 | A plain list at the top of the account menu |
| Spaces in a company | 5 to 15 | 100 or more | The spaces you use first, then All spaces with search |
| Documents in a space | 300 to 3,000 | 50,000 | A tree by source app and folder, opened lazily, with counts on folders and search inside |
| Topics in a space | 10 to 40, in 3 to 8 areas | 300 | Folded by area, with search. Sizes come from clustering: a topic splits at about 100 statements |
| Statements in a topic | about 1,000 (measured median 1,143) | 6,000 (measured max 6,206) | Never listed. Fact slots first, then the pages that use them, then the rest folded by document with counts |
| Pages, procedures and cards in a topic | 5 to 15 | 50 | A list |
| Todos per owner per week | 2 (p90 5) on one card | 26 on 4 cards; 605 on 44 campaign cards on day one | An overview first, then cards of at most 20, at most 10 cards a week |
| Open conflicts in a space | 0 to 5 | 30 | A list by deadline |
| Publish requests in a space | 0 to 3 a week | 20 | A list by deadline |
| Members of a company | 10 to 200 | 5,000 | Search first, filters and bulk actions; never a full table without search |
| Readers of a space | Groups and a count, "All 18 Procurement members" | Thousands | Groups, never a list of people |
| Owners in a space | 3 to 10 | 40 | By area, inherited downwards |
| Source connections | 2 to 8 for the company, 0 to 3 per member | 30 | A list |
| Apps with access, per member | 1 to 5 | 20 | A list |
| Rules in a space | 0 to 20 | 200 | By kind, with search |
| Decided for you, per week | 0 to 40 | 300 | One line of totals, grouped by kind, Undo per group |
| Comments on a page | 0 to 10 | 100 | Threads by block, resolved ones folded |
| Search hits | 10 | 50 a page | The answer first, then hits |
| Audit log | thousands a day | millions | A query with filters, never a feed |

The rule of thumb: up to 10 items, show them all. From 10 to 100, group or sort by what needs attention and fold the rest. Above 100, search or filter first and show a summary with the exceptions. When there is no end, it is a query, not a list.

## 7. The assistant in the interface, quietly

Inspiration is an AI-native product, so the assistant is in almost every screen. It should feel like a colleague who has already done the reading, not like a feature asking for attention.

1. **An overview before every pile.** The inbox, a queue, a batch change, a topic, search results and an imported folder each open with an overview from the engine's numbers: what happened, what needs you, and what it can settle. Numbers never come as a list in a sentence. The few that matter, at most four, sit on cards in one row: each with its value, a short trend ("4 last week", "up 18 on last month") and a small line where the trend matters; a card is also a filter. Under the cards, two or three sentences say what the numbers mean, as a quality or a trend, without repeating them: "A busier week than usual, mostly routine reviews and notes that can follow your usual choices. What needs you is a split vote, a permission change and a conflict over who approves." A number appears in words only as the label of an action, such as "Settle these 6".
2. **The suggestion is the default.** Where a person chooses, the assistant's choice is already selected and marked Suggested, with a one-line reason. Enter confirms it; another option is one click away. There is no chat bubble and no "the AI says" panel: the suggestion lives in the state of the controls, in what is selected, what comes first and what is folded.
3. **Decide for me sits on piles.** One action on an overview or a card settles everything the assistant may settle, and leaves the rest marked Left for you. A single item is decided by accepting its suggestion, so there is no Decide for me button on every item. The `d` key and ⌘K reach it anywhere. After someone accepts the suggestion for one kind of decision five times in a row, the assistant asks once, in a line under the decision, whether to always decide that kind.
4. **Left for you, with its reason.** When the assistant may not or should not decide (people disagree, it changes who can read, it cannot be undone, it is unsure, or the space keeps that kind for people), it says why in one line and still fills in its suggestion.
5. **Results, not process.** The assistant's work shows as outcomes: a filled-in choice, a sorted list, a card that reads "Decided for you this week: 34, 2 undone". It does not narrate progress or open windows nobody asked for.
6. **Why and Undo on everything it did.** "Why?" shows the reason and the passages it read; Undo restores the earlier state and gives the item back.
7. **No styling of its own.** The assistant has no avatar, sparkle or colour. Its marks are words (Suggested, Decided for you, Left for you), small and muted, never louder than the person's own content.
8. **Asking is always there and never in the way.** The ask box on Home, ⌘K everywhere, and Ask about this on any selection. Answers appear in place, in a panel or a popover, with citations.

Left out on purpose: a chat sidebar on every screen, an AI button on every item, AI badges, changes applied without a record, and summaries of things nobody asked about. The rules for delegation are in [Decide for me](decide-for-me.md).

## 8. What this changes on the canvas

An audit of the design canvas (version 72) against this document:

| Found on the canvas | Rule | Next version |
| --- | --- | --- |
| Six different top bars: account and admin screens drop the switcher or search, and some show Compact as if it were a place | Section 3 | One top bar on every screen; Compact is a setting |
| Nine shapes of left column: an area menu, inbox filters, owner tools, an admin list, an account list, a document tree, a Trace outline, or none | Section 3 | The left column always shows one of the four areas; filters and outlines move into the screen |
| Admin is one flat list mixing people, spaces, sources and security, and holds Topic owners, which belongs to space owners | Section 5 | Admin grouped by concern; owners of topics live in the space |
| Lists drawn with three to five rows and no search where the real list holds hundreds (members, topics, spaces) | Section 6 | Each list drawn at its typical size, with how it behaves when large |
| The assistant shows up in six ways: a Suggested chip, "the system suggests", comment replies, plain text, nothing at all, and draft Decide for me buttons on every item | Section 7 | One pattern: overview, suggestion as the default, Decide for me on piles |
| Two demo stories with different people: Procurement in English, Finance travel in Chinese | | One story and one cast on every screen |
| 负责人 on the canvas, 维护人 in the documents | The product owner kept 负责人 on 2026-11-05 | 负责人 everywhere; the second version's boards say 维护人 until they are redrawn |
| The early explorations A, B and C share the canvas with the chosen design | | Moved to an archive area |

The second version (canvas version 74, rows V2 in [screens](screens/README.md)) applies these rules to nineteen screens. The first row covers the structure, reading, the account and admin; the second covers working: the inbox, decisions, managing a space, publishing and Trace. From the first version, only the three boards after importing (E-doc, E-doc-layers and E-doc-knowledge) still stand. Canvas version 79 applies the placement table in section 3 to every second-version board: the top bar names the company as plain text, the account menu switches companies, and Decide for me is no longer an account menu item, because it happens in the inbox and in each decision; its settings are the standing delegations under Account. It also adds V2-tree, which compared four options for showing a space's documents and knowledge in the left column; the product owner chose to keep today's shape, with Documents and Knowledge under each space.

Canvas version 80 applies the product owner's next three comments to every second-version board. The four areas are told apart by their left column (paper, blue-tinted with an indigo header, dark, and the account header), and every screen outside reading starts with breadcrumbs from the area, with a way back after a jump. The right panel always has a title and follows the selection: V2-doc is new and shows an original document with comments and a revision proposal beside it, while V2-page shows a knowledge page with what is in progress on it. Overviews move their numbers onto at most four cards with trends, and their sentences only say what the numbers mean (home, inbox, managing a space, batch changes, documents, members and source connections).

Canvas version 81 renames the standing delegations page, which the product owner found hard to understand, to **Always decide for me**, after the action people already know: Decide for me is this once, Always decide for me is from now on. Each kind is written as a rule in two columns, "when this comes up" and "the assistant does this", and the page shows where a kind comes from: the one-line question under a decision in the inbox. "Standing delegation" stays the name in the [Decide for me](decide-for-me.md) spec.

Canvas version 86 adds V2-skim, the key phrases in bold that section 4 keeps in reserve.

## 9. What the UI needs from the engine

Checked against the engine on 2026-10-27 (`main` after pull request #24, and the engine thread's validation work):

- **Overviews.** Collaboration already groups todos by owner, topic, fact slot and week. The overview needs one summary read per person: counts by kind and cause, and which ones the assistant may settle. This is additive.
- **Suggestion as the default.** Governance already proposes the most authoritative value with a reason (GV-1), and a todo already offers one-click resolutions (`TodoResolution`). A resolution needs to say that it is the suggested one and why. This is additive.
- **Decide for me.** The delegation contract and the change to AG-4 are in [Decide for me](decide-for-me.md), and need agreement before they are built.
- **Left for you.** A todo needs the reason it was left for a person. This is additive.
- **Undo.** Decisions are records (GV-7) and knowledge is never deleted, so an undo is a new decision that restores the earlier state.
- **Key phrases in bold (in reserve, section 4).** Page synthesis, once it is built, marks key phrases with strong emphasis and uses it for nothing else. The Annotated view needs one additive field on each quote: where the statement's value sits in it.
- **What the engine decides, said in words.** The engine now orders documents without a date by when they last changed, and holds an original over its translations. What this says and the Documents tree say so in words, such as "newer than" and "translation of".

## Still open

- Which numbers each overview's cards show. The canvas draws a first choice per screen.
- The Japanese terms for Suggested, Decided for you and Left for you.
- Whether Japanese key phrases stay bold or use emphasis dots (section 4).

## About this page

Proposed on 2026-10-27, after the product owner asked for one clear philosophy that every screen follows, instead of fixes one comment at a time. It goes from the general to the specific: the stance, the beliefs, one grammar with four places you can tell apart, where settings live, how big each list really is, how the assistant shows up, and what this changes on the design canvas. The [UI principles](ui-principles.md) and the drawn screens follow from this page; where they differ, this page wins until they are redone. Adopted on 2026-11-05. A Chinese copy is in [docs/zh/design/ui-philosophy.md](../zh/design/ui-philosophy.md); if the two differ, this English version wins.
