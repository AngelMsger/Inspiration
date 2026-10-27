# Code repositories as a knowledge source

Status: proposed, 2026-10-26, for the product owner's decision. Revised the same day after a head-to-head test against a coding agent over a clone of this repository, which led us to cut the first design back. Nothing here is built. A Chinese copy is in [docs/zh/design/code-repositories.md](../zh/design/code-repositories.md); if the two differ, this English version wins.

It answers the product owner's questions: can code repositories be a source of knowledge in Inspiration; is there any point when a coding agent can read raw code and hosted Git directly; how do the results compare with giving a coding agent a clone; and does it still work for a large repository that merges many pull requests a day.

## Summary

**A coding agent over a clone answers questions about code better than anything we would precompile, so Inspiration should not precompile code.** In the test on this repository, a fresh coding agent with a clean clone and read access to pull request discussions answered all eight designer-style questions correctly and completely, with exact citations. It needed a median of about 76,000 tokens and 76 seconds per question. It also found eight places where the documents and the code disagree or where the code has a rule no document states. Four of them were missing from our own answer sheet. The first design, which read behavior from code literals, would have caught at most two of the seven code-related findings, because the rest are logic or something missing from the code, not values.

**Code still belongs in Inspiration, in a smaller role: answers are produced on demand by a coding agent, then kept, watched and shared.** A coding agent's answer lives for one conversation. Nobody is told when the code under it changes, nobody can see it unless they can read the repository, and nothing ties it to the Feishu documents that say otherwise. Inspiration adds exactly these:

1. **Ask once, keep the answer.** A code question is answered by a coding agent acting as the member who asks, inside the sandbox. The answer is saved as a research report whose evidence is the exact code spans and discussion it cites.
2. **Watch what it cites.** Every merge is compared with the cited spans only. An answer whose cited code changed is marked "code changed since" and checked again: once a day for answers a page relies on, otherwise when someone next reads it.
3. **Share it within permissions.** A saved answer can be released to people who cannot read the repository, such as designers, product managers and support, in their own language.
4. **Flag disagreements to owners.** When a check or a scheduled audit finds that a document and the code disagree, the document's owner gets a todo within the weekly budget.
5. **Read the repository's text as ordinary sources.** README files, `docs/`, pull requests and issues are Reference documents next to Feishu documents.

**It works at many merges a day because nothing is precompiled.** Each merge costs one compare call, a lookup of cited spans and the embedding of the merged pull request's text. Cost grows with the questions people ask and the answers they keep, not with the merge rate. A per-repository daily budget caps the checks.

**When to drop it.** If the people asking can all read the repository and already use a coding agent, and the product documents live in the repository too, Inspiration adds little for code. They should keep using their coding agent.

The work shrinks from about 10 to about 6 person-weeks.

## Who asks what of a repository

| Who | A typical question | Where the answer lives | Served today by |
| --- | --- | --- | --- |
| A designer new to the team | "How many inbox cards can an owner get in a week, and is that a hard cap?" | Code, pull request discussions, design documents, meeting notes | Asking an engineer, or a coding agent if they can read the repository |
| Product, support, sales | "Does the Team plan include single sign-on? How long does an invitation link last?" | Configuration and code; help pages that may be out of date | Asking an engineer |
| Compliance, security | "Is a departed member's My space really erased after 30 days?" | Code, compared with the policy | A manual audit |
| An engineer from another team | "How does source sync call the connectors?" | Code | Code search, coding agents, code wikis |
| A coding agent | "Change the invitation flow" | Code, plus the rules the code must follow and why | The repository for the code; nothing for the rules |

The first three questions are about the product and the last two about the code. A coding agent with the repository answers both kinds well, and the test below shows it on the first kind. What none of them do on their own is keep an answer, notice when it stops being true, show it to people without repository access, and connect it to documents outside the repository.

## Head-to-head: a coding agent over a clone

**Setup.** Eight questions a designer or product manager could ask about Inspiration's own behavior and history. Their right answers were written down before any run, from the code, the documents and the pull request discussions. Each question went to a fresh general-purpose coding agent with a clean clone of `main` at 4d5ea00 (without this design) and its full history, and read-only access to the discussions of pull requests #1 to #20. Only question 4 asked about disagreements. The questions, right answers, verbatim answers and per-run numbers are in [examples/code-questions](../../examples/code-questions/answers.md).

