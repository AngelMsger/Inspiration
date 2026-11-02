# The decisive test

The corpus of the decisive test in [docs/design/validation.md](../../docs/design/validation.md):
does the knowledge base answer stale and conflicting questions at least 10 points better than
a mature RAG, at a corpus size a company really has, and at what cost and speed. Two topics
that people ask about are kept in the spaces they really live in, with the copies, team pages,
drafts and translations that mislead about them, inside 17.8 million tokens of real text that is
searched but not governed. 92 facts, each asked in English, Chinese and Japanese: 276
questions. A Chinese copy is in [README.zh.md](README.zh.md); if the two differ, this English
version wins.

Nothing here has been run with paid models yet: the paid run waits for the product owner's
yes, at the size the free size check picks (the spec says how). The checks that need no model
run in `apps/bench/test/decisive-test.test.ts`: every key quote is in its file, verbatim, at
the revision `files.yaml` gives, and every file of the topics is listed.

## The topics

| Folder | Space in `corpus.yaml` | What it holds |
| --- | --- | --- |
| `gitlab/handbook/` | Handbook, governed, authority 0.9 | GitLab's finance section and two pages it links (benefits, gifts) at handbook commit 52419353 (2026-10-30), unchanged; and `finance/expenses.ja.md`, a Japanese translation of six sections of the expense policy as it stood on 2026-05-14, before three limits changed |
| `gitlab/legacy/` | Legacy handbook, governed, 0.9 | the expense policy under the path the handbook used before its 2023 move, as of 2023-05-17 |
| `gitlab/teams/` | Team pages, governed, 0.7 | five team pages that restate the policy, some with older values or a condition dropped, and a finance draft |
| `gitlab/drive/` | Shared drive, reference, 0.5 | a 2022 download of the policy, a team member's suggested limits, an AP proposal, and an export of the finance announcements channel |
| `kubernetes/docs/` | Kubernetes docs, governed, 0.9 | the Services and networking and Storage sections of kubernetes.io, fetched 2026-11-02, in English, Chinese and Japanese (89 pages); eight Japanese pages still give a feature's older state |
| `kubernetes/legacy/` | Kubernetes docs mirror, governed, 0.9 | two pages as old docs branches hold them: Topology Aware Hints (v1.26, before the rename) and Persistent Volumes (v1.22, before volume populators moved to a page of their own) |
| `kubernetes/platform/` | Platform team, governed, 0.7 | a platform team's cluster standards, networking runbook and storage FAQ |
| `kubernetes/drive/` | Platform drive, reference, 0.5 | a draft of next year's storage standards and an export of the platform announcements channel |

`files.yaml` says where each file comes from, at which revision, when it was last changed (the
loader gives each file that modified time) and what it is: `current`, a `stale_copy` of a
file it names, or `constructed`, written for this test, with what it changes and what it is
based on. The handbook is © GitLab Inc. and contributors, [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/);
the Kubernetes pages are © The Kubernetes Authors, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
Each Kubernetes page is the page's content element as served, unchanged, in a minimal document
with its title and language; `kubernetes/sources.yaml` gives each page's URL, commit, footer date
and SHA-256.

## The searched corpus

The rest of GitLab's handbook at the same commit (4,198 Markdown pages in all, about 10.7
million tokens) and the rest of the Kubernetes docs in the three languages, fetched 2026-11-02
from the sitemaps (1,056, 1,035 and 435 pages in all, about 7.1 million tokens). They are `search_only`
sources in spaces of their own, without the topics' pages, so search and the mature RAG look
through everything while each long context reads only its question's topic. They are not in
the repository: put them under `.data/decisive-test/` (`handbook/` is `content/handbook` of
[gitlab-com/content-sites/handbook](https://gitlab.com/gitlab-com/content-sites/handbook) at
52419353ea755a1ac823553385f8636ff2fcde17; `kubernetes/{en,zh-cn,ja}/` holds each page under its
path with `/` as `__`), each root with an `.acl.yaml` of `readers: [tenant]`. A folder source's
`sample` keeps a stable share of its files, for the size check's smaller corpora.

## The cases

Each fact is built to one way the documents mislead, and says whether it was found in the
documents as they are (`natural`) or built for the test on real text (`constructed`).

| Pattern | GitLab | Kubernetes | What misleads |
| --- | --- | --- | --- |
| Renamed or moved | 9 natural | 2 natural | an old copy under a path no longer in use states an older value |
| Lagging translation | 3 constructed | 8 natural | a translation states the value its original had |
| Restated and lagging | 8 constructed | 4 constructed | a team page restates an older value |
| Newer but not authoritative | 7 constructed | 2 constructed | a later draft, proposal or personal copy states another value |
| Governed pages disagree | 4 natural, 2 constructed | 2 constructed | two pages in use state different values: a right answer names both |
| Changed elsewhere | 6 constructed | 3 constructed | an announcement changes a value the governed page still states |
| Distorted restatement | 6 constructed | 2 constructed | a summary drops a condition or turns a maximum into a default |
| Control | 14 natural | 10 natural | nothing: the same value wherever it is stated |

The GitLab facts are about the travel and expense policy (limits, lead times, insurance,
gifts); the Kubernetes facts are feature states and limits from the docs, and the platform
team's own settings.

## The answer key

`keys.yaml` gives each fact its values by the day each took effect and, for every value, where
the corpus states it: the file, its revision and the words, verbatim. It was written by reading
the files, not from the engine. The value in effect on `asked_on` (2026-11-02) answers a
question; an answer that gives an older value, or a `misleading` one (a draft's, a distorted
summary's), and not the value in effect is stale. For a fact whose governed pages disagree,
`conflicting` lists the other value: an answer that names only some of them is `one_sided`.
`topics` names each topic's spaces. `questions.yaml` asks each fact once in each language.
A Kubernetes value took effect on the day its release came out.

## Limits

- The Kubernetes feature states are in the models' training data: a model may know the newer
  state without reading it, which helps every way of answering alike.
- Pages of the searched corpus may state a topic's value too. An answer that gives the right
  value but cites only such a page counts as `wrong_citations`, not right.
- The two old docs pages are dated the day the next release replaced them; their branches'
  last commit to each file is not recorded.
- The key has had one reader. A second reads it before the paid run.
