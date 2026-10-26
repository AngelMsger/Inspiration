# Source changes: deletions and large changes

Status: adopted design, 2026-10-26, from the product owner's comments on the overview. Not built yet, except where a section says so. Thresholds and time limits are defaults that can change after the prototype measures them. A Chinese copy is in [docs/zh/design/source-changes.md](../zh/design/source-changes.md).

## Summary

Sources change all the time: a value is corrected, a policy gets a new version, a document is deleted, a folder is reorganized, an app loses access to a wiki space. Four rules decide what the engine does and when a person is asked:

1. **Knowledge that entered the system never disappears silently.** Every removal is either decided by a person or recorded as a default that a person can see and undo.
2. **A source that corrects itself syncs silently.** Only sources that disagree with each other need a person, and that person sees how many sources say what.
3. **A deleted source document keeps its knowledge,** marked "Source deleted", and its owner is asked once: keep it as a snapshot, point it to a replacement document, or retire it.
4. **A large change is reviewed as one change,** never as a flood of todos.

## How the layers relate

The engine keeps three layers. Only the first follows the source, and only in one direction.

| Layer | What it holds | Who changes it | When the source changes |
| --- | --- | --- | --- |
| Source versions | An immutable copy of every version of each external document, as blocks with stable anchors (Feishu block IDs, page and paragraph for files), and a deletion marker when the document is gone | Only source sync, one way, from the source | A new version is appended. Earlier versions stay |
| Knowledge | Statements with verbatim evidence, fact slots, topics, pages and procedures | Only the pipeline, derived from source versions and from people's decisions | Only changed blocks are read again. Statements are closed (superseded or retracted), never deleted |
| People's work | Comments, corrections (overrides), decisions, precedence rules, statements a person asserts | People | Re-anchored. A correction the source now agrees with retires. One the source contradicts gives its author a todo. A comment whose anchor is gone becomes orphaned and is shown beside the page, never dropped |

Nothing is ever written back to the source. However far people's work moves away from a source, the system's copy of the source still equals the source, and every difference lives in people's work with an author and a date. So a sync is always the same three steps: append the new version, derive knowledge again where blocks changed, and re-anchor people's work.

Built: source versions, block anchors and the knowledge layer. Comments, corrections and re-anchoring exist as contracts (`Anchor`, `Override`, `CommentStatus.orphaned`, `TodoKind.override_conflict`) but are not built yet.

## Changes within one source

When a source changes its own value (A becomes B), the engine treats it as the source's own fix. The new statement supersedes the old one in the same fact slot, the slot keeps a single value, and nobody is asked. The Trace view keeps both, with the dates each was true. This is built: extraction supersedes the closed statement with the new one, and governance asks for nothing when a slot has one value.

The one exception is a person's work on that value. If someone corrected it or decided a conflict about it, that person gets one todo: keep their correction or follow the source.

## Disagreement between sources

Two or more current sources stating different values for one fact slot is a conflict for a person, as today. The conflict todo now also shows the support for each value:

> 9 documents say 500 (1 policy, 8 meeting minutes); 1 document says 600 (the price list).

Support counts distinct documents. A copy of a document counts once, using the exact and near-duplicate detection that normalization already does. Each value shows the authority and governance level of its documents. The count is only a hint: the proposed value still comes from authority and dates, because one governed policy outranks nine sets of minutes.

## When a source document is deleted

### What the engine does today

Source sync notices the deletion (webhook, a poll every 15 minutes, or the nightly reconcile) and writes a deletion marker version; earlier versions stay in history. Normalization marks the document deleted and its passages leave search. Extraction retracts the statements whose only evidence was that document (closed, never deleted). Governance decides each affected slot again: other sources keep their values, conflicts only that document caused are withdrawn, and a slot with no support left has no current value. Freshness forgets the document's review clock.

The gap: nobody is told. Long-governed knowledge can vanish from pages without anyone deciding it, which breaks rule 1.

### The design