| Question | Score (of 2) | Raised a disagreement unasked | Tokens | Seconds |
| --- | --- | --- | --- | --- |
| 1. How many todos fit on a card, and what happens when it is full? | 2 | No | 80,954 | 81 |
| 2. Is "10 cards per owner per week" a hard cap? | 2 | Yes | 79,512 | 94 |
| 3. Why is the budget a soft limit, and when was that decided? | 2 | No | 73,269 | 71 |
| 4. Do the documents describe the budget correctly? | 2 | (asked) | 100,783 | 125 |
| 5. How fast are changes and upstream deletions noticed? | 2 | Yes | 101,488 | 141 |
| 6. Default review intervals for policy and process | 2 | Not applicable | 55,751 | 28 |
| 7. Default governance level of an upload | 2 | Not applicable | 71,606 | 67 |
| 8. When and why did the packages move into `engine/` and `libs/`? | 2 | Not applicable | 66,045 | 60 |
| **Median** | | | **76,391** | **76** |

Tokens and seconds are what the agent runtime reported for each run.

**What it found.** Eight disagreements or undocumented rules, all real when checked against the code:

| # | Finding | In our answer sheet | The first design would catch it |
| --- | --- | --- | --- |
| 1 | The overview names "urgent" todos as the budget exception; the code and Architecture say high and urgent | Yes | Perhaps, if the priority set were mapped as a literal |
| 2 | The overview leaves out that a conflict and its copy reviews go over the budget together | Yes | No: logic |
| 3 | A todo waits at most 26 weeks (`horizon: 26`); no document says so | Yes | Yes, as "not documented" |
| 4 | The overview marks the 15-minute poll and the nightly listing "Built", but no timer or webhook receiver exists in the code | Yes | No: something missing |
| 5 | Notes cards have no 20-todo cap | No | No: logic |
| 6 | Done and dismissed todos still count toward a card's 20 and the week's 10, so clearing an inbox frees no room that week; possibly a bug | No | No: logic |
| 7 | The overview and Source changes disagree on which listing finds deletions | No | By ordinary document governance, not by reading code |
| 8 | Campaign and steward cards carry no assignee, while the documents say the space owner gets them | No | No: logic |

**What it means.**

- **For answering questions, a coding agent is as good as it gets.** It read the code, the tests, the history and the review threads, and wrote plain answers for a designer. Precompiled statements could at best match this, and the first design would have missed most of the findings.
- **The reasons live on the code host, not in the clone.** Question 3's answer exists only in a pull request comment, so reading the host's discussions is necessary.
- **The cost is per question, every time.** Each run costs tens of thousands of tokens and a minute or two. The same question asked by ten people costs ten runs, and nothing warns anyone when the answer stops being true.
- **The findings need an owner.** Findings 4 and 6 are worth fixing now, but a coding agent's conversation ends with them. In Inspiration they would be todos for the overview's owner and the collaboration component's owner.
- **Limits of the test.** This repository is small (about 450,000 tokens of code and structured files), young (66 commits over five days) and unusually well documented. On a large repository with thin documents the agent will take longer and cost more. The agent ran on a frontier-class model. Inspiration's own serving side (retrieval, saved answers) is not built, so its numbers below are estimates.

## The design

### Repository text is an ordinary source

- **One integration per code host,** as for every vendor: one typed client serves sync and agent tools, with one scope set and one rate budget per connection. GitHub first; then GitLab, Gitee or Alibaba Cloud Codeup, chosen with the first design partner. A company connection is a GitHub App installation; a member connection is the member's own OAuth sign-in.
- **What is synced:** README files, `docs/` and other Markdown, decision records, and pull requests and issues with their discussions. All are Reference by default, read on use like uploads. Code files are not synced.
- **A commit is a version.** A Markdown file's `external_version` is its blob hash; the change cursor is the last synced commit; a compare between commits lists changes, deletions and renames, and renames are moves under the [source changes](source-changes.md) rules. A source follows the ref the company says is live (a release branch or tag), else the default branch.
- **Links.** A pull request's links to the issues it closes and to documents Inspiration already holds (a requirements document in Feishu, meeting minutes) become links between the sources.

### Code answers on demand

