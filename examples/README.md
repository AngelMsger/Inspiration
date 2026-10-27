# Example corpora

Each folder is one tenant's documents with the answers a run is checked against. The
measurement harness ([`apps/bench`](../apps/bench)) runs the engine over them with
`pnpm bench`, and its tests hold each run to its answers. Copies of outside text keep their
source and date, so runs repeat without the network. A Chinese copy is in
[README.zh.md](README.zh.md); if the two differ, this English version wins.

| Corpus | Text | What it measures | Run | Test |
| --- | --- | --- | --- | --- |
| [corpus](corpus/README.md) | Written for the demo, in Chinese: 19 documents, folder ACLs, Feishu fixtures | The ingest pipeline end to end, with planted duplicates and conflicts | `pnpm bench ingest examples/corpus` | `engine.test.ts` |
| [control](control/README.md) | Written for the check, in English: 14 documents, 8 cases | Governance case by case, where every case has one right answer | `pnpm bench ingest examples/control` | `control.test.ts` |
| [gitlab-expenses](gitlab-expenses/README.md) | Real: GitLab's expense policy at 21 versions, 2020 to 2026 | Extraction and governance on knowledge that changes, against a timeline read by hand | `pnpm bench replay examples/gitlab-expenses` | `history.test.ts` |
| [kubernetes-docs](kubernetes-docs/README.md) | Real: five Kubernetes pages in English with their official Chinese and Japanese translations | One value and one source per fact across languages; 12 questions | `pnpm bench ingest examples/kubernetes-docs` | `kubernetes.test.ts` |
| [company-drive](company-drive/README.md) | Real public text, arranged as a company drive with old copies, revisions and lagging translations | 150 keyed questions against plain retrieval and long context, the reading check, and cost | `pnpm bench ingest examples/company-drive` | `company-drive.test.ts`, `cost.test.ts` |
| [code-questions](code-questions/README.md) | Eight questions about this repository, with right answers and a coding agent's answers | The first measurement behind [Code repositories as a knowledge source](../docs/design/code-repositories.md); not run by code | | |

Tests are in `apps/bench/test/`. A new corpus gets its own folder with a README and a
Chinese copy, a row here, and a test that holds a run to its answers.
