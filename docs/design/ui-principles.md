# Inspiration UI: interaction principles and visual design

Status: adopted design, 2026-10-24. The screens are drawn on the owner's design canvas; there is no production UI code yet. Companion document: [Statements at scale](statements-at-scale.md), which explains how statements are organised and reviewed. A Chinese copy is in [docs/zh/design/ui-principles.md](../zh/design/ui-principles.md).

## Who the UI serves

| Role | What they do |
| --- | --- |
| Member | A person in a workspace. Reads knowledge pages, asks, comments, and keeps their own material in My space. Most members are readers, most of the time |
| Owner | Named for a space, topic, page or procedure. Approves what is published there, keeps its statements current, confirms where they belong and decides its conflicts. A space owner also takes over topics without an owner, works backlogs in bulk and decides a vote that splits or runs late |
| Super admin | Runs the workspace: members, spaces and who can read them, connections to source apps, policies, audit and usage. Never sees into My space, or what anyone asked or read |
| Someone working alone | Has a personal library and never sees workspaces, spaces, members or publishing |

These are the only roles the UI shows. Permissions are finer inside the product, so a role can be split later without changing these screens much.

The places these people work in:

- A **workspace** is a company's shared area, for example Hengyuan Machinery.
- A **space** is an area of a workspace, such as Procurement. Its owner and the super admin decide who can read it.
- **My space** is a member's private area inside a workspace. Nobody else can see into it, the super admin included.
- The **personal library** is what someone has before they work with anyone else. Inviting someone or creating a team workspace turns on the workspace switcher and My space.

## Interaction principles

1. **Reading first, governance on demand.** A page opens as a clean document. Owners, votes and rules appear only when someone asks or acts. The knowledge model itself (statements, counts, lineage) is never part of the reading surface; owners see it in the Trace view.
2. **Every statement shows where it came from and how fresh it is.** A citation is one click from the source passage, and status is always written in words (Fresh, Review due, Outdated, Disputed), never shown by colour alone.
3. **Always show which space you are in and who can read it.** The space switcher sits in the header, and every space states who can read it, as set by its owner or the super admin, with a count such as "All 18 Procurement members".
4. **The assistant proposes, people decide.** The assistant drafts options, raises conflicts and answers questions, but a named person votes, approves or publishes.
5. **Never hand over credentials, and make widening visible.** A personal connection stays personal. Publishing shows who will be able to read, and warns without blocking when some readers cannot open the original.
6. **A conflict always has an owner, a deadline, an approval mode, someone who decides when the deadline passes, and a record.** Meanwhile readers see the last verified value marked Disputed, unless the owners choose otherwise.
7. **One inbox.** Reviews, votes, notes, reconnect requests and replies all land in one place, grouped into cards and ordered by deadline.
8. **Calm by default.** Only Outdated and Disputed marks show inline. Everything else waits in the margin or the side panel.
9. **Keyboard, command and CLI parity.** Every action has a shortcut, a command-palette entry and a CLI equivalent.
10. **Three languages from day one.** Every screen ships in English, Chinese and Japanese. Type, line height and line length are tuned per language, and layouts leave room for the longest label.
11. **Trust through history.** Every value can answer "Why this value?": who verified it, when, and which decision or rule set it.

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

- **Header:** workspace and space switcher (hidden for someone working alone), ask or search, account menu (including interface language).
- **Left:** the Knowledge tree (spaces, topics, pages) and the Sources tree (connected apps and their folders), with an icon per source app.
- **Centre:** the document. A source has an Original view (as written) and an Annotated view (outdated and disputed lines marked inline, other notes in the margin), plus an "In knowledge" chip that leads to the pages using it. A knowledge page cites its sources inline.
- **Right panel:** Comments, Sources, Related, History. Clicking a citation opens the source beside the page.
- **Selection menu:** Comment, Highlight, This is outdated, Propose a correction, Ask about this.

## Key screens

