# Documentation

Start with the [overview](overview.md); the table below says where to go for a given question.
Every doc here has a Chinese copy at the same path under [zh/](zh/README.md). Each design doc
opens with a one-sentence status line that also says what is built, then its conclusions; its
history is in "About this page" at the end. This index repeats the status, and
`test/docs.test.ts` checks that the two agree.

| Status | Meaning |
| --- | --- |
| Adopted | Decided by the product owner; build to it |
| Proposed | Waiting for the product owner's decision |
| Superseded | Replaced; kept only while its history matters, with a link to what replaced it |
| Reference | Describes what is built |

When a doc is replaced, the pull request that replaces it deletes it (git history keeps it)
or marks it superseded, and updates this index (see "Keeping the repo small" in
[AGENTS.md](../AGENTS.md)).

| If you want to know | Read |
| --- | --- |
| What the product is, for whom, and why | [Overview](overview.md), Part I |
| What is being built now, and what was left out | [The MVP](design/mvp.md) |
| What has been decided, and what is still open | [Decisions and open questions](decisions.md) |
| What has been proven, and at what cost | [Validating the knowledge core](design/validation.md), "Where we stand" |
| How the system is put together | The overview's [Architecture at a glance](overview.md#9-architecture-at-a-glance), then [Architecture](architecture.md) |
| How to build, test and run it | [Development](development.md) |
| How to continue from earlier agent work without reviving old plans | [Development: Continuing work](development.md#continuing-work) |
| Why one area works the way it does | Its design doc below |

## Start here

| Doc | Status | What it covers |
| --- | --- | --- |
| [Overview](overview.md) | Version 2, 2026-10-27; brought up to date 2026-11-05 | Product requirements and the architecture at a glance: scenarios, diagrams, feasibility, what is built and planned |
| [Decisions and open questions](decisions.md) | Kept current, 2026-11-12 | The product owner's decisions in force, by date, and the questions still open |
| [The MVP](design/mvp.md) | Adopted, 2026-11-05 | A usable product that closes the business flow for one company: scope, slices and decisions |
| [Validating the knowledge core](design/validation.md) | Adopted, 2026-11-05 | How extraction and governance are measured on real documents, and the results so far |

## How it is built

| Doc | Status | What it covers |
| --- | --- | --- |
| [Architecture](architecture.md) | Reference | Each part of the system: the two layers and the request path, components and events, the knowledge model, governance, storage, permissions, connectors, models and agents, search, languages, how it is built and deployed |
| [Contracts](contracts.md) | Reference | Changing schemas, code generation, IDs, events, versioning |
| [PageSpec and views](pagespec.md) | Reference | How pages match Claude Artifacts, and the view sandbox |
| [Development](development.md) | Reference | Continuing earlier work, delivery, paid-run preflight, and building, testing and running from source |
| [Licensing](licensing.md) | Reference | Licences of the stack and what they mean for delivery |

| [Local validation](local.md) | Reference | Persistent local startup, Confluence Data Center / Server and Feishu connections, DeepSeek, validation and troubleshooting |

## Designs: knowledge

| Doc | Status | What it covers |
| --- | --- | --- |
| [Statements at scale](design/statements-at-scale.md) | Adopted, 2026-10-24 | Two outlines, fact slots, governance levels and grouped review |
| [Source changes](design/source-changes.md) | Adopted, 2026-10-26 | Corrections, deletions and large changes in sources, and when a person is asked |
| [Knowledge and language](design/knowledge-and-language.md) | Adopted, 2026-10-26 | Knowledge is language-neutral: translations, cross-language merge, pages per language |
| [Permissions in compiled knowledge](design/compiled-knowledge-permissions.md) | Proposed, 2026-10-26 | How pages, procedures and answers use material part of their audience cannot read |
| [Code repositories as a knowledge source](design/code-repositories.md) | Proposed, 2026-10-27 | A local mirror and code graph of each repository as an input of Deep Research |

## Designs: business layer

| Doc | Status | What it covers |
| --- | --- | --- |
| [Business layer](design/business-layer.md) | Adopted, 2026-10-24 | Accounts, companies, publishing and approvals above the engine |
| [Business layer and engine contract](design/business-engine-contract.md) | Adopted, 2026-10-24 | The contract between the two layers and the schema changes it needs |
| [Decide for me](design/decide-for-me.md) | Adopted, 2026-11-05 | Every decision a person makes can be handed to the assistant |

## Designs: UI

| Doc | Status | What it covers |
| --- | --- | --- |
| [UI philosophy](design/ui-philosophy.md) | Adopted, 2026-11-05 | One philosophy every screen follows, from the stance down to where each element goes |
| [UI principles](design/ui-principles.md) | Adopted, 2026-10-24 | Who the UI serves, interaction principles, visual design, glossary |
| [UI screens](design/screens/README.md) | Snapshot of the design canvas | Static copies of the canvas's screens, to read next to the docs |

## Outside research

| Doc | Status | What it covers |
| --- | --- | --- |
| [Outside evidence](outside-evidence.md) | Reading notes, 2026-11-05 | Research from outside the project, read against our own results: what each work shows, how it bears on our claims, its limits |
