# Documentation

Start with the [overview](overview.md); the table below says where to go for a given question.
Every doc here has a Chinese copy at the same path under [zh/](zh/README.md). Each design doc
opens with a status line, this index repeats it, and `test/docs.test.ts` checks that the two
agree.

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
| What has been proven, and at what cost | [Validating the knowledge core](design/validation.md), "Where we stand" |
| How the system is put together | [Architecture](architecture.md), then the overview's Part II |
| How to build, test and run it | [Development](development.md) |
| Why one area works the way it does | Its design doc below |

## Start here

| Doc | Status | What it covers |
| --- | --- | --- |
| [Overview](overview.md) | Version 2, 2026-10-27; brought up to date 2026-11-05 | Product requirements and technical architecture in one document: scenarios, diagrams, feasibility, what is built and planned, open questions |
| [The MVP](design/mvp.md) | Adopted, 2026-11-05 | A usable product that closes the business flow for one company: scope, slices and decisions |
| [Validating the knowledge core](design/validation.md) | Proposed, 2026-10-27 | How extraction and governance are measured on real documents, and the results so far |

## How it is built

| Doc | Status | What it covers |
| --- | --- | --- |
| [Architecture](architecture.md) | Reference | Engine and business layer, components, how they talk, storage, security |
| [Contracts](contracts.md) | Reference | Changing schemas, code generation, IDs, events, versioning |
| [PageSpec and views](pagespec.md) | Reference | How pages match Claude Artifacts, and the view sandbox |
| [Development](development.md) | Reference | Building, testing and running everything from source: the stack, the checks, the bench, the demo |
| [Licensing](licensing.md) | Reference | Licences of the stack and what they mean for delivery |

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
| [UI philosophy](design/ui-philosophy.md) | Proposed, 2026-10-27 | One philosophy every screen follows, from the stance down to where each element goes |
| [UI principles](design/ui-principles.md) | Adopted, 2026-10-24 | Who the UI serves, interaction principles, visual design, glossary |
| [UI screens](design/screens/README.md) | Snapshot of the design canvas | Static copies of the canvas's screens, to read next to the docs |

## Outside research

| Doc | Status | What it covers |
| --- | --- | --- |
| [Outside evidence](outside-evidence.md) | Reading notes, 2026-11-05 | Research from outside the project, read against our own results: what each work shows, how it bears on our claims, its limits |
