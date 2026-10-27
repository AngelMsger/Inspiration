# UI screens

Status: a snapshot of the product owner's design canvas, "Inspiration UI"
(https://claude.ai/artifact/GYXc5GBY3bPq1XGuMUGwAk), taken on 2026-10-26 and updated on
2026-10-27 (canvas version 81). Screens are drawn and changed on the canvas. This folder holds a copy so reviewers
and team members can read the screens next to the docs. Where the two differ, the canvas wins.
A Chinese copy of this README is in
[docs/zh/design/screens/README.md](../../zh/design/screens/README.md).

The principles behind the screens are in [UI principles](../ui-principles.md). How statements
are grouped and reviewed is in [Statements at scale](../statements-at-scale.md).

## Opening a screen

Each screen is one static HTML file, so open it in a browser. The screens load their fonts
from Google Fonts. They also reference the canvas's `support.js`, which was not copied;
without it a screen still renders, just without the canvas frame. Every link is a `#`
placeholder. The people, the company (Hengyuan Machinery) and the figures are made up.

The files are byte-for-byte copies of the canvas. Biome skips this folder, and the
languages test allows Chinese and Japanese in it, so the copies never drift from the canvas.

## The second version (rows V2, in Chinese)

Drawn on 2026-10-27 from the [UI philosophy](../ui-philosophy.md): one top bar and one left
column on every screen, one story (the finance space at Hengyuan Machinery) with one cast, and
the assistant shown the same quiet way everywhere. Where the second version and the rows below
differ, the second version wins.

Structure, reading, account and admin:

| File | Screen |
| --- | --- |
| [V2-map](V2-map.dc.html) | One grammar for every screen and four places you can tell apart: the regions, where each element goes by how often it is used, how each area looks, where am I and where did I come from, what the right panel holds for each kind of thing, the four ways the assistant shows up, the cast |
| [V2-switcher](V2-switcher.dc.html) | The top bar names the company as plain text; the account menu switches companies (companies, then the one personal library); ⌘K for people who switch often; personal library and My space compared; inviting from the personal library; the top bar of someone working alone |
| [V2-home](V2-home.dc.html) | A member's home: ask, what changed in what they read, recently viewed |
| [V2-search](V2-search.dc.html) | Search and ask: the answer first, with citations, then the results with filters above them |
| [V2-page](V2-page.dc.html) | Reading a knowledge page with the left column folded, and a citation open on a disputed value; the right panel holds the outline and what is in progress on this page |
| [V2-doc](V2-doc.dc.html) | Reading the original document after following a citation: a way back to the page, and comments and a revision proposal on the selected passage |
| [V2-ja](V2-ja.dc.html) | The same page for a member whose interface is Japanese, who chose to read it in Japanese: written from the same statements and labelled machine translated, citing the Chinese original |
| [V2-phone](V2-phone.dc.html) | Phone: reading, the inbox overview and a vote |
| [V2-account](V2-account.dc.html) | Account: Always decide for me, each kind as a "when this comes up, the assistant does this" rule, where a kind comes from, and the limits. Decide for me itself happens in the inbox and in each decision |
| [V2-admin](V2-admin.dc.html) | Admin grouped by concern: members, search first |
| [V2-sources](V2-sources.dc.html) | Admin: source connections, the company's and the members' |
| [V2-tree](V2-tree.dc.html) | Four options for a space's documents and knowledge in the left column, compared with today's shape; the product owner kept today's shape |

Working:

| File | Screen |
| --- | --- |
| [V2-inbox](V2-inbox.dc.html) | Inbox: four metric cards and an overview first, what needs you with the reason, and one Decide for me for the rest |
| [V2-decision](V2-decision.dc.html) | One decision: the suggestion is already selected, with its reason |
| [V2-space](V2-space.dc.html) | Managing a space, in its own tinted area: metric cards and the overview, topics and owners by area at their real size, and an inspector for the selected area |
| [V2-conflicts](V2-conflicts.dc.html) | Managing a space: the conflict queue in compact mode, when nothing can be decided for you |
| [V2-changes](V2-changes.dc.html) | Managing a space: a batch change from a new version of a policy, grouped by kind of change |
| [V2-review](V2-review.dc.html) | Managing a space: a publish request, in compact mode |
| [V2-publish](V2-publish.dc.html) | Publishing from My space: one question per source, with the suggestion selected |
| [V2-trace](V2-trace.dc.html) | Trace view of one topic, for its owner: facts first, then the pages that use them, the rest folded by document |
| [V2-documents](V2-documents.dc.html) | Managing a space: documents and governance levels, set by folder |

## The chosen system (row D, in English)

Ink and paper, with the command palette from direction B and the ask bar from direction C.
Only the screens the second version has no counterpart for are kept here.

| File | Screen |
| --- | --- |
| [D-system](D-system.dc.html) | Design tokens and components |
| [D-signin](D-signin.dc.html) | Sign in and choose a company |
| [D-apps](D-apps.dc.html) | Apps with access and the consent screen |

## The demo story (row E, in Chinese)

Documents come first, in their original form, and knowledge appears on top of them step by
step. Owners at every level see the structure in the Trace view. The canvas tells its demo
story in Chinese, but Chinese is one of the three languages the product serves, not the default
(see Internationalisation in [UI principles](../ui-principles.md)). Only the screens the second
version has no counterpart for are kept here.

| File | Screen |
| --- | --- |
| [E-doc](E-doc.dc.html) | After importing: the document first, in its Original view |
| [E-doc-layers](E-doc-layers.dc.html) | From document to knowledge: the Annotated view and What this says |
| [E-doc-knowledge](E-doc-knowledge.dc.html) | The Knowledge view of a document: what each section became, where it is used, and how it relates to other documents |
| [E-model](E-model.dc.html) | The knowledge model: an explanatory diagram, not a product screen |
| [E-topic](E-topic.dc.html) | Topic page, as a reader sees it |
| [E-procedure](E-procedure.dc.html) | Procedure, as a reader sees it |
| [E-dark](E-dark.dc.html) | Dark theme: its tokens are kept, but it is not in the first release |
| [E-i18n](E-i18n.dc.html) | The three languages side by side: the interface follows the person, and content keeps the space's language |

## What is not copied

- **First-version screens the second version replaces.** Removed from this folder on
  2026-10-27; they stay on the canvas, and git history keeps the copies. The table below
  names the screen that replaces each.
- **Rows A, B and C.** These are the three directions compared on 2026-10-23: A is ink and
  paper, B the graphite workbench, C the highlighter studio. D was built on A, keeping B's
  command palette, inspector and compact mode and C's ask bar. The three rows stay on the
  canvas, for reference only.
- **More Japanese screens.** V2-ja shows a knowledge page in Japanese. The other key screens in
  Japanese wait until the Japanese terms are reviewed; E-i18n shows the three languages side by side.

| Removed | Replaced by |
| --- | --- |
| D-home | [V2-home](V2-home.dc.html) |
| D-steward | [V2-review](V2-review.dc.html), [V2-conflicts](V2-conflicts.dc.html) |
| D-inbox | [V2-inbox](V2-inbox.dc.html) |
| D-search | [V2-search](V2-search.dc.html) |
| D-connections | [V2-sources](V2-sources.dc.html) |
| D-space | [V2-space](V2-space.dc.html) |
| D-review | [V2-review](V2-review.dc.html) |
| D-conflicts | [V2-conflicts](V2-conflicts.dc.html) |
| E-page | [V2-page](V2-page.dc.html) |
| E-trace | [V2-trace](V2-trace.dc.html) |
| E-trace-topic | [V2-trace](V2-trace.dc.html) |
| E-sources | [V2-documents](V2-documents.dc.html) |
| E-inbox | [V2-inbox](V2-inbox.dc.html) |
| E-mobile | [V2-phone](V2-phone.dc.html) |
| E-solo | [V2-switcher](V2-switcher.dc.html) |
| E-publish | [V2-publish](V2-publish.dc.html) |
| E-admin | [V2-admin](V2-admin.dc.html) |
| E-changes | [V2-changes](V2-changes.dc.html) |

## Terms as of this snapshot

The first version's Chinese screens call owners 负责人 (空间负责人, 主题负责人, and so on).
On 2026-10-26, 维护人 was proposed in its place and is waiting for the product owner; the second
version uses 维护人 until then. See the glossary in
[UI principles](../ui-principles.md) and section 4 of the [overview](../../overview.md). The
screens stay as drawn and change when the canvas does.
