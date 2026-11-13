# Drive and knowledge files

Status: proposed, 2026-11-13; the product owner has set the Drive direction, while file types, knowledge granularity and interactions below are proposals, and the current app has uploads and separate Documents and Knowledge views.

## Conclusions

**Drive is the product's layer for organizing and working with content.** The Documents tree manages files. Knowledge can become a named, reusable file at a useful granularity; original uploads can live alongside it. Finding, reading, asking, organizing and maintaining content belong in the same workflow.

The product owner's [decision](../decisions.md) establishes the Drive layer and file-based document management. The rest of this design proposes how to make that concrete:

- A file has a stable identity, a location and a type-specific reader. Folders organize files; source, topic and saved-filter views offer other ways to find the same items.
- Original material and compiled knowledge can sit in one folder. Their types explain which one to open, where its content comes from and how it updates.
- A knowledge file represents a useful question, procedure or subject. Its statements and evidence remain shared engine objects; organizing files does not duplicate facts.
- Everyday operations show their knowledge consequences: where a file is used, what an update affects, and what moving or removing it means.

Drive is a product concept here, not a final navigation label, a new knowledge domain or a decided engine component.

## Choices still to settle

| Choice | Proposed starting point | Reason |
| --- | --- | --- |
| Default knowledge-file granularity | A focused knowledge page; procedures and entity cards use the same file shell as their renderers become available | One useful reading or sharing unit without exposing every statement as a file |
| Original uploads | First-class files, with original bytes and readable extracted content | A failed or unsupported parse must not make the user's material disappear |
| Navigation | Drive within each space, with a company-wide entry that aggregates accessible spaces | Reuse spaces as the ownership and audience boundary |
| Materializing knowledge | Explicit creation from selected material, a topic or a cited answer; the assistant suggests title, scope and destination | Avoid an automatically growing directory of tiny generated files |
| Initial delivery | One upload-to-knowledge-file workflow before advanced saved collections or new card renderers | Validate the full interaction before adding more file kinds |

These are proposals for review, not additions to the adopted MVP gates. The interface name and Japanese wording remain open.

## Content hierarchy and identity

The proposed organization is `Company → Space → Folder → File`. The personal library and My space use the same interaction vocabulary when delivered, within their existing separate domains. A company-wide Drive lists only content the member can access; it does not become a shared root that grants access.

Each file has one canonical location and a stable link. Renaming or moving it within its space changes the location, not its identity, versions or citations. A shortcut places a reference elsewhere without copying content. Topics describe meaning and responsibility; folders describe where a person put something. One does not silently rewrite the other.

Documents becomes the file hierarchy view. Knowledge remains a topic-oriented view of the knowledge behind those files, including knowledge not yet materialized as a file. They are navigation paths into related objects, not two independent copies to maintain.

The original provider's hierarchy is also available as a source view. Local organization does not rename, move or delete anything in Feishu or Confluence. An upstream move changes the displayed source path; an explicit local placement stays where its member put it.

## What a file represents

| Kind | Opens as | Content and update behavior |
| --- | --- | --- |
| Uploaded material | Original preview, with Annotated and Knowledge views when available | Original bytes plus extracted content and version history; replacement is an explicit new version |
| Connected document | Imported original with an upstream link and sync state | A representation of one source document; refresh follows the connection, and local organization is independent |
| Knowledge file | A cited page, procedure or entity card | A saved scope and presentation over governed statements, with its own revisions and named owner |
| Shortcut | The target, with a route back | A reference to the same file; no new evidence, authority, audience or content version |

Folders and saved collections are containers and views, not evidence. A saved collection reruns a filter such as “Travel knowledge needing review”; membership changes do not move its files. A topic is not automatically both a folder and a knowledge file.

The common file shell offers name, location, type, owner, relevant dates, visibility and history. Actions depend on type: upload a version for an upload; refresh or open upstream for a connected document; inspect changes or propose a correction for knowledge. Do not label every kind “editable” because it has a file icon. Downloading original bytes and exporting a knowledge snapshot are different actions; an export records its revision, date and citations, and cannot stay live outside Inspiration.

## Knowledge granularity and materialization

Choose a boundary a person can name, read, maintain and reuse independently. “Travel reimbursement” can be a page; “Submit an expense claim” a procedure; “Shenzhen hotel rules” a smaller reference card. A single hotel limit normally stays inside one of these. An entire Finance space is normally a collection of files.

Materialize a single statement only when someone explicitly needs to reuse that fact on its own, keeping its conditions and evidence. A file that repeatedly needs unrelated sections, owners or review schedules should split; a set of fragments people always open together should combine. File size is a reading and maintenance decision, not the extraction chunk size.

