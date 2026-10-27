# Documentation

Start with the [overview](overview.md). Every doc here has a Chinese copy at the same path
under [zh/](zh/README.md). Each design doc opens with a status line, this index repeats it,
and `test/docs.test.ts` checks that the two agree.

| Status | Meaning |
| --- | --- |
| Adopted | Decided by the product owner; build to it |
| Proposed | Waiting for the product owner's decision |
| Superseded | Replaced; kept only while its history matters, with a link to what replaced it |
| Reference | Describes what is built |

When a doc is replaced, the pull request that replaces it deletes it (git history keeps it)
or marks it superseded, and updates this index (see "Keeping the repo small" in
[AGENTS.md](../AGENTS.md)).

## Start here

| Doc | Status | What it covers |
| --- | --- | --- |
| [Overview](overview.md) | Version 2, 2026-10-27 | Product requirements and technical architecture in one document: scenarios, diagrams, feasibility, what is built and planned, open questions |

## Engine reference

| Doc | Status | What it covers |
| --- | --- | --- |
| [Architecture](architecture.md) | Reference | Engine and business layer, components, how they talk, storage, security |
| [Contracts](contracts.md) | Reference | Changing schemas, code generation, IDs, events, versioning |
| [PageSpec and views](pagespec.md) | Reference | How pages match Claude Artifacts, and the view sandbox |
| [Licensing](licensing.md) | Reference | Licences of the stack and what they mean for delivery |

## Design

| Doc | Status | What it covers |
| --- | --- | --- |
| [Statements at scale](design/statements-at-scale.md) | Adopted, 2026-10-24 | Two outlines, fact slots, governance levels and grouped review |
| [Business layer](design/business-layer.md) | Adopted, 2026-10-24 | Accounts, companies, publishing and approvals above the engine |
| [Business layer and engine contract](design/business-engine-contract.md) | Adopted, 2026-10-24 | The contract between the two layers and the schema changes it needs |
| [UI principles](design/ui-principles.md) | Adopted, 2026-10-24 | Who the UI serves, interaction principles, visual design, glossary |
| [Source changes](design/source-changes.md) | Adopted, 2026-10-26 | Corrections, deletions and large changes in sources, and when a person is asked |
| [Knowledge and language](design/knowledge-and-language.md) | Adopted, 2026-10-26 | Knowledge is language-neutral: translations, cross-language merge, pages per language |
| [Permissions in compiled knowledge](design/compiled-knowledge-permissions.md) | Proposed, 2026-10-26 | How pages, procedures and answers use material part of their audience cannot read |
| [UI philosophy](design/ui-philosophy.md) | Proposed, 2026-10-27 | One philosophy every screen follows, from the stance down to where each element goes |
| [Decide for me](design/decide-for-me.md) | Proposed, 2026-10-27 | Every decision a person makes can be handed to the assistant |
| [Code repositories as a knowledge source](design/code-repositories.md) | Proposed, 2026-10-27 | A local mirror and code graph of each repository as an input of Deep Research |
| [Validating the knowledge core](design/validation.md) | Proposed, 2026-10-27 | How extraction and governance are measured on real documents, and the results so far |
| [UI screens](design/screens/README.md) | Snapshot of the design canvas | Static copies of the canvas's screens, to read next to the docs |
