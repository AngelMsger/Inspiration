# 示例语料

每个文件夹是一个租户的文档，以及检查运行结果所用的答案。测量工具（[`apps/bench`](../apps/bench)）用 `pnpm bench` 在这些语料上运行引擎，它的测试要求每次运行与答案一致。复制来的外部文本保留来源和日期，所以无需网络也能重复运行。本文是 [README.md](README.md) 的中文副本；两者不一致时以英文版为准。

| 语料 | 文本 | 测量什么 | 运行 | 测试 |
| --- | --- | --- | --- | --- |
| [corpus](corpus/README.zh.md) | 为演示编写的中文文档：19 篇，带文件夹 ACL 和飞书样例 | 摄取流水线端到端，埋有重复和冲突 | `pnpm bench ingest examples/corpus` | `engine.test.ts` |
| [control](control/README.zh.md) | 为对照检查编写的英文文档：14 篇，8 个样例 | 逐个样例检查治理，每个样例只有一个正确答案 | `pnpm bench ingest examples/control` | `control.test.ts` |
| [gitlab-expenses](gitlab-expenses/README.zh.md) | 真实文本：GitLab 报销政策的 21 个版本，2020 至 2026 年 | 在不断变化的知识上测量抽取和治理，对照人工整理的时间线 | `pnpm bench replay examples/gitlab-expenses` | `history.test.ts` |
| [kubernetes-docs](kubernetes-docs/README.zh.md) | 真实文本：五个 Kubernetes 英文页面及其官方中文、日文译本 | 跨语言时每个事实只有一个值和一个来源；12 个问题 | `pnpm bench ingest examples/kubernetes-docs` | `kubernetes.test.ts` |
| [company-drive](company-drive/README.zh.md) | 真实的公开文本，按公司网盘的样子摆放，含旧副本、旧修订和滞后的译本 | 150 个带答案的问题，对比成熟 RAG 和长上下文（原样与治理后）；阅读检查；成本 | `pnpm bench ingest examples/company-drive` | `company-drive.test.ts`、`cost.test.ts` |
| [code-questions](code-questions/README.zh.md) | 关于本仓库的八个问题，含正确答案和一个编码 agent 的回答 | [代码仓库作为知识来源](../docs/zh/design/code-repositories.md) 背后的第一次测量；不由代码运行 | | |

测试在 `apps/bench/test/` 中。新语料要有自己的文件夹、README 及其中文副本、本表中的一行，以及一个要求运行结果与答案一致的测试。
