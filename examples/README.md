# Example corpora

Each folder is one tenant's documents with the answers a run is checked against. The
measurement harness ([`apps/bench`](../apps/bench)) runs the engine over them with
`pnpm bench`, and its tests hold each run to its answers. Copies of outside text keep their
source and date, so runs repeat without the network. A Chinese copy is in
[README.zh.md](README.zh.md); if the two differ, this English version wins.

| Corpus | Text | What it measures | Run | Test |
| --- | --- | --- | --- | --- |
| [corpus](corpus/README.md) | Written for the demo, in Chinese: 38 documents of a fictional manufacturer, folder ACLs, Feishu fixtures, the days each file changed | The ingest pipeline end to end, with planted duplicates and conflicts | `pnpm bench ingest examples/corpus` | `engine.test.ts` |
| [control](control/README.md) | Written for the check, in English: 14 documents, 8 cases | Governance case by case, where every case has one right answer | `pnpm bench ingest examples/control` | `control.test.ts` |
| [gitlab-expenses](gitlab-expenses/README.md) | Real: GitLab's expense policy at 21 versions, 2020 to 2026 | Extraction and governance on knowledge that changes, against a timeline read by hand | `pnpm bench replay examples/gitlab-expenses` | `history.test.ts` |
| [kubernetes-docs](kubernetes-docs/README.md) | Real: five Kubernetes pages in English with their official Chinese and Japanese translations | One value and one source per fact across languages; 12 questions | `pnpm bench ingest examples/kubernetes-docs` | `kubernetes.test.ts` |
| [company-drive](company-drive/README.md) | Real public text, arranged as a company drive with old copies, revisions and lagging translations | 150 keyed questions against a mature RAG and long context, raw and governed, the reading check, and cost | `pnpm bench ingest examples/company-drive` | `company-drive.test.ts`, `cost.test.ts` |
| [decisive-test](decisive-test/README.md) | Real public text in two topics, GitLab's expense policy and Kubernetes networking and storage, with old copies, lagging translations, team pages, drafts and announcements, inside 17.8M tokens searched but not governed | The decisive test: 92 keyed facts, 276 questions in three languages, by how the documents mislead | `pnpm bench ingest examples/decisive-test` (needs the searched corpus, see its README) | `decisive-test.test.ts` |
| [code-questions](code-questions/README.md) | Eight questions about this repository, with right answers and a coding agent's answers | The first measurement behind [Code repositories as a knowledge source](../docs/design/code-repositories.md); not run by code | | |

Tests are in `apps/bench/test/`. A new corpus gets its own folder with a README and a
Chinese copy, a row here, and a test that holds a run to its answers.
