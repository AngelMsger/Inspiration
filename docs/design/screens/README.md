# UI screens

Status: a snapshot of the product owner's design canvas, "Inspiration UI"
(https://claude.ai/artifact/GYXc5GBY3bPq1XGuMUGwAk), taken on 2026-10-26 and updated on
2026-10-27. Screens are drawn and changed on the canvas. This folder holds a copy so reviewers
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

## The chosen system (row D, in English)

Ink and paper, with the command palette from direction B and the ask bar from direction C.

| File | Screen |
| --- | --- |
| [D-system](D-system.dc.html) | Design tokens and components |
| [D-home](D-home.dc.html) | Home with the ask bar |
| [D-steward](D-steward.dc.html) | Compact mode with the command palette |
| [D-signin](D-signin.dc.html) | Sign in and choose a company |
| [D-inbox](D-inbox.dc.html) | Inbox |
| [D-search](D-search.dc.html) | Search and ask results |
| [D-connections](D-connections.dc.html) | Admin: source connections |
| [D-apps](D-apps.dc.html) | Apps with access and the consent screen |
| [D-space](D-space.dc.html) | Space settings and roles |
| [D-review](D-review.dc.html) | Publish request review, in compact mode |
| [D-conflicts](D-conflicts.dc.html) | Conflict queue in compact mode, where the space owner decides |

## The demo story (row E, in Chinese)

Documents come first, in their original form, and knowledge appears on top of them step by
step. Owners at every level see the structure in the Trace view. The canvas tells its demo
story in Chinese, but Chinese is one of the three languages the product serves, not the default
(see Internationalisation in [UI principles](../ui-principles.md)).

| File | Screen |
| --- | --- |
| [E-doc](E-doc.dc.html) | After importing: the document first, in its Original view |
| [E-doc-layers](E-doc-layers.dc.html) | From document to knowledge: the Annotated view and What this says |
| [E-model](E-model.dc.html) | The knowledge model: an explanatory diagram, not a product screen |
| [E-topic](E-topic.dc.html) | Topic page, as a reader sees it |
| [E-page](E-page.dc.html) | Knowledge page, as a reader sees it, with a citation open |
| [E-procedure](E-procedure.dc.html) | Procedure, as a reader sees it |
| [E-trace](E-trace.dc.html) | Trace view grouped by outline, for the topic owner (option C in Statements at scale) |
| [E-sources](E-sources.dc.html) | Documents and their governance levels (option C) |
| [E-inbox](E-inbox.dc.html) | Inbox: source updates, deleted originals, support counts |
| [E-mobile](E-mobile.dc.html) | Phone |
| [E-dark](E-dark.dc.html) | Dark theme: its tokens are kept, but it is not in the first release |
| [E-solo](E-solo.dc.html) | Working alone, with no company |
| [E-publish](E-publish.dc.html) | Publish to a space, where the space decides who can read |
| [E-admin](E-admin.dc.html) | Admin: who can read, and the publish queue, in compact mode |
| [E-trace-topic](E-trace-topic.dc.html) | Trace view, topic overview, with thousands of statements |
| [E-i18n](E-i18n.dc.html) | The three languages side by side: the interface follows the person, and content keeps the space's language |
| [E-changes](E-changes.dc.html) | Change-set review, in compact mode |

## What is not copied

- **Rows A, B and C.** These are the three directions compared on 2026-10-23: A is ink and
  paper, B the graphite workbench, C the highlighter studio. D was built on A, keeping B's
  command palette, inspector and compact mode and C's ask bar. The three rows stay on the
  canvas, for reference only.
- **Japanese screens.** Japanese versions of the key screens are still to draw. For now,
  E-i18n shows the three languages side by side.

## Terms as of this snapshot

The Chinese screens call owners 负责人 (空间负责人, 主题负责人, and so on). On 2026-10-26,
维护人 was proposed in its place and is waiting for the product owner. See the glossary in
[UI principles](../ui-principles.md) and section 4 of the [overview](../../overview.md). The
screens stay as drawn and change when the canvas does.
