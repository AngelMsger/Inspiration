# Permissions in compiled knowledge

Status: proposed, 2026-10-26; not built, and its trade-offs wait for the product owner.

## Conclusions

- **A page, a procedure or a topic summary is written for its whole audience, never cut per reader.** The compiler uses only what everyone in the audience can read. Anything else is used only once the owner of its space releases it to that audience, one statement at a time.
- **A restricted input can never hide knowledge.** People set audiences, and using, linking or citing an input never narrows them. A fact with one readable proof stays visible, whatever other sources are added to it.
- **Nothing a reader sees is silently distorted.** When leaving an input out would change what a unit says (another value, a newer version, an exception, the other side of an argument), a person decides: ask for a release, rewrite without taking a position, or publish with a note that says whom to ask. An answer says when it may be incomplete.
- **`secret` material stays in its own space** and leaves no trace outside it.
- **About 3 person-weeks of engine work** ([Engine work](#engine-work)). The product owner has yet to confirm the trade-offs: readers learn that restricted material exists but never what it says, broad pages may say less until owners release statements, and owners get more work, within a budget ([Trade-offs to confirm](#trade-offs-to-confirm)).

## The problem

Inspiration compiles knowledge from many sources: a page, a procedure, a topic summary or an answer combines statements from documents in several spaces, and the readers of the result can each read a different set of spaces. Two simple answers both fail.

- **Cutting per reader distorts.** Removing what a reader may not see from text written for someone else changes its meaning. If a source argues both sides and the reader is shown only one, the page leads the reader somewhere the source never went. A knowledge base whose promise is correctness cannot do that.
- **Blocking the whole unit is unusable, and can be abused.** Hiding a page because one input is restricted makes much of the knowledge base disappear for most people. Worse, anyone could hide a large body of knowledge by linking one trivial but tightly restricted item to it.

The design below keeps both promises: nothing a reader sees is silently distorted, and a restricted input can never hide knowledge it does not own.

## Principles

1. **People set audiences; inputs never do.** A compiled unit's audience is its space's audience, or a narrower one its owner picks. Using, linking or citing an input never narrows who can read the unit.
2. **Write for the audience; never cut per reader.** The compiler writes a unit only from inputs its whole audience can read, at their clearance. An input outside that audience is either released for it, one statement at a time, or not used.
3. **An omission that changes the meaning needs a person.** The engine sees every input. When it leaves an input out for an audience, it checks whether the input would change what the unit says. If so, the unit is not published silently: a person decides.
4. **Readers are told, never misled.** Where something that matters was left out, the reader sees a note in its place that says so and whom to ask, never the content. Silent gaps are not allowed inside a unit the reader can see.
5. **Secret material stays home.** Material labelled `secret` is never an input to anything outside its own space, and nothing outside that space hints that it exists. Its owner can release a single statement on purpose.
6. **Alternatives only add visibility.** A statement with several independent proofs is visible if any one of them is readable, so adding a restricted source to a known fact never hides it.

## How it works

### Writing a unit for its audience

When the page compiler builds a page, a procedure or a topic summary, it splits the candidate statements into those the unit's audience can read and those it cannot. It writes only from the first group. Each statement in the second group is one of:

- **Released.** The owner of the space it comes from has released it to this audience (a release, below). It is then used like any other statement, with its label.
- **Redundant.** The audience can already read another proof of the same statement, or the statement adds nothing the unit says. It is dropped without a trace.
- **Omitted.** Neither of the above. The compiler checks whether leaving it out changes the meaning (next section).

A procedure is all or nothing: it is published only when its audience can read, or has been released, every step. Readers never get a procedure with a missing step.

### The omission check

Leaving an input out changes the meaning when the input:

- states a different value for a fact slot the unit uses (a conflict the audience cannot see),
- is a newer version that supersedes what the unit says,
- adds a condition or an exception to it, or
- argues the other side of a point the unit makes.

The first three are found from the knowledge model (slots, supersession, qualifiers) without a model. The last needs a model check (`page_compiler.check_omission`, with a deterministic mock in the prototype). An omission that changes nothing, such as background or extra detail, passes silently.

When an omission does change the meaning, the unit gets one todo, grouped into its owner's weekly card like any other, with three choices:

1. **Ask for a release** of the omitted statements. The owner of their space decides.
2. **Rewrite without taking a position** on that point, for example "approval limits differ by department; see Finance". The compiler proposes the wording.
3. **Publish with a note.** The section shows "Some material on this point is in a space you cannot open. Ask the Finance space owner." Readers who can read the material see the full section instead.

The todo goes to the unit's owner, except when the omitted material is `secret`: then it goes to the owner of the secret material's space, who alone may know about it, and who can release a correction or leave the unit as it is.

### Releases

A release opens one statement to one audience, not a space. It records the statement, the space it comes from, the target audience, who approved it and when; that record becomes a proof the audience can read. The released text is the statement; its evidence quote stays behind unless the release includes it. A later change to the statement or a narrowing of its space gives the approver a todo to keep or withdraw the release. This is the "crossing audiences" approval of the business-engine contract, made per statement and given a name.

### Answers

An answer is written for one asker, from what that asker can read, so it is never cut down. Before it is returned, the same omission check runs against what the engine knows outside the asker's reach. If relevant material would change the answer, the answer says that it may be incomplete and names whom to ask, at `internal` and `confidential`. For `secret` material it says nothing. An answer never claims to be complete when it is not.

### The per-reader safety net

Per-reader checks still run on every read, as a guarantee rather than as the way units are shaped. They act only on whole items: a document, a block, a statement in a list, a row in a table, a search result. They never remove words inside prose. When a check would have to remove part of a paragraph, for example after an audience changed between compiling and reading, the unit is compiled again for that reader's set of readable spaces and cached for everyone who shares the set.

### Documents

A document is visible whole or not at all, as in the app it comes from. When part of a document carries a higher label (a confidential appendix), that part is its own unit: a reader without clearance sees a line saying a section is restricted, never a document with a silent hole.

## Abuse and accidents

| Someone… | What happens |
| --- | --- |
| Links a trivial, tightly restricted note to a widely read topic | Nothing disappears. The note is not used for the wider audience, and the topic's owner sees it in the unit's list of inputs not used |
| Cites a secret document from a shared page | It is not used and leaves no trace. If it contradicts the page, the secret space's owner gets the todo |
| Raises the label of a widely used source, or narrows a space | An authorized change, so it takes effect. Before saving, the person sees how many units and readers it affects. Affected units are compiled again, and those whose meaning changes get the omission todo. It is audited |
| Adds a restricted copy of a public fact | The fact stays visible through its public proof |

## Acceptance tests

| Case | Expected |
| --- | --- |
| A page for all staff draws on a public document arguing against a policy change and a Finance-only memo arguing for it | The omission check fires. The page owner gets one todo. The page is never published showing only one side without a note |
| A trivial restricted note is linked to a topic read by 300 people | No unit, statement or section disappears for anyone |
| A fact is stated in a public document and a restricted one | Every reader of the public document sees the fact |
| A margin from a Sales price and a Finance cost would appear on an all-staff page | Not used unless Finance releases it. Nothing else on the page changes |
| A secret document contradicts a shared page | The shared page shows nothing about it. The secret space's owner gets the todo |
| A reader asks a question whose answer differs in a space they cannot read (confidential) | The answer says it may be incomplete and names whom to ask, without the other value |
| An audience narrows between compile and read | The reader gets a page compiled for their readable spaces, never a paragraph with words missing |
| A document has a confidential appendix | A reader without clearance sees the document with a "section restricted" line where the appendix was |

## Contract changes

All additive; see [docs/contracts.md](../contracts.md) for the process.

- `PageSpec` blocks gain optional `omissions[] { reason, ask_space_id }`, rendered as the reader's note.
- A `Release { statement_id, from_space_id, to_space_id, include_quote, approved_by, approved_at }` record, usable as a proof.
- `Answer` gains optional `incomplete { ask_space_ids }`.
- Each compiled unit keeps its inputs not used, with the reason (`not_readable`, `secret`, `redundant`), for its owner.
- Todo kind `omission_review` (collaboration) and model task `page_compiler.check_omission`.

## Engine work

| Component | Change | Person-weeks |
| --- | --- | --- |
| page-compiler | Compiling for an audience, the omission check with its mock, notes in pages | 1 |
| access-control, collaboration | Releases per statement, the omission todo, the impact preview before a label or audience change | 0.75 |
| retrieval | The incomplete-answer check | 0.5 |
| contracts, tests and evaluation | The changes above, the acceptance cases, and an evaluation set of balanced arguments and abuse cases | 0.75 |
| **Total** |  | **3** |

## Trade-offs to confirm

- **Readers learn that restricted material exists, but never what it says.** At `internal` and `confidential`, a note tells the reader that something relevant is in a space they cannot open, and whom to ask. Hiding even that would bring back silent gaps, which are worse for a knowledge base whose promise is correctness. Confluence, Notion and SharePoint show similar placeholders. At `secret`, nothing is revealed.
- **Broad pages may say less until owners release statements.** Owners see what was left out and why, so they can close the gaps that matter.
- **More owner work, bounded.** Omission todos arise only when meaning changes, and they share the weekly card budget.

## Terms

| Concept | UI term | 中文 | 日本語 (draft) |
| --- | --- | --- | --- |
| Release a statement to an audience | Release to | 放行到 | 公開を許可 |
| Note for omitted material | Some material here is in a space you cannot open | 此处有部分内容在你无法打开的空间里 | ここには閲覧できないスペースの資料が含まれます |
| Possibly incomplete answer | May be incomplete | 可能不完整 | 不完全な可能性があります |
| Inputs not used | Not used for this audience | 未用于这一受众 | この対象には未使用 |

## About this page

Proposed on 2026-10-26, in answer to the product owner's comment on the overview. [Architecture](../architecture.md#permissions) already follows it; its trade-offs are [open question 2](../decisions.md#open-questions). A Chinese copy is in [docs/zh/design/compiled-knowledge-permissions.md](../zh/design/compiled-knowledge-permissions.md); if the two differ, this English version wins.
