# Inspiration

Inspiration 把企业分散的文档、审批流程和对话变成一个活的知识库。它从来源中抽取带有确切证据的陈述，在来源变化时保持知识新鲜，把知识编译成带引用的页面、SOP 和交互式视图，并按读者自己的权限提供给人和 agent。

本文是 [README.md](README.md) 的中文副本；两者不一致时以英文版为准。

本仓库是一个 monorepo，包含整个产品。引擎（摄取、知识流水线、存储、权限、模型访问和 agent API）已经构建；业务层（身份、租户和账号、发布策略）是下一步，放在自己的文件夹里，只通过引擎的 API 和事件使用引擎。Web 应用已经有了第一批界面，用于演示。检查保证每一层、每个组件都不越过自己的边界（见[架构](docs/zh/architecture.md)）。

## 状态

引擎的基础和知识流水线已构建并有测试；业务层尚未开始。Web 应用在引擎的 HTTP API 上展示设计画布里阅读部分的界面，用一个替身代替登录，供演示使用。[`components.yaml`](components.yaml) 列出每个组件及其状态（已构建、进行中或已计划），每个包的 `src/index.ts` 说明它做什么。[总览](docs/zh/overview.md)说明哪些已构建、接下来做什么、哪些仍未决定。

除解析 worker 外全部是 Node 22 上的 TypeScript；解析 worker 用 Python，因为最好的文档解析器是 Python 的。

## 快速开始

需要 Node 22.18 或更高版本、pnpm 10（`corepack enable`），以及带 Compose 的 Docker。

```bash
make install       # pnpm 依赖
make up            # ParadeDB（Postgres 16 + pgvector + pg_search）、Valkey、SpiceDB
make migrate       # 所有已安装组件的 SQL 迁移
make authz-schema  # SpiceDB schema
make check         # Biome、tsc、契约是否最新、所有测试（要求运行环境已启动）
```

不用 make 时，对应的步骤是 `pnpm install`、`docker compose -f infra/compose.yaml up -d --wait`、`pnpm exec inspiration-migrate`、`pnpm exec inspiration-authz-schema` 和 `INSPIRATION_REQUIRE_STACK=1 pnpm test`。

需要运行环境的测试在环境未启动时会跳过，除非设置了 `INSPIRATION_REQUIRE_STACK=1`（CI 中就是这样）。每个测试都有自己的数据库（从已迁移的模板复制）和自己的 Valkey 键前缀。`make test-unit` 只运行什么都不需要的测试。

要在一个语料上运行引擎并打印结果，使用测量工具：

```bash
pnpm bench ingest examples/corpus            # 演示租户，在内存中运行
pnpm bench ingest examples/corpus --stack    # 在 INSPIRATION_* 设置指定的 Postgres 和 Valkey 上运行
pnpm bench synthesize /tmp/synth --documents 2000 && pnpm bench ingest /tmp/synth --stack
pnpm bench replay examples/gitlab-expenses   # 一份真实政策的 21 个历史版本
pnpm bench ask examples/kubernetes-docs "Kubernetes 集群最多可以有多少个节点？"
```

[`examples/README.zh.md`](examples/README.zh.md) 列出每个语料、它测量什么、如何运行，以及哪个测试要求它与答案一致。

要看产品本身，运行演示。它用开发用的模型读完演示租户，不花钱，然后在 http://127.0.0.1:5173 提供 Web 应用（账户菜单里可以切换身份和界面语言）。以张敏的身份在待办里裁决首年年假的冲突，再去看新人入职指南里的 7 天被标为已过时。以空间负责人周敏的身份维护“公司制度”，放入新版差旅费管理办法：一秒之内，回答就引用 650，只剩新人入职指南还写着 600：

```bash
pnpm demo                                    # 引擎在 4100 端口，Web 应用在 5173 端口
pnpm engine serve examples/corpus            # 只启动引擎的 HTTP API
pnpm snapshot dist/snapshot                  # 把演示脚本录成一个静态页面
```

演示脚本（`examples/corpus/script.yaml`）列出这些步骤，以及每一步由谁来做。`pnpm snapshot` 对着引擎走一遍脚本，
写出一个从录像作答的静态页面，页面底部有一条向导，按步骤以相应的人的身份打开，所以任何人拿到链接就能跟着演示走，
不需要引擎。脚本没有问的问题、没有做的操作，页面会说明这一步没有录。这个页面装着演示租户里每个人能读到的全部内容，
谁打开都能看到：在页面里以某人的身份操作只是模拟，不是权限控制。所以只录合成的演示语料，或者整份内容都允许
所有拿到链接的人阅读的语料。

不启动模型服务也可以试用模型网关，用假的模型提供方运行它：

```bash
make gateway
curl -s localhost:8100/healthz
```

## 目录结构

```
libs/contracts      schema/*.yaml 是唯一事实来源；codegen/ 生成 src/generated.ts 和 src/events.ts
libs/kernel         设置、日志、插件注册表、迁移运行器、blob 存储、数据库连接池
libs/eventbus       事务性 outbox、转发到 Valkey Streams、消费者、内存事件总线
libs/testkit        针对 compose 运行环境的测试夹具
engine/<component>  每个引擎组件一个包（见 components.yaml）
business/           业务层的包（尚无）；engine/ 和 libs/ 从不依赖它们
apps/engine         引擎进程：把组件接到存储、事件总线和 blob 存储上；HTTP API
apps/web            产品 Web 应用，基于引擎的 HTTP API，带一个替身后端（pnpm demo）和录像（pnpm snapshot）
apps/bench          测量工具（pnpm bench）：在语料上运行引擎、生成报告、核对答案
apps/site           产品官网（pnpm site）：三种语言的静态页面和一段演示动画
examples/<corpus>   语料，以及核对运行结果所用的答案（见 examples/README.zh.md）
infra/              原型运行环境的 docker compose，以及运行时用的本地向量模型服务
config/             模型网关的示例配置
docs/               总览、引擎参考和设计文档，索引在 docs/README.md
docs/zh/            每篇文档的中文副本
test/               仓库级检查：组件清单、语言、文档、文件路径
```

业务组件将放在 `business/` 中，与 `engine/` 和 `libs/` 并列（见[架构](docs/zh/architecture.md)中的“一个仓库，每层一个目录”）。

## 文档

从[总览](docs/zh/overview.md)（[English](docs/overview.md)）开始读：产品需求与技术架构合为一篇，包括场景、图示、可行性检查，以及已构建和已计划的部分。[docs/zh/README.md](docs/zh/README.md) 列出每篇文档及其状态：已采纳、提议中或已取代。

[AGENTS.md](AGENTS.md) 是给任何构建组件的人或 agent 的规则，也包括保持仓库精简的规则。