- **A code question goes to a coding agent,** run by the research component on the agent runtime, in the sandbox, as the member who asks and with that member's own connection. Its tools are read-only `agent_tools` plugins on the code host client: `code_search`, `code_read` (a path at a commit, a range of lines), `code_history` (commits and pull requests that touched a path or range) and the discussions of pull requests and issues. A large repository is cloned partially in the sandbox, without hooks or submodules.
- **The answer is a research report.** Its conclusions are statements; its evidence is the code spans it cites (path, commit, lines) and quotes from discussions, registered as evidence so they stay readable after the code moves on. Each conclusion records which spans support it.
- **The assistant decides when to ask the code.** When existing knowledge covers a question, it answers from knowledge. When the question is about what the product does, or knowledge is thin, it offers to read the code. The answer says which commit it read.
- **Saving.** A member can save an answer into a topic page, for example as the page's "How it works today" section. A saved answer is pinned when a page or a governed topic relies on it.

### Watching what answers cite

- **Each merge is compared with cited spans only.** The compare between the last checked commit and the new one gives changed hunks; they are intersected with an index of cited spans, following renames. A span whose lines did not change, even if its file did, triggers nothing.
- **A touched answer is marked "code changed since".** A pinned answer is checked again at most once a day, by an agent given the old answer, the cited spans and the diff. Any other answer is checked when someone next reads it. A check that leaves the conclusions unchanged only moves the answer to the new commit.
- **A changed conclusion** gives the answer's owner one todo, riding on the change's card. A release that changes many answers is one change review, under the existing rule.
- **A daily budget per repository** caps checks. Over it, pinned answers wait for their next read, oldest first.

### Disagreements between documents and code

- **During a check or an answer,** the agent compares what it found with the documents Inspiration holds on the same topic, and proposes a drift todo when they disagree: "The product does X (code at a commit, pull request); the onboarding guide says Y". It goes to the document's owner. The choices are to update the document, to file an issue against the code (the person deciding asks the assistant to open it, as themselves), or to record that both hold in different cases.
- **A scheduled audit,** off by default, asks "do the documents of this topic match the code?" per topic, for example weekly, as the space owner. Question 4 of the test is that audit; it took about 100,000 tokens and two minutes.
- **Readers meanwhile see the document marked Disputed,** with the code's answer one click away.

### Permissions

- **The rules do not change.** The agent reads code only as the member who asks. A company connection is never leased to an agent run, so a person who cannot read the repository cannot make an agent read it either.
- **People without repository access read released answers.** Saved answers live in the space the repository was published to, usually an Engineering space. Its owner releases an answer to a wider audience under the per-statement release of [Permissions in compiled knowledge](compiled-knowledge-permissions.md), without its code quotes where code is restricted. Readers see "Source: code in repository X (engineering only)".
- **A question from someone without access** becomes a request to the topic owner, whose answer is saved and released.
- **Secrets.** Cited spans pass a secret scanner before they are stored; a span that looks like a secret is never stored as citable text. Code evidence carries the `confidential` label by default, so the model gateway sends it only to providers cleared for it.

### What people see

| Where | What appears |
| --- | --- |
| Documents tree | The repository with its folders of documents, Pull requests and Issues |
| Knowledge view | Topic pages with saved code answers, each conclusion cited to code at a commit and to the discussion |
| Citation popover | File, lines, commit, "Open in GitHub", and "code changed since" when it did; or "code in repository X" without a quote |
| Assistant | "Read the code for this?" when knowledge is thin, with the commit the answer read |
| Inbox | Drift todos, changed conclusions of pinned answers, one change review per large release |
| Agent API | The same ten tools; `search` finds saved code answers like any other knowledge |

## Cost at many merges a day

### What one merge costs

| Work | When | Cost |
| --- | --- | --- |
| Compare the new commit with the last checked one | Every merge on the followed ref | One API call |
| Intersect changed hunks with cited spans | Every merge | An in-memory lookup |
| Store the merged pull request's text as a Reference document | Every merged pull request | Embedding a few thousand tokens; no generation |
| Re-check a pinned answer whose cited lines changed | At most once a day per answer | One agent run, given the old answer and the diff |
| Re-check any other touched answer | When someone next reads it | One agent run |
| Answer a new question | When asked | One agent run: a median of about 76,000 tokens and 76 seconds in the test |
| Answer a repeated question | When asked, if no cited line changed | A saved answer: retrieval and a page read, estimated at 1,000 to 3,000 tokens and a few seconds |

