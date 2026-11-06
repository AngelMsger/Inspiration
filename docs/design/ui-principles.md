# Inspiration UI: interaction principles and visual design

Status: adopted, 2026-10-24; the MVP web app in `apps/web` is built on its visual system.

## Conclusions

- **The UI shows three roles:** member, owner named with its scope (space, topic, page or procedure owner) and super admin. Someone working alone sees no company at all. Finer permissions stay inside the product.
- **Concrete before abstract, reading before governance.** People meet their own documents first, in their original form, and knowledge appears on top of them step by step. A page reads as a normal document with citations. Only Outdated and Disputed show inline, and the knowledge model stays in the Trace view for owners.
- **Every decision has a named person, who can let the assistant decide,** and every value can answer "Why this value?".
- **The look is ink and paper:** a warm paper ground, serif type for reading, one indigo accent and status marks written in words, with a command palette, a compact mode for owners and a pair of typefaces per language.
- **English, Chinese and Japanese are equal from the first release.** The interface follows the person, content keeps its own language, and one glossary gives every term in all three ([Glossary](#glossary)).
- **Where this page and the [UI philosophy](ui-philosophy.md) differ, the philosophy wins** until this page is redone. Still open: the Japanese terms and the translation rules ([Still open](#still-open)).

## Who the UI serves

| Role | What they do |
| --- | --- |
| Member | A person in a company. Reads knowledge pages, asks, comments, and keeps their own material in My space. Most members are readers, most of the time |
| Space, topic, page or procedure owner | Named for a space, topic, page or procedure. Approves what is published there, keeps its statements current, confirms where they belong, decides its conflicts and releases statements to wider audiences. A space owner also decides who can read the space and its governance levels, takes over topics without an owner, works backlogs in bulk and decides a vote that splits or runs late |
| Super admin | Runs the company: members, connections to source apps, company settings, audit and usage. Creates spaces and names their owners, but never decides what knowledge says. Never sees into My space, or what anyone asked or read |
| Someone working alone | Has a personal library and never sees companies, spaces, members or publishing |

These are the only roles the UI shows. Permissions are finer inside the product, so a role can be split later without changing these screens much.

The places these people work in:

- A **company** is the shared area of a business or a team, for example Hengyuan Machinery.
- A **space** is an area of a company, such as Procurement. Its owner decides who can read it; the super admin can only narrow that in a security incident.
- **My space** is a member's private area inside a company. Nobody else can see into it, the super admin included.
- The **personal library** belongs to the account: one per account, outside every company, and it never becomes one. It is what someone has before they work with anyone else, and it stays as it was when they join, create or leave companies. Inviting someone from it creates a new company. Joining or creating a company turns on the company switcher, with two groups: companies, and the personal library.
- My space and the personal library are both private, but My space belongs to its company: usage counts there, its connections follow the company's settings, and it is locked when the member leaves. V2-switcher compares the two.

## Interaction principles

1. **Concrete before abstract.** People meet their own material first. An imported document opens in its Original view, with its headings, paragraphs, lists and tables, and knowledge appears on top of it one step at a time: marks on the passages that became knowledge, then what a passage says and what other documents say about it, then the knowledge page. Knowledge pages and topics are the second way in, for people who already know what they are looking for.
2. **Reading first, governance on demand.** A page opens as a clean document. Owners, votes and rules appear only when someone asks or acts. The knowledge model itself (statements, counts, lineage) is never part of the reading surface; owners see it in the Trace view.
3. **Every statement shows where it came from and how fresh it is.** A citation is one click from the source passage, and status is always written in words (Fresh, Review due, Outdated, Disputed), never shown by colour alone.
4. **Always show which company and space you are in, and who can read it.** The top bar names the company, the left column and breadcrumbs name the space, and every space states who can read it, as set by its owner, with a count such as "All 18 Procurement members".
5. **Every decision has a person, who can let the assistant decide.** The assistant drafts options, raises conflicts and answers questions, and its suggestion is already filled in. A named person votes, approves or publishes, or lets the assistant decide for them, and can undo it. See [Decide for me](decide-for-me.md).
6. **Never hand over credentials, and make widening visible.** A personal connection stays personal. Publishing shows who will be able to read, and warns without blocking when some readers cannot open the original.
7. **A conflict always has an owner, a deadline, an approval mode, someone who decides when the deadline passes, and a record.** Meanwhile readers see the last verified value marked Disputed, unless the owners choose otherwise.
8. **One inbox.** Reviews, votes, notes, reconnect requests and replies all land in one place, grouped into cards and ordered by deadline.
9. **Calm by default.** Only Outdated and Disputed marks show inline. Everything else waits in the margin or the side panel.
10. **Keyboard, command and CLI parity.** Every action has a shortcut, a command-palette entry and a CLI equivalent.
11. **Three languages from day one.** Every screen ships in English, Chinese and Japanese. Type, line height and line length are tuned per language, and layouts leave room for the longest label.
12. **Trust through history.** Every value can answer "Why this value?": who verified it, when, and which decision or rule set it.

## Visual system

The look is "ink and paper": a warm paper ground, serif type for reading, one indigo accent for actions, and small labelled status marks. Reading density is the default. Two tools come from a denser, owner-oriented style and are added without changing that character: a command palette and a compact mode with an inspector panel. Home also has an ask bar.

| Token | Value | Use |
| --- | --- | --- |
| paper | #EFEEE9 | Application ground |
| page | #FBFAF7 | Document surface |
| ink | #1C1E23 | Body text |
| muted | #545964 | Secondary text |
| faint | #636874 | Tertiary text; 4.5:1 or better on paper |
| rule | #DCDAD2 | Dividers and borders |
| indigo | #2E3F8F (hover #1F2C6B, soft #E7E9F4) | Actions, links, selection |
| fresh | #2D6A4F on #E3EFE8 | Fresh status mark |
| due | #8A5A00 on #F5EBD6 | Review due status mark |
| disputed | #A3341F on #F6E2DC | Disputed status mark |

- **Type.** Each language has its own pair of faces for reading and for interface text: Newsreader and Instrument Sans for English, Noto Serif SC and Noto Sans SC for Chinese, Noto Serif JP and Noto Sans JP for Japanese. Geist Mono sets code and CLI lines.
- **Densities.** Reading density everywhere, and the only density on touch screens. Compact density (13 px text, an inspector panel on the right) is for owners and the super admin on desktop and is toggled with ⌘ . (Command and full stop).
- **Command palette.** ⌘K on every screen. Each row shows the action, its shortcut and its CLI line.
- **Ask bar.** On Home only, with an ink border and serif input. Elsewhere the header search does the job.
- **Dark theme.** Dark tokens exist, with every text pair at 5.7:1 or better, but the dark theme is not part of the first release.

## Layout

- **Header:** the current company's name as plain text, ask or search, and the account menu. The account menu switches companies and opens the personal library (someone working alone has no company group there) and holds the interface language. Most people belong to one company, so switching does not get the top bar's prime spot; ⌘K reaches any company too. The header never switches spaces; the left column does.
- **Left:** the Documents tree (source apps and their folders, with an icon per source app), then the Knowledge tree (spaces, topics, pages). Documents come first because people know their documents before they know the knowledge built from them. The Documents tree also holds chats and sheets, but Documents is the word people use for their material.
- **One navigation everywhere.** The header is the same on every screen. The left column always navigates the area you are in: everyday use (Home, Inbox, My space, the spaces, the Documents and Knowledge trees), a space's owner tools (Freshness queue, Conflicts, Publish requests, Rules, Space settings), Admin, or your account. Reading a page or a document folds the left column away to give the text room; a button brings it back, and breadcrumbs above the text say where you are and, after a jump, where you came from. Breadcrumbs never replace the header or the left column. The four areas look different at a glance: reading on paper, managing a space in a blue-tinted column under an indigo header, Admin in a dark column, and Account under its own header (section 3 of the [design philosophy](ui-philosophy.md)).
- **Centre:** the document. A source opens in its Original view: rendered from its blocks without a model, it keeps the headings, paragraphs, lists and tables of the source. It is close to the source app's page but not a copy of it, and a block that cannot be rendered, such as a flowchart, shows a placeholder that opens the source. The Annotated view adds marks: a dotted underline on passages that became knowledge, and the Outdated and Disputed marks. The Knowledge view lists what was taken from each section of the document, in plain sentences with their status and the pages that use them, and how the document relates to other documents. A knowledge page cites its sources inline.
- **Right panel:** always titled with what it is about, and only about the selected thing. Beside an original document it holds comments and revision proposals on the selected passage; beside a knowledge page, its outline, what is in progress on it, related pages and sources; in the Annotated view, What this says. Clicking a citation opens the source beside the page.
- **Selection menu:** Comment, Highlight, This is outdated, Propose a correction, Ask about this.

## Key screens

The drawn screens are in [screens](screens/README.md), a snapshot of the design canvas. The second version (rows V2) is drawn from the [UI philosophy](ui-philosophy.md) and wins where the rows differ.

| Screen | What it shows | For |
| --- | --- | --- |
| Sign in and choose a company | Sign-in, then the companies the person belongs to and their personal library | Everyone |
| Home | Ask bar, recent documents and pages, the inbox cards that need you; someone new sees the documents they imported first | Everyone |
| First run alone | Connect or upload a source and setup progress, then the imported documents, each readable as soon as it has been read; the ask box; the account menu offers "Invite someone" and "Create a company" | Someone working alone |
| Source document | Original, Annotated and Knowledge views; the selection menu; What this says, with the knowledge taken from a passage, what other documents say about it and the pages that use it | Everyone; the first screen after importing |
| Search and ask results | An answer in the asker's language with citations, then matching pages and sources | Everyone |
| Knowledge page | Text with small citation numbers, only Outdated and Disputed inline; owner and freshness in the margin; "Why this value?" on a disputed value; comment threads with the assistant's replies | Readers |
| Citation popover | The source passage at once, one sentence on its status (Review due shows here), translation on request | Readers |
| Inbox | Cards per topic and week, conflict cards with their copy reviews, the weekly notes card, campaign cards for space owners | Owners |
| Conflict, joint approval | Both sides with evidence, options with counts, votes, approval mode, deadline, who decides after it, what readers see meanwhile, "Make this a rule", the record | Owners |
| Trace view, page | The page's statements grouped by page section, with lineage from source to passage to statement to page | Owners |
| Trace view, topic overview | Fact slots first, then the pages that use them, then everything else folded by source document with counts; an inspector with topic status, owner, this week's todos and CLI lines | Owners |
| Documents | The Documents tree with each folder's governance level, which the space owner can change | Space owners |
| Publish to a space | The items to publish, the target space and who can read it (set by its owner), one freshness question per source, checks, the "Some readers can't open the original" warning, approver and request state | Members publishing from My space |
| Admin: spaces and publishing | Spaces with who can read them, sensitivity label and owner; the publish queue; "Source permissions tightened" todos; usage per member | Super admin |
| Source connections, Apps with access | The company's and members' connections to source apps, and what keeps each source fresh; the apps and agents that use knowledge, with the consent screen an app shows first | Super admin, members |
| Space settings | Owner, who can read it, topics and their owners by area with the week's proposed topic changes, approval and conflict settings, default governance level, content language | Space owner; the super admin creates spaces and names their owners |
| Phone | Reading, joint approval and the inbox | Everyone |

## How knowledge appears

Readers never see the structure behind a page. A knowledge page, procedure or topic page reads as a normal document: text, small citation numbers, and only the Disputed and Outdated marks. Clicking a number shows the source passage and one sentence on its status.

**From documents to knowledge.** Someone new starts from documents they already know, not from knowledge pages or cards. Each step adds a little. The Original view shows the document as written. The Annotated view marks the passages that became knowledge and the outdated and disputed lines. Selecting a passage opens What this says: the knowledge taken from it in plain sentences, the other documents that agree with it, differ from it or add to it, and the pages and procedures that use it. From there the knowledge page is one click away. What this says never shows statements, fact slots, counts or governance levels; those stay in the Trace view, which owners can open from the same panel.

Behind the page, knowledge has layers:

- **Sources** stay as written, in the Documents tree. The Original view renders them from their blocks; nothing is copied or cleaned per document.
- **Passages** are the spans the engine cuts out of a source. Every later layer points back to them.
- **Statements** are the smallest governed unit: one fact with its status, owner, effective date and the passages behind it. Reviews, disputes and rules act on statements. Statements about the same fact share a fact slot.
- **Knowledge forms** are built only from statements: knowledge pages, procedures, and cards for things such as a city, a supplier or a role. One statement can appear in several forms, so it is governed once.
- **The Knowledge tree** files everything under topics. Each topic has an owner, falling back to the space owner; every space always has one. A new source is filed into a topic when its owner confirms the assistant's suggestion.

Each source also has a governance level: Governed sources are fully extracted and reviewed, Reference sources are extracted only when used, and Search-only sources are only searched. [Statements at scale](statements-at-scale.md) describes the levels and the measured volumes.

Statements, counts, sources and lineage live in the **Trace view**, which owners open on purpose from the page's ⋯ menu, ⌘K or the CLI, in compact mode. Page text is written by the assistant from statements, so editing the text proposes a change to the statements behind it, and when a dispute ends, every page, procedure and card that uses the statement updates together.

Statuses map from the engine's freshness states. Fresh and aging show nothing. Stale and at risk show Review due, only in the citation popover and the Trace view. Superseded shows Outdated and disputed shows Disputed; these two are the only marks inline. In the prototype about a fifth of documents become stale after a year without review, so an inline staleness mark would sit on a fifth of all pages.

## Permissions in the UI

- **Who can read follows the space, never the source.** Screens show a space's audience as set by its owner, and never a count derived from source permissions.
- **My space is private.** A member's own material stays private until they publish it. The super admin cannot open it.
- **Publishing moves knowledge into a space.** For each source, the publish screen asks one question: how it stays fresh. The choices are to keep it fresh with the company connection (the default), to keep it fresh with my connection (with the member's consent), or to publish a snapshot with a review date. A file without a live connection can only be a snapshot.
- **Source permissions only warn.** "Some readers can't open the original" appears in the publish screen and never blocks. After publishing, the space owner gets a "Source permissions tightened" todo when a source's own permissions narrow, with the choices to keep the knowledge visible, hide it, or see which items are affected.
- **The super admin sees the process and the usage, not the content.** The publish queue shows progress and check results, and usage shows amounts per member and kind of work, never questions or pages. The super admin can reassign the approver; the new approver sees only the items in that request, and the change is written to the audit log.
- **Working alone hides the company.** Someone working alone sees no company, space, member or publishing at all.

## Inbox and review

An owner's inbox holds a handful of cards a week. Todos for one owner about one topic in one week share a card of at most 20 todos, and an owner gets at most 10 cards a week; more urgent work never waits. A conflict card carries the reviews of documents that repeat the disputed value ("used in 4 places, all update together after the decision"). Notes, where only reference documents state a different value, sit on a weekly notes card outside the budget and are acknowledged in one action. Reviews that were already due on the day a company connects its sources become first-review campaign cards for the space owner, worked in compact mode. Measured volumes are in [Statements at scale](statements-at-scale.md).

## Internationalisation

Inspiration is an international product. English, Chinese (Simplified) and Japanese are equal from the first release. The canvas tells its demo story in Chinese, but Chinese is one of three languages, not the default.

- **The interface follows the person; content keeps its own language.** Each person picks an interface language in the account menu. It belongs to their account, so it stays the same in every company, and its first value comes from the browser at sign-up. A company has its own default language for messages it sends to many people. Sources stay in the language they were written in and are never translated silently.
- **Each space has a content language.** The space owner sets it, and the assistant writes that space's knowledge pages in it. A Japanese member reading a Chinese space sees Japanese menus, buttons and statuses around Chinese pages, and can choose to read a page in Japanese: it is written from the same statements and labelled machine translated (see [Knowledge and language](knowledge-and-language.md)).
- **Answers follow the asker.** The assistant answers in the asker's interface language and cites passages in their original language. The citation popover can show a translation on request, labelled as machine translation, with the original one click away.
- **One glossary in three languages.** Every product term has an English, Chinese and Japanese form (see Glossary). Statuses, buttons and empty states are written from it, never translated ad hoc.
- **Type per script.** Chinese and Japanese share many characters but draw some of them differently, so every block carries its language tag, and a Japanese passage quoted inside a Chinese page still renders with Japanese glyphs. Chinese and Japanese body text uses a line height of about 1.75 and no letter spacing, and Japanese follows its line-breaking rules: no line starts with closing punctuation or a small kana.
- **Room for the longest label.** English labels run about 1.5 to 2 times as wide as Chinese ones, with Japanese in between. Buttons, tabs, table headers and chips size to their content and wrap rather than cut words off. Compact mode is checked in English, the longest of the three. Tests run a pseudo-locale with stretched strings.
- **Formats come from the locale.** Dates, large numbers, currencies and plural forms follow each locale's rules: for example "Oct 24, 2026" against its Chinese and Japanese forms, and "137.8k" against units of ten thousand. Sentences are never built by joining fragments, because word order differs between the three languages.
- **Names and sorting.** People's names show in the order and script each person uses, and no greeting assumes a given name. Lists sort by each locale's collation.
- **Input methods.** Chinese and Japanese are typed through an input method that composes text before committing it. Pressing Enter while composing never submits the ask bar, sends a comment or runs a palette command, and single-key shortcuts are off while a text field has focus.
- **Search and statements across languages.** Retrieval splits Chinese and Japanese text into words before indexing. Fact slots should key on normalised subjects and predicates rather than on the words used, so the same hotel cap stated in a Chinese policy and a Japanese memo lands in one slot. These two rules belong to the engine.

## Words on screen

The interface never shows "tenant", internal IDs or usernames. Approval modes are Single, Any one, Everyone (joint approval) and At least n. A publish request moves through Draft, In review, Published and Retired.

## Glossary

The Chinese terms are adopted. The Japanese terms are proposed and wait for the product owner's review.

| English | Chinese | Japanese | Note |
| --- | --- | --- | --- |
| Personal library | 个人知识库 | 個人ライブラリ | One per account, outside every company. Not 我的知识库, which reads too close to 我的空间 |
| Company | 企业 | 企業 | Never "tenant", "workspace" or "organisation" in English; Chinese says 企业, as Feishu and DingTalk do, never 租户 |
| Space, My space | 空间, 我的空间 | スペース, マイスペース | My space is private to the member |
| Member | 成员 | メンバー | Never "user" or "account" |
| Source connection: company, personal | 来源连接：企业、个人 | ソース接続：企業、個人 | Where knowledge comes from. "Connection" alone always means a source connection. Never "credential" or "token" |
| Apps with access | 使用知识的应用 | アクセスを許可したアプリ | Apps and agents that use knowledge, such as Claude, Cursor, the CLI and access tokens. Never "connected apps" |
| Source, Passage, Statement | 来源, 段落, 陈述 | ソース, 段落, 記述 | |
| Topic, Knowledge page, Procedure, Card | 主题, 知识页, 流程, 卡片 | トピック, ナレッジページ, 手順, カード | |
| Knowledge tree, Documents tree | 知识树, 文档树 | ナレッジツリー, ドキュメントツリー | The Documents tree also holds chats and sheets |
| Original, Annotated, Knowledge views | 原文, 批注, 知识 | 原文, 注釈, ナレッジ | |
| What this says | 这段讲了什么 | この段落の要点 | The panel for a selected passage |
| Trace view | 追溯 | 追跡 | Owners only |
| Governed, Reference, Search only | 严格, 宽松, 仅检索 | 規程, 参考, 検索のみ | Governance levels |
| Fresh, Review due, Outdated, Disputed | 有效, 待复核, 已过时, 有争议 | 有効, 要確認, 旧版, 異論あり | Only Outdated and Disputed show inline |
| Space owner, Topic owner, Page owner, Procedure owner; Super admin | 空间负责人、主题负责人、页面负责人、流程负责人；超级管理员 | スペース担当者、トピック担当者、ページ担当者、手順担当者；特権管理者 | With Member, the only roles the UI shows. An owner is always named with its scope, never a bare "Owner" (负责人, 担当者). The Chinese 负责人 was confirmed on 2026-11-05 |
| Rule | 裁决规则 | 裁定ルール | Made from a decision with "Make this a rule" |
| Any one, Everyone (joint approval) | 或签, 会签 | いずれか承認, 全員承認 | Approval modes |
| Who can read this | 可见范围 | 公開範囲 | Always with a count |
| Inbox, Assistant | 待办, 助手 | 受信トレイ, アシスタント | The assistant has no name of its own |
| Keep fresh with the company connection, Keep fresh with my connection, Publish a snapshot | 通过企业连接保持更新, 通过我的连接保持更新, 发布快照 | 企業の接続で最新に保つ, 自分の接続で最新に保つ, スナップショットを公開 | The publish question per source |
| Some readers can't open the original | 部分读者无法打开原文 | 一部の閲覧者は原文を開けません | Warning; never blocks |
| Source permissions tightened | 来源权限收紧 | ソースの権限が縮小されました | Space owner todo |

## Decisions

Adopted on 2026-10-23 and 2026-10-24:

- The ink-and-paper system as the base, with the command palette, compact mode and inspector, and the ask bar on Home.
- "Statement" is the word readers see for one piece of knowledge.
- The knowledge views: Original, Annotated and Knowledge views, with the Sources and Knowledge trees.
- The assistant stays "the assistant" in all three languages, with no name or mark of its own.
- No dark theme in the first release; its tokens stay in the design system.
- The first phone screens are reading, joint approval and the inbox.
- The Chinese terms in the glossary.

Adopted on 2026-10-26:

- Three roles in the UI: member, owner and super admin. An owner is always named with its scope (space owner, topic owner, page owner, procedure owner), because a bare "owner" is ambiguous.
- Proposed later the same day, waiting for the product owner: the super admin runs the company and owners run knowledge (the super admin creates spaces and names their owners but never decides what knowledge says or who reads a space). The Chinese name for owners was settled on 2026-11-05: 负责人, not the 维护人 proposed that day. See section 4 of the [overview](../overview.md).
- In Chinese, a company is 企业 and the governance levels are 严格, 宽松 and 仅检索. English says Company and Japanese 企業, to match.

Direction from the product owner on 2026-10-27:

- Concrete before abstract (principle 1). After importing, people first see their documents in their original form, and knowledge appears on top of them step by step, rather than starting from knowledge cards. The knowledge-first path stays for people who already know what they want. The canvas shows it in E-doc and E-doc-layers.
- The Sources tree is called Documents (文档, ドキュメント), the word people use for their material, although it also holds chats and sheets. A source is still a source wherever a page cites it.
- Connections that bring knowledge in are Source connections (来源连接, ソース接続), so people can tell them from the apps that use knowledge, which are Apps with access (使用知识的应用, アクセスを許可したアプリ; proposed) and are never called connected apps. Verified domains is not a separate admin page: the verified email domains and the company's own Feishu organization sit together in Admin › People › Sign-in and joining, because what they answer is who can come in (product owner's comment, 2026-10-27). Neither blocks a personal connection.

## Still open

- Review the Japanese terms in the glossary.
- Confirm the translation rules: cited passages are translated only on request and labelled as machine translation. A knowledge page shows in its space's content language unless the reader chooses their own; then it is written from the same statements and labelled machine translated.
- Still to draw: the other key screens in Japanese, after the Japanese terms are reviewed. V2-ja shows a knowledge page in Japanese.

## About this page

Adopted on 2026-10-24. The screens are drawn on the product owner's design canvas ([screens](screens/README.md)), and this page follows from the [design philosophy](ui-philosophy.md). Companion documents: [Statements at scale](statements-at-scale.md), which explains how statements are organised and reviewed, and [Decide for me](decide-for-me.md). A Chinese copy is in [docs/zh/design/ui-principles.md](../zh/design/ui-principles.md); if the two differ, this English version wins.