| Screen | What it shows | For |
| --- | --- | --- |
| Sign in and choose a workspace | Sign-in, then the workspaces the person belongs to and their personal library | Everyone |
| Home | Ask bar, recent pages, the inbox cards that need you | Everyone |
| First run alone | Ask box, connect a source, setup progress; the account menu offers "Invite someone" and "Create a team workspace" | Someone working alone |
| Search and ask results | An answer in the asker's language with citations, then matching pages and sources | Everyone |
| Knowledge page | Text with small citation numbers, only Outdated and Disputed inline; owner and freshness in the margin; "Why this value?" on a disputed value; comment threads with the assistant's replies | Readers |
| Citation popover | The source passage at once, one sentence on its status (Review due shows here), translation on request | Readers |
| Source document | Original and Annotated views, the selection menu, the "In knowledge" chip | Anyone checking where knowledge came from |
| Inbox | Cards per topic and week, conflict cards with their copy reviews, the weekly notes card, campaign cards for space owners | Owners |
| Conflict, joint approval | Both sides with evidence, options with counts, votes, approval mode, deadline, who decides after it, what readers see meanwhile, "Make this a rule", the record | Owners |
| Trace view, page | The page's statements grouped by page section, with lineage from source to passage to statement to page | Owners |
| Trace view, topic overview | Fact slots first, then the pages that use them, then everything else folded by source document with counts; an inspector with topic status, owner, this week's todos and CLI lines | Owners |
| Sources | The Sources tree with each folder's governance level, which the space owner can change | Space owners |
| Publish to a space | The items to publish, the target space and who can read it (set by its owner or the super admin), one freshness question per source, checks, the "Some readers can't open the original" warning, approver and request state | Members publishing from My space |
| Admin: spaces and publishing | Spaces with who can read them, sensitivity label and owner; the publish queue; "Source permissions tightened" todos; usage per member | Super admin |
| Admin: connections | Workspace connections to source apps; the consent screen for connecting a personal account | Super admin, members |
| Space settings | Owner, who can read it, default governance level, content language | Super admin, space owner |
| Phone | Reading, joint approval and the inbox | Everyone |

## How knowledge appears

Readers never see the structure behind a page. A knowledge page, procedure or topic page reads as a normal document: text, small citation numbers, and only the Disputed and Outdated marks. Clicking a number shows the source passage and one sentence on its status.

Behind the page, knowledge has layers:

- **Sources** stay as written, in the Sources tree. Nothing is copied or cleaned per document.
- **Passages** are the spans the engine cuts out of a source. Every later layer points back to them.
- **Statements** are the smallest governed unit: one fact with its status, owner, effective date and the passages behind it. Reviews, disputes and rules act on statements. Statements about the same fact share a fact slot.
- **Knowledge forms** are built only from statements: knowledge pages, procedures, and cards for things such as a city, a supplier or a role. One statement can appear in several forms, so it is governed once.
- **The Knowledge tree** files everything under topics. Each topic has an owner, falling back to the space owner and then to the super admin. A new source is filed into a topic when its owner confirms the assistant's suggestion.

Each source also has a governance level: Governed sources are fully extracted and reviewed, Reference sources are extracted only when used, and Search-only sources are only searched. [Statements at scale](statements-at-scale.md) describes the levels and the measured volumes.

Statements, counts, sources and lineage live in the **Trace view**, which owners open on purpose from the page's ⋯ menu, ⌘K or the CLI, in compact mode. Page text is written by the assistant from statements, so editing the text proposes a change to the statements behind it, and when a dispute ends, every page, procedure and card that uses the statement updates together.

Statuses map from the engine's freshness states. Fresh and aging show nothing. Stale and at risk show Review due, only in the citation popover and the Trace view. Superseded shows Outdated and disputed shows Disputed; these two are the only marks inline. In the prototype about a fifth of documents become stale after a year without review, so an inline staleness mark would sit on a fifth of all pages.

## Permissions in the UI