Nothing reads code that nobody asked about. That is the difference from precompiling: a full compile has to re-read at least every changed file on every merge, whatever anyone asks.

### Measured on this repository

Replaying its 66 commits up to 4d5ea00:

- A commit changes a median of 6 files (2 of them code), and 42 at the 90th percentile.
- The changed code and structured files of one commit hold a median of about 6,800 tokens, 71,000 at the 75th percentile and 143,000 at the 90th. A full compile would re-read at least that per commit.
- On 2026-10-26, its busiest day, 30 commits landed. The files cited by each answer of the test were touched by 1 or 2 of them, and none changed the substance of an answer: one only moved paths, and one wrote down a rule the code already had.

### A large repository, worked through

Assumptions, not measurements: 300 merges a day; 20,000 files and about 200,000 declarations; a merge changes about 30 declarations; 500 pinned answers citing 5 spans each.

- **Per-merge work:** 300 compares and lookups a day, and the embedding of 300 pull requests (about a million tokens a day at 3,000 each).
- **Re-checks:** each merge touches about 30 × 2,500 / 200,000 ≈ 0.4 cited spans, so about 110 a day, fewer when hot code is touched several times in one day. At an assumed 40,000 tokens per check, about 4.5 million tokens a day, under a budget the company sets.
- **Questions:** the measured cost per question, minus repeats served from saved answers.
- **For comparison, a full compile** would re-read 300 × 7,000 to 70,000 tokens, that is 2 to 21 million tokens a day, before writing anything, and its pages would still miss most of what an agent finds.
- **People:** a todo arises only when a pinned answer's conclusion changes or an audit finds a disagreement, within the weekly budget of 10 cards per owner, with change reviews for large releases.

So the revised design is feasible at high merge rates, and its cost stays under the company's control. Precompiling code is not worth doing at any merge rate.

## The first design, and why it was cut back

