# Decisions and open questions

The product owner's decisions in force, oldest first, and the questions still open. The design docs give the reasons behind each decision; this page is the one list of them. A new decision goes at the end of the table, and a question that is answered is marked so and keeps its number. A Chinese copy is in [zh/decisions.md](zh/decisions.md); if the two differ, this English version wins.

## Decisions in force

| Decided | Decision |
| --- | --- |
| 2026-10-22 | Product name Inspiration; Artifact-level page presentation is committed scope; capabilities first, accepted through MCP, REST and the CLI |
| 2026-10-23 | TypeScript everywhere except a Python parsing worker; descriptive component names; every change through a PR |
| 2026-10-23 | A mocked end-to-end prototype of every stage first; real model access only after it runs; engine and UI iterate together on measured volumes |
| 2026-10-24 | Three IDs: tenant, user (account) and member |
| 2026-10-24 | Two knowledge domains: My space private, shared spaces governed top down; source permissions only warn; publishing moves knowledge; credentials decide freshness only |
| 2026-10-24 | Statements at scale: two outlines, governance levels, grouped review; uploads start as Reference; a weekly budget of 10; reference never blocks a governed statement |
| 2026-10-24 | Engine and business layer split; Logto as identity provider; SaaS first with private deployment as a second profile; My space locked on leaving and erased after 30 days; approvers see only a request's items |
| 2026-10-24 | Connectors on vendor APIs, vendor CLIs only in the sandbox, a credential broker |
| 2026-10-24 | Three views and two trees for reading |
| 2026-10-24 | Pipeline boundaries: normalization before extraction and indexing, retrieval owns every index, freshness emits signals only, collaboration owns every todo |
| 2026-10-24 | English, Chinese and Japanese from the first release; no Chinese in code or comments; docs in English with a Chinese copy |
| 2026-10-26 | Three product roles: super admin, owner (always named with its scope) and member; finer roles stay internal and product roles are bundles of them |
| 2026-10-26 | Usage follows mainstream AI products: seats fill a company pool, members have default caps, the super admin sees usage but never content; details come with billing |
| 2026-10-26 | Words: Company in English, 企业 in Chinese, 企業 in Japanese, never "workspace"; governance levels 严格, 宽松 and 仅检索 in Chinese |
| 2026-10-26 | Source changes: knowledge never disappears silently; a deleted source is kept and marked until its owner decides; a large change is reviewed once, as a whole |
| 2026-10-26 | Knowledge is language-neutral and language is only how it is expressed |
| 2026-10-26 | Anyone who holds a credential to a source may import from it; no blocking by email domain or Feishu organization; verified domains only for joining |
| 2026-10-26 | Agents running on their own only read or propose; a member's explicit request is the approval for an edit within that member's rights (`knowledge.write`) |
| 2026-10-26 | Engine and business layer in one monorepo, a folder per layer (`libs/`, `engine/`, `business/`, `apps/`), with one-way dependencies checked by the manifest test |
| 2026-10-26 | One integration per vendor serves both sync and agent tools; tools act as the member; only code we did not write runs in the sandbox |
| 2026-10-27 | Concrete before abstract: an imported source opens as a document in its own shape, and knowledge is revealed from it step by step, concrete to abstract; someone new starts in their documents, not in knowledge cards |
| 2026-10-27 | The Sources tree is called the Documents tree (文档树, ドキュメントツリー), the word people use for their material, although it also holds chats and sheets; a source is still a source wherever a page cites it |
| 2026-10-27 | Connections that bring knowledge in are Source connections (来源连接, ソース接続), and "connection" alone always means one; the apps and agents that use knowledge are Apps with access (proposed: 使用知识的应用, アクセスを許可したアプリ), never connected apps. There is no Verified domains page: the email domain for joining sits in Members, and the company's Feishu organization beside Source connections |
| 2026-10-27 | Validate the knowledge core (extraction and governance) on real models first; the business layer and permissions can wait. Every run leaves a trace in the repo and its replies are kept, so nothing is paid for twice |
| 2026-10-28 | Inspiration must lead a mature RAG by at least 10 points on stale and conflicting information, within one topic's material, on fast and cheap models as well as strong ones; organizing knowledge must never lose the right value |
| 2026-11-01 | Cost, accuracy and latency are judged together. The cheapest provider runs the tests; a cheap GPT model or Claude Haiku only backs a conclusion. If governance cannot set the product apart, the fallback is a knowledge and identity gateway for agents |
| 2026-11-02 | Model credentials use `INSPIRATION_DEEPSEEK_API_KEY`, `INSPIRATION_OPENAI_API_KEY` and `INSPIRATION_ANTHROPIC_API_KEY`; configs name them explicitly. See [Development](development.md) for the current migration behavior |
| 2026-11-04 | The validation's result is accepted: Inspiration answers stably more right than a mature RAG, short of 10 points, which stay a long-term goal for a larger dataset close to real use; tuning runs stop, and an MVP that closes the business flow comes next |
| 2026-11-05 | The MVP is adopted with its five decisions as recommended: three to five people try it in Chinese for two weeks, on one server in Hong Kong or Singapore; live Feishu after Gate B; CNY 100 a month for models; a standing "Decide for me" offered to owners |
| 2026-11-05 | Outside research is supporting input only: public pages say that research supports a claim and link it, without naming its authors |
| 2026-11-05 | The MVP reranker stays on the CPU; reduce candidate pools and check search coverage for free. Japan is also acceptable for the hosted trial, alongside Hong Kong and Singapore; no hosting provider is selected by this decision |
| 2026-11-05 | The validation spec and the UI philosophy are adopted, and validation stays paused for the MVP. Scoped owners are 负责人 in Chinese (空间负责人, 主题负责人, 页面负责人, 流程负责人), not the 维护人 proposed on 2026-10-26 |
| 2026-11-11 | Validate on the owner’s local computer with direct Confluence Data Center / Server and Feishu document connections, using a DeepSeek API key; close the local experience gaps before live validation. See [Local validation](local.md). |
| 2026-11-13 | Prioritize cloud models for local Confluence/Feishu validation, without local model dependencies. DeepSeek plus hosted embedding/reranking, recoverable indexing and small import scopes come before further architecture exploration. See [Local validation](local.md). |
| 2026-11-13 | The whole product needs a Drive layer, with the Documents tree managing content as files and substantial interaction design beyond storage. Knowledge materialized at a useful granularity as special files, and original uploads as files, are directions to explore; their detailed model and interactions are proposed in [Drive and knowledge files](design/drive.md). |

