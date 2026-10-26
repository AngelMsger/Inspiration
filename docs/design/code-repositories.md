# Code repositories as a knowledge source

Status: proposed, 2026-10-26, for the product owner's decision. Nothing here is built. It answers the product owner's question: can code repositories be a source of knowledge in Inspiration, is there any point when coding agents already read raw code and hosted Git, and if so, how. A Chinese copy is in [docs/zh/design/code-repositories.md](../zh/design/code-repositories.md); if the two differ, this English version wins.

## Summary

**Code belongs in Inspiration as the most exact witness of what the product does, not as code to be explained.** Inspiration explains the product; code tools explain code. A repository becomes one more source, read through the same pipeline as a Feishu wiki, for three purposes:

1. **Behavior.** A few chosen paths (limits, plans, permissions, configuration, API specifications, message catalogs) yield statements whose evidence is the exact code at a commit. They land in the same fact slots as statements from documents. When a requirements document, a policy or a help page says something the code does not do, the disagreement becomes a todo for a person, like any other conflict.
2. **Design history.** Every change to a cited piece of code is linked, without a model, to its commit, its pull request, the issues it closes and the documents those link to. "Why does it work this way?" gets a dated answer, quoting the discussion in which it was decided.
3. **For people who do not read code.** Designers, product managers, support and compliance read pages in their own language and within their permissions. Statements can be released to them without the code itself.

What Inspiration should not build: a code graph, a wiki of the whole repository, a code search engine, or a proxy that serves raw code to coding agents. For code work, a coding agent does better reading the current code with the host's own tools, and good code wikis and code graphs already exist, several free for public repositories. A few live code tools are still worth having, as plumbing for Inspiration's own assistants.

It fits the current product without new concepts. A repository is a source and a commit is a version. Files, pull requests and issues are documents, and a declaration in code is a passage. A disagreement with documents is a conflict, and a feature is a topic. The additions are a connector per code host, parsers for code and structured files, one field on statements (`basis`), one kind of conflict (drift) and a release rule per topic. The work is about 10 person-weeks in four stages. The first stage, repository documents and history, is useful on its own and can run on this repository as real content.

## Who asks what of a repository

| Who | A typical question | Where the answer lives | Served today by |
| --- | --- | --- | --- |
| A designer new to the team | "How many inbox cards can an owner get in a week, and is that a hard cap?" | Code, pull request discussions, design documents, meeting notes | Asking an engineer, or reading code |
| Product, support, sales | "Does the Team plan include single sign-on? How long does an invitation link last?" | Configuration and code; help pages that may be out of date | Asking an engineer |
| Compliance, security | "Is a departed member's My space really erased after 30 days?" | Code, compared with the policy | A manual audit |
| An engineer from another team | "How does source sync call the connectors?" | Code | Code search, coding agents, code wikis |
| A coding agent | "Change the invitation flow" | Code, plus the rules the code must follow and why | The repository and the host's tools for the code; nothing for the rules |

The first three questions are about the product and the last two about the code. Code tools answer the last two well. The first three have the shape of the questions Inspiration exists for: the answer is spread over several tools, it must be cited, sources disagree, its history matters, it must respect permissions, and the asker reads their own language. What the coding agent lacks, the rules and their reasons, is what Inspiration's agent endpoint already serves.

## Do coding agents need a compiled repository?

**For code work, no.** A coding agent reads the current code with exact search and navigation, at the commit it is changing. Any compiled summary risks being a commit behind, loses exactness, and costs tokens to rebuild. Claude Code moved from vector retrieval to agentic search over files for these reasons. Precomputed wikis and code graphs help an agent orient itself in a large unfamiliar repository, and help smaller models, but that need is already served:

| Tool | What it does | What it shows us |
| --- | --- | --- |
| [Google Code Wiki](https://developers.googleblog.com/en/introducing-code-wiki-accelerating-your-code-understanding/) | Generates a wiki per repository, regenerated after each change, linked to files, classes and functions, with diagrams and a chat. Public repositories; a CLI extension for private ones was announced | A whole-repository wiki is becoming a free commodity |
| [DeepWiki](https://docs.devin.ai/work-with-devin/deepwiki-mcp.md) | A generated wiki per public repository, served over MCP as structure, contents and a question tool; private repositories through Devin | Outline, read, ask is a good tool shape for agents |
| [codebase-memory-mcp](https://landscape.jimmysong.io/projects/codebase-memory-mcp/), GitNexus, Sourcegraph | A code graph (symbols, calls, dependencies) from tree-sitter or compiler indexes, queried over MCP | Code structure is cheap to compute and well served |
| [Swimm](https://docs.swimm.io/features/keep-docs-updated-with-auto-sync/) | Engineering docs coupled to code snippets; a code change that affects a doc marks it "potentially out of date" | Detecting drift between docs and code is valued, but only inside engineering docs |

**What coding agents lack is what is not in the repository:** the rule the code must follow, the decision behind it, the procedure around it. Those live in Feishu documents, approval flows and meeting notes. Inspiration already serves them through MCP. Linking them to code paths makes them findable from where the agent works ("what governs `engine/collaboration`?").

**For people who do not read code, raw code is not enough.** They cannot read it; the reasons are scattered over pull requests, issues, chats and requirements documents; the default branch may not be what is live; and many of them may not see the repository at all.

So compiling code is worth it only where it produces something code tools do not: behavior as cited statements that can conflict with documents, history joined across tools, and pages for people outside engineering.

## Options considered

| Option | What it is | Value | Cost | Verdict |
| --- | --- | --- | --- | --- |
| A. Repository documents only | README, `docs/`, decision records and other Markdown in a repository, read as ordinary documents | Real, but small alone | Low | Yes, as part of stage 1 |
| B. A thin proxy | Search and read code through Inspiration's MCP, with the member's rights | Duplicates the host's own MCP and search; adds a hop | Low | Only as plumbing for Inspiration's assistants (stage 4) |
| C. Precompile the whole repository | A code wiki or code graph of every module, served to people and agents | Orientation for engineers, already a commodity. A single source has nothing to govern; generated prose has no verbatim evidence per sentence; regeneration is costly | High | No. Borrow the page shape (overview, diagrams, links to exact lines) for feature pages |
| D. Code as a governed source of product behavior and history | Statements from chosen paths, drift against documents, history joined to pull requests and documents, pages for non-engineers | What only Inspiration can do with a repository | About 10 person-weeks | **Recommended** |

## The design

### A repository is a source

- **One integration per code host,** as for every vendor: one typed client serves sync and agent tools, with one scope set and one rate budget per connection. GitHub first; then GitLab, Gitee and Alibaba Cloud Codeup, chosen with the first design partner. A company connection is a GitHub App installation; a member connection is the member's own OAuth sign-in. Push, pull request and issue webhooks are hints; the poll and the nightly reconcile work as for other sources.
- **The followed ref.** A source follows the ref the company says is live: a release branch or the latest release tag. The default branch is the fallback, and its statements then say "merged, may not be released yet". A statement's valid time starts when its change reached the followed ref.
- **A commit is a version.** A file's `external_version` is its blob hash, so an unchanged file is never fetched again. The change cursor is the last synced commit; a compare between two commits lists changed, added, deleted and renamed files. Renames are moves, so the [source changes](source-changes.md) move rule carries knowledge over without asking anyone. The host's API covers listing, compares, blame and contents; a very large repository is cloned partially in the sandbox, without hooks or submodules.
- **Items.** Files under included paths, pull requests and issues, each with its description and discussion as blocks. Commit messages are metadata of the versions they produced; in repositories without pull requests they are where the reasons are.
- **The Sources tree** shows the repository's folders, with Pull requests and Issues beside them.
- **Governance levels by path.** By default `docs/**`, README files, decision records, pull requests and issues are Reference, and code is Search only. Governed applies only to the paths a space owner chooses: configuration, limits, plans and entitlements, permission rules, API specifications, message catalogs. Vendored and generated code, lock files, binaries and secret files are excluded.
- **An optional steering file** in the repository (`.inspiration.yaml`) maps paths to topics, sets levels and names the followed ref. Engineers keep it current through pull requests, as some code wiki tools let a repository steer its wiki.

### Code as blocks and passages

- **Blocks follow the syntax.** Tree-sitter, through its WebAssembly build in Node, splits a source file into declarations: functions, classes, constants, enums, routes. It runs in process in normalization, because it is deterministic and needs no Python worker. Structured files (YAML, JSON, TOML, properties, OpenAPI, message catalogs) are split into keys.
- **A block ID is a path plus a symbol path,** such as `engine/collaboration/src/inbox.ts#INBOX_DEFAULTS.cardSize`, never a line number. Moving code inside a file changes no ID, and the block diff sees only real changes.
- **A span is the exact text.** A citation opens the file at the commit and the lines, with a link to the host. The Original view of a file is the file at a commit with syntax highlighting, a mirror page of exact fidelity.
- **Message catalogs are translations of each other.** The catalogs of one message key in English, Chinese and Japanese are linked as translations, as [Knowledge and language](knowledge-and-language.md) designs for documents, so the same text in three languages is one unit, and a catalog left behind gets a "translation out of date" review.

### Behavior statements

- **Literals first, without a model.** A declaration or a key with a literal value (`cardSize: 20`, `INVITE_TTL_DAYS = 7`, an enum of plan names, a limit in an OpenAPI schema) yields a candidate: the key, the value, its unit if any and its comment. What the candidate means, the predicate and qualifiers of a fact slot, is mapped once, by a model check (`extraction.map_code_fact`) or in the steering file, and confirmed by the topic owner. From then on the mapping is keyed by the block ID, and a change of the literal updates the statement with no model call.
- **The model only for behavior that is not a literal,** such as a condition or a state transition in a governed path, and only for changed blocks: the extraction task with a prompt for code. The evidence quote is the verbatim code. Such statements carry lower confidence and stay Reference until the topic owner confirms them.
- **`basis`: implemented or specified.** A statement read from code is `implemented`: what the product does. A statement from a document is `specified` (the default): what someone wrote it should do. Both go into the same slot, so they can be compared.
- **No review clocks.** A code statement is read again whenever its code changes, so it does not age the way a document does. Its knowledge class is `product` or `technical`.

### Drift: when documents and code disagree

- **A disagreement between a specified and an implemented value is a drift case,** a new kind of conflict case. Governance does not pick a winner by authority, because the question is not which source is right but which side has to change.
- **The card says it plainly:** "The product does X (code, commit, pull request); the onboarding guide says Y." The choices are: the document is out of date (a note to its owner, since Inspiration never writes back to sources); the code is wrong (the person deciding asks the assistant to open an issue in the repository, as themselves, after confirming it); or both hold for different cases (add the qualifier that separates them).
- **Readers meanwhile see both values,** "The product does X; the onboarding guide says Y", marked Disputed. This is one of the company settings that already exist for open conflicts, made the default for drift because, until someone decides, neither value is the last verified one.
- **A code change that leaves documents behind** gives them the copy review that copies left behind by an edit get today, riding on the change's card. A release that changes many values is one change review, under the existing rule (more than 20 todos or more than 3 topics).
- **A fact only the code states,** such as a limit no document mentions, is not a conflict. It can go on the topic owner's notes card as "not documented", which designers and technical writers find valuable; whether it is on by default is a decision below.

### Design history

- **The join is deterministic.** For a block on the followed ref, the host gives the commits that changed it (blame or line history), the pull requests those commits belong to, and the issues each pull request closes or links. Links in the pull request to documents Inspiration already holds (a requirements document in Feishu, meeting minutes) become links between the two sources. No model is needed for any of this.
- **A model only writes the reason,** in a sentence or two per change, each sentence citing a verbatim quote from the pull request, the issue or the linked document, under the usual evidence rule. Discussions in any language give language-neutral statements.
- **History is a section of the topic page:** the value over time from the fact slot (the store already keeps every value a slot has held, as it knew it when), each change with its date, its pull request and its reason. It uses the existing page blocks: table, quote, code and diagram.

### Features are topics

A designer thinks in features; a repository has paths. A feature is a topic in the Knowledge tree, so no new concept is needed. Code statements cluster with document statements about the same subject; the topic's paths, labels and pull request titles come from that clustering, from the steering file, or from the topic owner. `CODEOWNERS` only suggests who could own the topic, because owning code is not owning knowledge about it.

### Permissions and secrets

- **The rule does not change.** A repository is published into a space, and the space's audience reads its statements. Repository permissions only warn: "12 people can read this repository; the space has 400 readers".
- **Two common setups.** Where everyone may read code, the repository sits in a company-wide space. Where code is restricted, it sits in an Engineering space, and its behavior statements are released to a product audience without their code quotes, using the per-statement release of [Permissions in compiled knowledge](compiled-knowledge-permissions.md). Readers then see "Source: code in repository X (engineering only)".
- **A release rule per topic.** Releasing hundreds of code statements one at a time is too much work, so a space owner may release the behavior statements of one topic to one audience, without quotes. The rule is recorded and can be withdrawn like a release, and a statement that changes later still gives the approver a todo. This is the one addition to the permission design.
- **Secrets never become knowledge.** A secret scanner runs in normalization. A block that looks like a secret is never stored as citable text, and the space owner gets a note. Code sources default to the `confidential` label, so the model gateway sends them only to providers cleared for it.
- **Agents read code only as their member could.** Live code tools act as the member, with the member's own connection, never with the company's.

### Live code tools

- **Three read-only `agent_tools` plugins** on the code host client: `code_search`, `code_read` (a path at a ref, a range of lines) and `code_history` (the commits and pull requests that touched a path or block). They pass the agent runtime's gate like every tool.
- **Used by Inspiration's own assistants,** when knowledge does not yet cover a question. A span an answer cites is registered as evidence, so the answer stays traceable after the code changes.
- **Not a replacement for the host's MCP.** An external coding agent uses its code host for code and Inspiration for knowledge. Search results for code statements carry their code citations, so an agent can go from a rule to the code that implements it.
- **Knowledge flows to coding agents the other way.** The verified rules of a topic, found by its paths, can be exported as an Agent Skill (already planned for procedures), so an agent working in `engine/collaboration` gets the governed rules for it without asking.

### What people see

| Where | What appears |
| --- | --- |
| Sources tree | The repository with its folders, Pull requests and Issues |
| Original view | A file at a commit with syntax highlighting; a pull request with its discussion |
| Knowledge view | Topic pages with "How it works today" and "History" sections, each sentence cited |
| Citation popover | File, lines, commit, followed ref, "Open in GitHub"; or "code in repository X" without a quote where the reader may not read code |
| Inbox | Drift cards, "not documented" notes, and one change review per large release |
| Agent API | The same ten tools; code statements carry code citations |

## A worked example from this repository

Every fact below comes from this repository's code, documents and pull request #10 as they are on 2026-10-26; nothing is made up.

A designer drawing the inbox asks: **"How many cards can an owner get in a week? Can a card overflow?"**

- **What the documents say.** The overview's governance section says "Each owner gets at most 10 cards a week; the rest wait for the next week with room, except urgent ones", and requirement GV-4 gives the same numbers. [Architecture](../architecture.md) names "high and urgent todos" as the exception instead, and adds that "the budget is a soft limit".
- **What the code does.** `engine/collaboration/src/inbox.ts` sets `INBOX_DEFAULTS` to `budget: 10`, `cardSize: 20` and `horizon: 26`. Todos of priority `high` and `urgent` always go in their due week (`URGENT = new Set(["high", "urgent"])`). A conflict and its copy reviews stay together in their week, on the conflict's card or its next part (`<card>:2`), even over the budget. A todo is held back at most 26 weeks; after that it goes in its due week, over the budget.
- **The history.** The inbox came in commit e224a5d on 2026-10-24, in pull request #10. On 2026-10-25 the review found that copy reviews riding on a conflict could fill a card past 20 ([P2], "20 → 21"); commit 4f52a72 fixed it with continuation parts. On 2026-10-26 the review asked whether the conflict group or the weekly budget wins. The merge comment decided: the group is the unit and the budget is a soft limit, because at 10,000 documents the budget never binds (at most 4 cards per owner and week).
- **What Inspiration would produce.** A topic page, "Inbox cards". "How it works today": 20 todos per card, always, using continuation parts; 10 cards per owner a week as a soft limit; high and urgent todos and conflict groups go over it; nothing waits more than 26 weeks. Each sentence cites the code at its commit. "History": three dated entries, each quoting the review comment and the decision. In the inbox: one drift card ("the overview names urgent todos as the exception; the code, and Architecture, name high and urgent ones"), and one "not documented" note (the 26-week horizon, which no document mentions).

A designer cannot get this answer from the code alone, nor from the overview, which leaves out the exceptions and the horizon.

## What we do not build

- **A code graph.** Symbols and call graphs serve engineers' navigation, which code tools do well, and no person governs a call edge. If mapping code to features later needs import edges, they stay inside a plugin and never become knowledge.
- **A wiki of the whole repository.** It is becoming free, a single source has nothing to govern, and its sentences are written by a model rather than quoted from evidence. Feature pages borrow its shape.
- **Machine-written wikis as sources.** Output from DeepWiki or Code Wiki is a model's prose, not evidence, and would count as support for itself. A page may link to it, never cite it.
- **A code search engine.** Code search goes through the host's own search via `code_search`. An index of our own comes only if a customer's host has no usable search.
- **Writing to repositories on our own.** Inspiration opens an issue only when a person deciding a drift case asks for it, as themselves.

## Later ideas

- **A drift check before merge.** On a pull request that changes a governed literal, a check lists the documents that state the old value, so the author can fix them in the same change. It writes to the code host, so a space owner turns it on per repository.
- **Feature flags.** Flag values in a flag service reach statements through a `data_providers` plugin, so "when flag F is on" can say for whom it is on today.
- **Design files.** Design files linked from pull requests and requirements documents become sources of their own, so a feature's history shows the design next to the decision.

## Validation on real repositories

The design is judged on real code and real history, not invented sentences.

1. **This repository first.** It has real code, documents in English and Chinese, more than 90 commits and close to 20 pull requests with review threads, and, as the example shows, real disagreements between them. A question set comes from its history: questions a designer or product manager would ask, each with the answer and its evidence written down by a person beforehand. It needs no customer.
2. **A second, larger open-source repository** with a user manual in the repository, long pull request history and more than one language, chosen with the product owner.
3. **A design partner's repository in the pilot,** read only, with documents and pull requests first and code paths added when the partner chooses.

| Measure | How |
| --- | --- |
| Answers | Share of the question set answered correctly with a correct citation |
| History links | Share of value changes linked to the right commit and pull request; deterministic, so anything below nearly all is a bug |
| Drift precision | Share of drift cards a person agrees are real, against the existing bar of at least half for conflicts |
| Cost | Model calls and tokens per 100 commits, with literals mapped and without |
| Latency | Time from a merge on the followed ref to the updated page |

## Stages and effort

| Stage | Delivers | Main work | Person-weeks |
| --- | --- | --- | --- |
| 1. Repository documents and history | Markdown, pull requests and issues as Reference sources, searchable and cited; their statements meet Feishu documents in the same slots | GitHub connector (App and OAuth through the credential broker, webhooks, followed ref, compares, renames), pull request and issue items, commit-to-pull-request links, the Sources tree for repositories | 3 |
| 2. Behavior from code | Statements from governed paths; drift cases | Tree-sitter and structured-file parsers, symbol-path block IDs, the secret scanner, literal candidates and the mapping task with its mock, the code prompt with its mock, `basis`, drift in governance | 4 |
| 3. Feature pages and history | "How it works today" and "History" on topic pages; links between sources | The history join, the history section in page-compiler, links from pull requests to documents, the release rule per topic | 2 |
| 4. Live code tools | Assistants that read code as the member, with cited spans kept as evidence | Three agent tools, evidence registration | 1 |
| **Total** | | | **about 10** |

GitLab self-managed adds about 1.5 person-weeks. In the current plan this comes after connections and parsing, because company and member connections need the credential broker. Stage 1 can also run earlier on this repository with a deployment token instead, as a probe on real content that needs no customer.

## Contract changes

All additive; see [contracts.md](../contracts.md).

- `SourceItemKind` gains `change_request` (a pull or merge request) and `issue`.
- `DocBlockKind` gains `declaration` (a function, class, constant or route in code) and `entry` (a key in a structured file or message catalog).
- `SourceVersion` gains optional `commit { sha, ref, committed_at, reached_ref_at }`.
- `Claim` gains optional `basis: specified | implemented`; absent means specified.
- `ConflictCase` gains a kind, `drift`, for a specified and an implemented value that disagree.
- A new `SourceLink { from, to, kind: closes | references | implements }` between source items, written by the connector or by normalization.
- A new `ReleaseRule { topic, audience, include_quotes, approved_by, approved_at }` in collaboration.
- A new `RepositorySteering` schema for `.inspiration.yaml`, with an example in `libs/contracts/examples/`.
- No new events: pushes arrive as `source.changed`, and everything after that is the existing pipeline.

## Risks and open points

| Risk | Mitigation |
| --- | --- |
| Code statements and document statements do not meet in the same fact slot, so drift is never found | This is the main bet to prove. Literals are mapped to slot predicates once and confirmed by the topic owner; the steering file can state the mapping; mapping precision is measured on this repository first |
| Behavior that is not a literal (conditions, state transitions) is extracted wrongly | Only in governed paths; lower confidence; Reference until the topic owner confirms |
| Customers will not send code to a SaaS | Stage 1 reads only documents, pull requests and issues; code paths are opt-in per path; the `confidential` default and model routing by label; private deployment for those who need it |
| Self-hosted GitLab inside a company network cannot be reached from SaaS | GitHub, Gitee and Codeup first; for self-hosted hosts, private deployment or an outbound-only relay in the customer's network (not designed) |
| Too many drift cards | Governed paths are few and chosen; literals are mapped once and confirmed; drift precision is measured; "not documented" notes stay outside the weekly budget |
| The followed ref is not what is live | The space owner names the release ref; the default branch is labelled as merged, not released |
| Feature flags make the behavior conditional | A flag becomes a qualifier ("when flag F is on") where the code shows it; flag values in a flag service come later through a `data_providers` plugin |
| Secrets in code | The scanner in normalization; secret-like blocks are never stored as citable text |

## Decisions for the product owner

1. **The direction:** code as a witness of product behavior and history (option D), with no code graph, whole-repository wiki or code search engine of our own.
2. **Code hosts:** GitHub first; which of GitLab, Gitee and Codeup second depends on the first design partner, and self-hosted GitLab implies private deployment or a relay.
3. **Order:** stage 1 now, on this repository, as a probe on real content; or all four stages after the credential broker and parsing.
4. **Two defaults:** readers see both values on a drift case (recommended); "not documented" notes are off until a topic owner turns them on (recommended).

## Terms

| Concept | UI term | 中文 | 日本語 (draft) |
| --- | --- | --- | --- |
| Code repository | Repository | 代码仓库 | リポジトリ |
| Followed ref | Followed branch | 跟踪分支 | 追跡ブランチ |
| Pull request | Pull request | 合并请求 | プルリクエスト |
| Specified, implemented | As documented, As built | 文档规定, 代码实现 | 文書上の仕様, 実装 |
| Drift | Documents and product disagree | 文档与产品不一致 | 文書と製品の不一致 |
| Not documented | Not in any document | 未写入文档 | 文書に記載なし |
| Release rule | Release rule | 放行规则 | 公開許可ルール |
| Steering file | Repository settings file | 仓库配置文件 | リポジトリ設定ファイル |