The first version of this proposal (PR #21) read behavior statements from chosen code paths. Tree-sitter split code into declarations; literals were mapped to fact slots; a `basis` field marked statements as specified or implemented, so that a document and the code disagreeing in one slot became a drift conflict; history was joined from code lines to commits and pull requests; and feature pages were compiled from all of it. The head-to-head showed three problems:

1. **Low recall where it matters.** Most real disagreements are about logic or about something missing, not about a literal value. Of the seven code-related findings in the test, literal mapping catches at most two.
2. **No better answers.** A coding agent already writes the history and the explanation, from the same sources and with exact citations.
3. **Cost that follows the merge rate.** Parsing and extracting governed paths on every merge costs tokens and inbox attention even when nobody asks.

What survives: the repository as a source with commits as versions, pull requests and issues as documents, drift as a todo for the document's owner, the live code tools (now central rather than plumbing), the secret scanner, and the permission rules.

## What we do not build

- **Precompiled behavior statements from code,** for the reasons above.
- **A code graph.** Symbols and call graphs serve engineers' navigation, which code tools and coding agents do well, and nobody governs a call edge.
- **A wiki of the whole repository.** It is becoming free (Google Code Wiki, DeepWiki), a single source has nothing to govern, and its sentences are a model's prose rather than quotes from evidence. Machine-written wikis are never cited as sources either, since they would count as support for themselves.
- **A code search engine.** Code search goes through the host's own search.
- **A proxy that serves raw code to external coding agents.** They use their code host for code and Inspiration for knowledge; the verified rules of a topic can be exported to them as an Agent Skill.
- **Writing to repositories on our own.** An issue is opened only when a person deciding a drift todo asks for it, as themselves.

## Validation

1. **Done: this repository, round one.** Eight questions, eight correct answers from a coding agent, eight findings. The data is in [examples/code-questions](../../examples/code-questions/answers.md).
2. **Next, with the first stages built:** the same questions through Inspiration. Measure that saved answers are served correctly, that a change to a cited span marks exactly the answers it should (by replaying this repository's later history), the tokens and time of re-checks against fresh runs, and the precision of drift todos against the bar of at least half that applies to conflicts.
3. **A larger repository** with long pull request history, thin documents and more than one language, chosen with the product owner, to measure agent cost and re-check rates at a realistic size.
4. **A design partner's repository in the pilot,** read only.

## Stages and effort

| Stage | Delivers | Main work | Person-weeks |
| --- | --- | --- | --- |
| 1. Repository text as sources | README, `docs/`, pull requests and issues as Reference documents next to Feishu documents | GitHub connector (App and OAuth through the credential broker, webhooks, followed ref, compares, renames), pull request and issue items, links between sources | 2.5 |
| 2. Code answers on demand | A coding agent that answers as the member, saved as a research report with code evidence | The code agent spec and its tools, a sandbox profile with a partial clone, evidence registration for code spans, saving into topic pages | 2 |
| 3. Watching cited spans | "Code changed since", daily re-checks of pinned answers, re-check on read, budget | Hunk-to-span intersection that follows renames, the re-check run, todos for changed conclusions | 1 |
| 4. Drift todos and audits | Disagreements proposed to document owners; an optional scheduled audit per topic | The drift todo kind, the audit job, routing within the weekly budget | 0.5 |
| **Total** | | | **about 6** |

GitLab self-managed adds about 1.5 person-weeks. Stage 1 depends on the credential broker; with a deployment token it can run earlier on this repository as a probe on real content.

## Contract changes

All additive; see [contracts.md](../contracts.md).

- `SourceItemKind` gains `change_request` (a pull or merge request) and `issue`.
- `SourceVersion` gains optional `commit { sha, ref, committed_at, reached_ref_at }`.
- `ResearchEvidence` gains optional `code { repository, path, commit, start_line, end_line }`, so a code span is evidence.
- `RecheckMethod` gains `code_span`: an assumption that the cited code still reads as it did, re-checked when a merge changes it.
- `ResearchReport` gains optional `recheck: pinned | on_read`.
- `TodoKind` gains `drift`: a document and the code disagree.
- A new `SourceLink { from, to, kind: closes | references }` between source items.
- No new events: pushes arrive as `source.changed`.

## Risks and open points

| Risk | Mitigation |
| --- | --- |
| Agent runs are costly on large repositories | Saved answers serve repeats; re-checks only for changed cited lines; a daily budget; a flash-class model for re-checks once its quality is measured |
| An agent answer is wrong and gets saved | Saving is a member's act; pinned answers have an owner; citations are exact and checked against the code at the commit; G1 measures answer accuracy |
| Customers will not send code to a SaaS | Stage 1 reads only documents, pull requests and issues; code is read only when a member asks, and only the cited spans are kept; the `confidential` default and routing by label; private deployment |
| Self-hosted GitLab cannot be reached from SaaS | GitHub, Gitee and Codeup first; private deployment or an outbound-only relay (not designed) |
| Readers without repository access get little | Released answers and requests to topic owners; the value depends on owners saving and releasing answers |
| The followed ref is not what is live | The space owner names the release ref; answers say which commit they read |

## Decisions for the product owner

1. **The direction:** code answers on demand by a coding agent, kept, watched and shared by Inspiration, instead of precompiled code knowledge; or drop code sources for now.
2. **Order:** stage 1 now on this repository as a probe on real content, or after the credential broker.
3. **Two defaults:** pinned answers re-checked daily and others on read (recommended); scheduled audits off until a space owner turns them on (recommended).

Whatever is decided, the test's findings are worth acting on now: the overview's "Built" for the 15-minute poll, its exception for "urgent" todos only, and done todos still taking room on cards.

## Terms

| Concept | UI term | 中文 | 日本語 (draft) |
| --- | --- | --- | --- |
| Code repository | Repository | 代码仓库 | リポジトリ |
| Followed ref | Followed branch | 跟踪分支 | 追跡ブランチ |
| Pull request | Pull request | 合并请求 | プルリクエスト |
| Code answer | Answer from the code | 代码解答 | コードからの回答 |
| Code changed since | Code changed since | 代码已更新 | コードが更新されました |
| Pinned answer | Pinned | 已固定 | 固定済み |
| Drift | Documents and product disagree | 文档与产品不一致 | 文書と製品の不一致 |
| Audit | Check documents against code | 文档与代码核对 | 文書とコードの照合 |