Earlier agent memory was reconciled with the repository on 2026-11-12; the table retains
the original decision dates. Temporary spending approvals and hosting estimates remain
historical context, not new budgets or deployment commitments.

## Open questions

1. **Confirm the boundary between the super admin and owners** ([overview, section 4](overview.md#4-users-and-roles)). Half answered: owners are 负责人 in Chinese (2026-11-05).
2. **Confirm the trade-off in compiled-knowledge permissions:** at `internal` and `confidential`, readers learn that relevant restricted material exists and whom to ask, never its content; `secret` material leaves no trace (see [Permissions](architecture.md#permissions)).
3. **Review the proposed Japanese terms** in the [glossary](overview.md#appendix-a-glossary-in-three-languages).
4. **Which SaaS region opens first,** and how gates G2 and G3 change for SaaS first.
5. **Which model providers serve each region,** and at which sensitivity labels.
6. **Which connectors come second and third outside China** (for example Confluence, Notion, Google Drive, SharePoint), and which first design partner and industry the pilot targets.
7. **Answered: the order of the remaining stages.** The validation on real models came first (2026-10-27 to 2026-11-04), and the [MVP](design/mvp.md) sets the order now (2026-11-05).
8. **Two details of the agent tools:** whether `search` ranks blocks and statements together by default, and whose budget pays for the model call inside `ask`.
9. **Answered: a standing "Decide for me" counts as the member's approval** under AG-4 ([overview, section 6.7](overview.md#67-agents)), as a request made in advance, scoped to kinds of decision and pausable; the MVP offers it to owners on their first inbox visit (its decision 5, 2026-11-05). Whether every vote in a joint approval may be delegated waits for joint approval ([Decide for me](design/decide-for-me.md)).
10. **Drive's file model and interactions:** knowledge-file granularity, original uploads as first-class files, navigation, creation and update behavior, and the first delivery slice ([Drive proposal](design/drive.md)). The Drive layer and file-based Documents tree are the decided direction; these details remain proposed.