“Create knowledge file” starts from selected files or passages, a topic, or a cited answer. Its creation panel shows:

1. A suggested name and destination, with the destination's visible audience.
2. The question or subject it covers, selected source material, and any excluded material.
3. A preview with citations and any unresolved conflicts or unsupported conclusions.
4. How it updates: follow this saved scope, or keep a dated snapshot with a review date.

A selection of files follows those file identities and their later versions. A topic-based scope may gain relevant evidence as the topic changes; a snapshot never does. The creation panel states that difference. Source discovery, governance and publication retain their existing rules; “follow updates” does not approve a disputed fact or expand the audience.

Saving creates the file's identity, scope and first revision. Subsequent synthesis creates revisions, preserving manual overrides and the evidence used by each revision. A snapshot fixes the supported statements and source versions at creation; it does not acquire permission to expose them elsewhere.

An answer's citation is not sufficient to make every sentence verified knowledge. Saving an answer keeps the evidence-backed content; unsupported content remains an explicit draft or proposal. A knowledge file must not be ingested again as independent evidence for the same statements. Translation, a shortcut, an export or a presentation copy does not become another source supporting a fact.

## The Drive surface

Drive follows the [UI philosophy](ui-philosophy.md): the existing company bar, space navigation, centre and selection panel. It belongs to the ordinary reading and working area. Space maintenance, Admin and Account retain their own places.

In a space, the centre opens with breadcrumbs, search within this location, and the primary action for the context. Recent and starred items provide short paths; All files, Original material and Knowledge are views over the same inventory. A folder can mix kinds. A file row shows its type, title, relevant update date and the exception that matters; source, owner and other columns are available in compact view. A folder view can briefly say what changed and what needs attention, based on real counts.

Selecting a row previews it in a panel without leaving the list. Opening it enters its reader. The panel offers content, sources, uses and activity as needed for that type. A knowledge file links to its evidence; a source links back to the knowledge that uses it. Returning restores the list's filter, scroll position and selection. A citation still opens its exact passage and version, not simply the latest file.

The left column locates the space and folder. Search, filters, sort and view controls stay above the centre. No persistent chat panel is required: “Ask about this” uses the selected file, selection or folder as an explicit scope and opens a cited answer in context. It must say when that scope has insufficient evidence.

## Everyday interactions

| Task | Interaction and feedback |
| --- | --- |
| Upload files or a folder | Drop onto a clearly highlighted destination or use the upload button. Preserve relative paths. Show transfer separately from parsing, indexing and reading, with per-file retry and a persistent result after navigation |
| Resolve a duplicate | Explain whether it is the same content, a possible new version or only a matching name. Offer skip, upload a version, or keep both; a name alone never silently overwrites a file |
| Browse and preview | Click or use arrow keys to select; Enter opens and Escape closes the preview. Keep native links available for opening in another tab. Restore position after reading |
| Organize | New folder, rename, move, star and shortcut are reachable from a menu and keyboard. Dragging highlights the destination and names the operation before drop; dragging is never the only route |
| Work on a selection | Checkbox, range and keyboard selection reveal a batch toolbar. Show how many items are selected and whether that means this page or all matching results. Report partial failures and retry failed items only |
| Create knowledge | From a selection, open the scope-and-preview panel above. Saving returns to the new knowledge file with links to its inputs; leaving the creation panel preserves the draft |
| Understand an update | “Source changed” opens a difference and the affected knowledge. Distinguish syncing, awaiting review, and the published revision the reader currently sees |
| Ask in context | Show the selected scope next to the question. Offer saving supported results as a knowledge file without losing their citations |
| Organize with the assistant | Show a proposed set of names and destinations with a reason. Apply on the member's request within their rights, with an activity record and undo; autonomous suggestions do not move files |
| Remove or restore | Distinguish removing a shortcut, moving a file to Trash and retiring its knowledge. Show dependencies before a consequential removal; restore uses the old location if available, otherwise asks for a destination |

Undo names the action it reverses. A content rollback creates a new revision. It does not remove intervening history or silently overwrite another member's newer work. Concurrent edits and moves are checked against the revision the member saw; a stale action refreshes the affected items and explains what changed.

## Boundaries that interactions must preserve

**Visibility follows the existing domain and space rules.** Shortcuts, collection membership, search snippets, dependency counts and preview panels never reveal inaccessible targets. A shortcut grants no access. Source-app access and Inspiration access remain distinct; Drive does not reintroduce an intersection of every source's ACLs. The unresolved [compiled-knowledge permissions](compiled-knowledge-permissions.md) trade-off stays unresolved.