- **Who can read follows the space, never the source.** Screens show a space's audience as set by its owner or the super admin, and never a count derived from source permissions.
- **My space is private.** A member's own material stays private until they publish it. The super admin cannot open it.
- **Publishing moves knowledge into a space.** For each source, the publish screen asks one question: how it stays fresh. The choices are to keep it fresh with the workspace connection (the default), to keep it fresh with my connection (with the member's consent), or to publish a snapshot with a review date. A file without a live connection can only be a snapshot.
- **Source permissions only warn.** "Some readers can't open the original" appears in the publish screen and never blocks. After publishing, the space owner gets a "Source permissions tightened" todo when a source's own permissions narrow, with the choices to keep the knowledge visible, hide it, or see which items are affected.
- **The super admin sees the process and the usage, not the content.** The publish queue shows progress and check results, and usage shows amounts per member and kind of work, never questions or pages. The super admin can reassign the approver; the new approver sees only the items in that request, and the change is written to the audit log.
- **Working alone hides the workspace.** Someone working alone sees no workspace, space, member or publishing at all.

## Inbox and review

An owner's inbox holds a handful of cards a week. Todos for one owner about one topic in one week share a card of at most 20 todos, and an owner gets at most 10 cards a week; more urgent work never waits. A conflict card carries the reviews of documents that repeat the disputed value ("used in 4 places, all update together after the decision"). Notes, where only reference documents state a different value, sit on a weekly notes card outside the budget and are acknowledged in one action. Reviews that were already due on the day a workspace connects its sources become first-review campaign cards for the space owner, worked in compact mode. Measured volumes are in [Statements at scale](statements-at-scale.md).

## Internationalisation

Inspiration is an international product. English, Chinese (Simplified) and Japanese are equal from the first release. The canvas tells its demo story in Chinese, but Chinese is one of three languages, not the default.

- **The interface follows the person; content keeps its own language.** Each person picks an interface language in the account menu. It belongs to their account, so it stays the same in every workspace, and its first value comes from the browser at sign-up. A workspace has its own default language for messages it sends to many people. Sources stay in the language they were written in and are never translated silently.
- **Each space has a content language.** The space owner sets it, and the assistant writes that space's knowledge pages in it. A Japanese member reading a Chinese space sees Japanese menus, buttons and statuses around Chinese pages.
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

The Chinese terms are adopted. The Japanese terms are proposed and wait for the owner's review.

| English | Chinese | Japanese | Note |
| --- | --- | --- | --- |
| Personal library | 我的知识库 (个人知识库 in the switcher) | マイライブラリ (個人ライブラリ in the switcher) | What someone working alone has |
| Workspace | 企业 | ワークスペース | Never "tenant" or "organisation" in English; Chinese says 企业, as Feishu and DingTalk do, never 租户 |
| Space, My space | 空间, 我的空间 | スペース, マイスペース | My space is private to the member |
| Member | 成员 | メンバー | Never "user" or "account" |
| Workspace connection, Personal connection | 企业连接, 个人连接 | ワークスペースの接続, 個人の接続 | Never "credential" or "token" |
| Source, Passage, Statement | 来源, 段落, 陈述 | ソース, 段落, 記述 | |
| Topic, Knowledge page, Procedure, Card | 主题, 知识页, 流程, 卡片 | トピック, ナレッジページ, 手順, カード | |
| Knowledge tree, Sources tree | 知识树, 来源树 | ナレッジツリー, ソースツリー | |
| Original, Annotated, Knowledge views | 原文, 批注, 知识 | 原文, 注釈, ナレッジ | |
| Trace view | 追溯 | 追跡 | Owners only |
| Governed, Reference, Search only | 严格, 宽松, 仅检索 | 規程, 参考, 検索のみ | Governance levels |
| Fresh, Review due, Outdated, Disputed | 有效, 待复核, 已过时, 有争议 | 有効, 要確認, 旧版, 異論あり | Only Outdated and Disputed show inline |
| Owner (Space owner, Topic owner, Page owner, Procedure owner), Super admin | 负责人（空间负责人、主题负责人、页面负责人、流程负责人）, 超级管理员 | 担当者（スペース担当者、トピック担当者、ページ担当者、手順担当者）, 特権管理者 | With Member, the only roles the UI shows |
| Rule | 裁决规则 | 裁定ルール | Made from a decision with "Make this a rule" |
| Any one, Everyone (joint approval) | 或签, 会签 | いずれか承認, 全員承認 | Approval modes |
| Who can read this | 可见范围 | 公開範囲 | Always with a count |
| Inbox, Assistant | 待办, 助手 | 受信トレイ, アシスタント | The assistant has no name of its own |
| Keep fresh with the workspace connection, Keep fresh with my connection, Publish a snapshot | 通过企业连接保持更新, 通过我的连接保持更新, 发布快照 | ワークスペースの接続で最新に保つ, 自分の接続で最新に保つ, スナップショットを公開 | The publish question per source |
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

- Three roles in the UI: member, owner (shown by scope) and super admin.
- In Chinese, a workspace is 企业 and the governance levels are 严格, 宽松 and 仅检索.

## Still open

- Review the Japanese terms in the glossary.
- Confirm the translation rules: cited passages are translated only on request and labelled as machine translation, and knowledge pages stay in their space's content language for now.
- Still to draw: publish and conflict in compact mode, and Japanese versions of the key screens.