1. **Check that it is a deletion.** When one sync finds more than 10% of a source's documents, or more than 50 documents, gone at once, the likely cause is lost access (the app was removed from a wiki space, a token expired), not deletion. Source sync then writes no deletion markers, pauses the source and gives the super admin one connection todo. Fixing the connection means nothing happened. Confirming the deletion turns it into one change set (see below). Where a source's API tells "deleted" apart from "no access", the reason is recorded on the version.
2. **Recognize moves, but only inside one permission boundary.** A document that disappears while a document with the same or nearly the same text appears in a connected source of the same company within 24 hours is a move candidate. Matching text shows that the two are the same document; it never decides who may see the work attached to it. The move completes silently (knowledge, people's work and decisions follow it, Trace records the move, nobody is asked) only when the new place is in the same domain, every reader of the new space could already read the old one, and the new sensitivity label is not lower. Otherwise the new document starts as a new document, with none of the old comments, corrections or decisions, and the old one follows the steps below; its todo offers to carry people's work over, which is a publish request under the existing rules (see [Business layer and engine contract](business-engine-contract.md)): approved by the owner of the new space and by the owner of every space whose audience the move widens. Between My space and a shared space it is always a publish, never a move.
3. **Keep everything until someone decides.** Statements stay current and their evidence still opens the last version. Citations and the Trace view show "Source deleted on 20 October". The page text keeps its only two marks, Outdated and Disputed. A company setting can hide such knowledge until a decision instead (`source_deleted: keep | hide`, default keep), for companies where a deletion often means the document was withdrawn.
4. **Ask only about what lost all support.** Lineage tells which statements still have evidence elsewhere: those are decided again silently. Only statements whose only evidence was the deleted document, and the pages and procedures that cite them, go into the todo. If there are none, there is no todo.
5. **One todo per deleted document or folder, per owner.** It goes to the owner of each affected topic and lists the topics, pages, procedures and statements involved. Deleting a folder of 30 documents gives each owner one todo, not 30. The owner chooses once for everything, or item by item:

| Choice | What happens |
| --- | --- |
| Keep as a snapshot (the default) | The last version becomes a snapshot source: frozen, with no connection, and a review date (by default the shortest review interval of its statements' classes). Statements stay current and cite the snapshot. Comments, corrections and decisions stay anchored to it. Citations show "Source deleted, kept as a snapshot" |
| Point to a replacement | The owner picks a document; the engine suggests the most similar ones. It is handled as a move: statements the new document supports carry over with people's work, and the rest are listed for the owner. The permission check of step 2 applies: a replacement with a wider audience, or in the other domain, carries people's work over only through a publish request |
| Retire | Statements whose only evidence was the document are retracted: closed, and still in Trace. Pages and procedures that cite them are rebuilt, and governance decides their slots again |

6. **Every choice is a record:** who decided, when, which choice, the version kept and an optional reason. It shows in the Trace view and in "Why this value?", so anyone can later see why the knowledge is still there or why it went.
7. **Nothing stays open forever.** With no decision after 30 days, the document is kept as a snapshot and recorded as "kept by default", with a review date. Keeping by default decides storage, never visibility: a snapshot stays in its space, with that space's audience and its last sensitivity label, and knowledge hidden while the todo was open (`source_deleted: hide`, or `source_restricted: quarantine` from the contract) stays hidden, shown in Trace as "kept by default, hidden". Showing it again is a decision of its own, recorded like the others: by the topic owner for `hide`, by the space owner for `quarantine`. If the document comes back in the source before a decision, the todo is withdrawn and nothing changed. After "keep", a restored document returns to normal sync and its history continues. After "retire", restored statements come back as new occurrences and are governed as usual.

By governance level:

| Level | Until a decision | Who is told |
| --- | --- | --- |
| Strict (governed) | Kept and marked | A todo for the owners of the affected topics |
| Loose (reference) | Kept and marked | One note on the space owner's weekly notes card, with "Retire" as a one-step action |
| Search only | Passages kept in search, marked | Nobody |

In My space the member is the owner of everything and gets these todos themselves.

## Large changes: one cause, one review

Some events touch hundreds of statements at once: a policy rewritten from version 3 to 4, a wiki space reorganized, a governance level changed for a whole folder, a connection that loses access. Spreading them into ordinary todos would flood owners' inboxes even within the weekly budget. So the inbox groups work by its cause.

- **Every todo request carries its cause.** The cause is the event's `correlation_id`: one sync run of a source, one folder deleted or moved, one new version of a document, one governance level change, one rebuild. Collaboration already uses it to put a copy review on the card of the conflict that caused it.
- **A large cause becomes a change set.** When one cause would produce more than one card's worth of todos (20), or touch more than 3 topics, its todos are held together as one change set instead of going onto weekly cards.
- **It goes to the owner of the smallest scope that covers it:** the topic owner within one topic, the space owner within one space, an owner the super admin names for changes across spaces, and the super admin for connection problems.
- **The review starts with what happened.** For example: "In Finance, the expense policy moved from version 3 to version 4: 41 values changed, 6 now disagree with other sources, 3 documents were deleted." Then counts by kind and by topic, samples, and the support for each disputed value.
- **Decisions are made in bulk.** Follow the sources for everything, keep everything, go through it topic by topic, or hand some topics to their own owners, which turns those parts into ordinary cards. Each item still gets its own decision record, which points to the change-set decision, so Trace never loses an item.
- **Readers see the same as with single todos** while the review is open: the last verified value marked Disputed, and deleted sources kept and marked.

Causes fall into three kinds, handled differently:

| Kind | Examples | What happens |
| --- | --- | --- |
| System | The app was removed from a wiki space, a token expired, many documents vanished at once | Not a knowledge change. Source sync stops before writing anything (the check in step 1 above), pauses the source and gives the super admin one connection todo. Once the connection is fixed, nothing happened. If the documents really were deleted, they become one change set |
| Engine | A prompt or model upgrade, re-extraction, re-clustering of topics | Must be silent while values stay the same: re-extraction that yields the same statements already asks nothing. If many values change, it is a quality regression: the run is held for evaluation by the engineering team and never reaches anyone's inbox |
| Content | A policy rewritten, a folder reorganized, a document split into several | A change-set review |

The first-review campaign that a new company gets on its first day (built) is the first case of this rule: its cause is the first connection of a source.

## Acceptance tests

The engine work is done when these fixtures pass, against the in-memory doubles and the stack:

| Case | Expected |
| --- | --- |
| A document is renamed or moved inside one space | Citations, comments, corrections and decisions follow it; Trace records the move; nobody is asked |
| A document disappears from My space and the same text appears in a shared space | Not a move. The shared copy is a new document without the member's comments, corrections or decisions. The member gets the deletion todo for the My space document, with publishing their work as one choice |
| A document moves from a restricted space to a space with a wider audience | Knowledge is built from the text again in the new space. People's work stays with the old space's snapshot, and the wider audience never sees it unless a publish request is approved |
| `source_deleted: hide` or `source_restricted: quarantine` is in force and 30 days pass without a decision | The snapshot is kept and stays hidden, recorded as "kept by default, hidden". Only the topic owner (`hide`) or the space owner (`quarantine`) can show it |

## Contract changes

All additive; see [docs/contracts.md](../contracts.md) for the process.

- `TodoKind` adds `source_deleted` and `change_set`.
- New `ChangeSet { id, tenant_id, cause { kind: sync | folder_deleted | folder_moved | connection_lost | new_version | level_changed | first_connection | rebuild, source_id?, correlation_id }, counts { by_kind, by_topic }, todo_ids, assignee_id, status: open | decided | split, decision_id? }`.
- `SourceVersion` gains optional `deletion_reason: deleted | no_access | moved` and `moved_to?: SourceRef`; `moved` is set only for a move that passed the permission check.
- Decision resolutions for `source_deleted`: `keep_snapshot`, `replace` (with a `SourceRef`) and `retire`. A `replace` that fails the permission check opens a publish request instead of carrying people's work over.
- `TenantPolicy` gains `sources { source_deleted: keep | hide }`.
- `ConflictCase` gains `support[] { value_key, documents, by_authority }`.

## Engine work

| Component | Change | Person-weeks |
| --- | --- | --- |
| source-sync | The mass-disappearance check, move detection with normalization's duplicates and the permission check (reusing the publish audience-gap check), the deletion reason | 0.5 |
| extraction | Hold retraction on deletion; retract on "retire"; carry statements over on a move or a replacement | 0.5 |
| freshness, collaboration | The `source_deleted` todo per document or folder and owner, the 30-day default, restore | 0.5 |
| governance | Support counts on conflict todos | 0.25 |
| contracts and tests | The changes above and the acceptance fixtures, against the in-memory doubles and the stack | 0.25 |
| collaboration | Change sets: grouping by cause above the threshold, bulk decisions with a record per item | 1 |
| **Total** |  | **3** |

## Terms

| Concept | UI term | 中文 | 日本語 (draft) |
| --- | --- | --- | --- |
| Source deleted | Source deleted | 原文已删除 | 原文は削除済み |
| Keep as a snapshot | Keep as a snapshot | 保留为快照 | スナップショットとして保持 |
| Point to a replacement | Replace with another document | 指向替代文档 | 別の文書に置き換え |
| Retire | Don't keep | 不保留 | 保持しない |
| Kept by default | Kept by default | 默认保留 | 既定で保持 |
| Change set | Change review | 批量变更审阅 | 一括変更レビュー |
| Support | 9 of 10 documents | 10 份文档中有 9 份 | 10 件中 9 件の文書 |
