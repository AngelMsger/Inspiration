# 技术栈的许可证

这是一份指导选型的工程摘要，不是法律意见。在第一次向客户交付之前，请法律顾问确认。本文是英文版
[licensing.md](../licensing.md) 的中文副本，两者不一致时以英文版为准。

| 组件 | 许可证 | 用途 |
| --- | --- | --- |
| PostgreSQL | PostgreSQL Licence | 数据库服务器 |
| pgvector | PostgreSQL Licence | Postgres 扩展 |
| ParadeDB pg_search（以及 ParadeDB 镜像） | AGPL-3.0 | 用于 BM25 的 Postgres 扩展 |
| Valkey | BSD-3-Clause | 事件流和缓存 |
| SpiceDB | Apache-2.0 | 权限服务 |
| Node.js | MIT | 运行时 |
| @authzed/authzed-node、@grpc/grpc-js | Apache-2.0 | access-control 中的 SpiceDB 客户端 |
| pg（node-postgres）、ioredis | MIT | 数据库和 Valkey 驱动 |
| Hono、@hono/node-server | MIT | model gateway 的 HTTP 服务 |
| Ajv、ajv-formats | MIT | 契约校验 |
| yaml | ISC | 配置和 schema 文件 |
| json-schema-to-typescript | MIT | 构建时代码生成 |
| TypeScript | Apache-2.0 | 构建时类型检查 |
| Vitest | MIT | 测试 |
| Biome | MIT 或 Apache-2.0 | 代码检查和格式化 |

parsing 工作进程用 Python。它的库列在 `engine/parsing/worker/requirements.txt`：

| 库 | 许可证 | 用途 |
| --- | --- | --- |
| python-docx | MIT | 读取 Word 文件 |
| python-pptx | MIT | 读取 PowerPoint 文件 |
| openpyxl | MIT | 读取 Excel 文件 |
| pdfminer.six | MIT | 读取 PDF 文件的文本层 |
| lxml | BSD-3-Clause | python-docx 和 python-pptx 底层的 XML 库 |

它们依赖的库也都是宽松许可证：Pillow（MIT-CMU）、XlsxWriter（BSD-2-Clause）、et_xmlfile（MIT）、charset-normalizer（MIT）、cryptography（Apache-2.0 或 BSD-3-Clause）和 typing_extensions（PSF-2.0）。以后支持扫描件和版面分析时，注意 copyleft 的 PDF 库（PyMuPDF 是 AGPL-3.0）。

## 需要注意的地方

**pg_search 是 AGPL-3.0。** 把它不加修改地作为单独的数据库扩展运行，并通过 SQL 与它通信，按通常对 AGPL 的理解，
不会使 Inspiration 自己的代码成为衍生作品。如果我们修改 pg_search 并通过网络提供服务，或者把它作为本地部署交付的
一部分交给客户，义务就会产生，此时我们必须提供它的源代码和许可证。如果某个客户无法接受，可选的做法有：

1. 购买 ParadeDB 的商业许可证。
2. 替换关键词索引。BM25 位于 `KeywordIndex` 插件协议之后，所以一个 OpenSearch（Apache-2.0）实现可以替换
   `PgSearchIndex`，而不改动 retrieval。届时中文分析器需要 OpenSearch 上的 IK 或 jieba 插件。

**用 Valkey 而不是 Redis。** Redis 7.4 及以后版本采用 RSALv2、SSPLv1 或 AGPLv3 许可，这会让本地部署交付变得复杂。
Valkey 是 BSD 许可的分支，协议相同，并可使用同一个客户端（`ioredis`），所以代码中没有任何地方依赖运行的是哪一个。

**模型权重**不属于本仓库。一个部署在网关中配置的每个模型（Qwen、DeepSeek、bge、PaddleOCR-VL 等）都有自己的
许可证，部署方必须检查，特别是商业用途和微调变体。

## 测试数据

`examples/` 中的示例数据由我们编写，README 注明来源的除外。[`examples/gitlab-expenses`](../../examples/gitlab-expenses/README.zh.md)
包含 GitLab 公开的差旅与费用制度的 21 个版本，© GitLab Inc. 及贡献者，采用 CC BY-SA 4.0 许可。它们原样复制，并链接到各自的
commit，这正是该许可要求的署名；修改后的副本必须采用相同的许可。[`examples/kubernetes-docs`](../../examples/kubernetes-docs/README.zh.md)
包含 Kubernetes 文档中五个页面的英文、中文和日文内容，© The Kubernetes Authors，采用 CC BY 4.0 许可，`sources.yaml`
给出每个页面的标题、链接和 commit。测试数据不包含在交付给客户的内容中。