**Moving can affect more than location.** Within a space, an ordinary move preserves identity and references. If a destination changes inherited governance level, show the effective change and resulting reading or review work before applying it, keeping explicit overrides. Moving shared content to another space goes through the applicable audience and sensitivity checks. Moving from My space to a shared space is publishing. Drag-and-drop opens that workflow and never bypasses it; cross-company movement is outside the initial slice.

**Removing a file does not erase facts.** Removing a shortcut affects only the shortcut. Trash removes the file from ordinary browsing and search, but retains versions and authorized evidence links. Existing supported knowledge stays governed until an explicit retirement decision closes the affected statements; other supporting sources still count. The impact panel offers the established keep-snapshot, replacement and retirement choices where applicable. Upstream deletion follows [Source changes](source-changes.md), including grouped review. Permanent erasure and retention policy need a separate design.

**Storage, processing and knowledge health are separate.** “Uploaded” does not mean parsed, searchable, read or verified. An unsupported file remains downloadable with its reason; a failed parse offers retry. A successfully parsed file may still have disputed knowledge. Folder summaries and filters preserve these distinctions without putting every state on every row.

## Implementation boundary and migration

The existing app supplies a useful starting point: [Documents](../../apps/web/src/documents.tsx), [uploads](../../apps/web/src/upload.tsx), [topic reading](../../apps/web/src/knowledge.tsx), [routes](../../apps/web/src/route.tsx), and the contracts for [sources](../../libs/contracts/schema/source.yaml), [document reads](../../libs/contracts/schema/api.yaml) and [pages](../../libs/contracts/schema/page.yaml). Today Documents is organized by source and path; there is no general Drive inventory with independent file placement or persisted knowledge files.

The implementation must first distinguish source identity, source version, local file location, knowledge identity and rendered revision. A file's path must not become its evidence key. Introduce mappings for existing uploads and connected documents, retain old document and citation links, and test rename, move and upstream resync before adding writes to the UI. Existing topic navigation must keep working while knowledge-file materialization is introduced.

Persist file metadata and placement separately from original bytes, evidence and compiled content. Every list and operation passes the existing AuthZ boundary. Model work remains in the engine through ModelGateway; the business backend supplies the member's context and the web app never reaches the engine directly. Component ownership, additive schemas and migration mechanics are implementation proposals to resolve before building, not new modules authorized by this document.

## First slice and acceptance

The proposed first slice is one complete loop: upload travel materials into a folder, preview and organize them, create one cited knowledge page, follow a new source version, and return to the affected knowledge. It includes real persistence, stable links, rename and move, selection and preview, explicit update and removal semantics, and recoverable processing errors. Advanced collections, new entity-card renderers and cross-space publishing UI can follow their underlying capabilities.

Use these scenarios to review the interaction and later test the implementation:

1. Upload a folder containing a valid document and an unsupported file. Both remain visible; paths survive; only eligible content becomes searchable or usable as evidence. Retry does not duplicate successful uploads.
2. Create “Travel reimbursement” from two documents. The file shows scope, owner, update mode, citations and current status. Materialization creates no duplicate statements or circular evidence.
3. Rename and move the source, then sync it again. The source appears once in its chosen local location. An old answer citation and both directions of source-to-knowledge navigation still work.
4. Replace a source with a changed hotel limit. The original version remains readable; affected knowledge shows the pending change or new governed revision as appropriate. A manually pinned override is preserved and reviewed if contradicted.
5. Move a file into a folder with a different governance level. The member sees the effective policy change and impact. A mixed-permission batch reports failed items without claiming the whole batch succeeded.
6. Open Drive as a member with access to only one space. Search, counts, recents, shortcuts, previews and dependency panels reveal nothing from another space. A publish action uses the established approval flow.
7. Trash a source used by knowledge, then restore it. Ordinary browsing changes, historical citations still resolve for authorized readers, and knowledge is not silently retracted. Removing a shortcut leaves the target untouched.
8. Navigate a space with 3,000 documents and a large case with 50,000. Load folders lazily, page search results and virtualize long visible lists. Preserve selection and avoid a full-tree load per action. Measure p95 list, search and preview time on the local validation machine before setting performance targets.
9. Complete browse, selection, rename and move without a pointer, in English, Chinese and Japanese. Focus stays predictable, screen readers announce operation results, and Enter during IME composition never submits an action.

## About this page

Written on 2026-11-13 from the product owner's direction that the whole product needs a Drive layer, the document tree should manage files, knowledge may be materialized at a chosen granularity as special files, and original uploads may be files too. It extends the existing document-first design with a proposed content-management model and concrete interactions. The direction is recorded in [Decisions](../decisions.md); detailed adoption and delivery order remain open. A Chinese copy is in [docs/zh/design/drive.md](../zh/design/drive.md); if the two differ, this English version wins.
