# 开发

验证自己的文档，请先看[本地验证](local.md)：`pnpm local` 运行持久化应用，并直接连接 Confluence 和飞书。

如何在本仓库里构建、测试和运行 Inspiration：运行环境、检查、测量工具和演示。产品是什么、往哪里走，见 [README](../../README.zh.md) 和[总览](overview.md)；修改任何东西的规则见 [AGENTS.md](../../AGENTS.md)。本文是 [docs/development.md](../development.md) 的中文副本；两者不一致时以英文版为准。

## 接续开发

先把 MVP 做到可用，验证完整业务流程；付费基准调优仍然暂停。2026-11-11 的[本地验证](local.md)决定增加了持久化本地运行，以及直接连接 Confluence 和飞书的能力，没有重启决定性测试。

| 要恢复的上下文 | 权威出处 |
| --- | --- |
| 产品方向、已采纳决定和待决问题 | [总览](overview.md)、[决定](decisions.md)、[MVP](design/mvp.md) |
| 实际可用的能力及其位置 | [README 路线图](../../README.zh.md#路线图)、[组件清单](../../components.yaml)、代码和 `apps/bench/test/` 中的关口检查 |
| 契约、身份和分层边界 | [契约](contracts.md)、[架构](architecture.md)、`libs/contracts/schema/` |
| 证据、适用边界和可复用的付费回复 | [验证](design/validation.md)、[运行记录](../../apps/bench/runs/README.zh.md) |
| 产品用语与交互 | [术语表](overview.md#附录-a-三种语言的词表)、[界面理念](design/ui-philosophy.md) |

把 Agent 笔记中有价值的内容合入这些已有出处，同一个 PR 更新中英文。文档先给结论，紧接着列出需要产品负责人决定的事项，最新讨论材料留在仓库里。旧线程分工、预览产物 ID、机器限制和特定时期的价格都是历史背景，不是当前配置。只有 MVP 路径上的 issue 保持打开；值得保留的其他想法进入 MVP 的 [MVP 之后](design/mvp.md#mvp-之后)表，关联标记为 `deferred` 的 issue，并写明重新打开的条件。

每个改动都通过 PR，并在合并前通过 CI。

## 安装和检查

需要 Node 22.18 或更高版本（Node 24 也可以）、pnpm、Python 3.10 或更高版本，以及带 Compose 的 Docker。`package.json` 在 `packageManager` 里固定了 pnpm 10.28.0，corepack（`corepack enable`）和 10 及以上的任何 pnpm 都会照它切换；它还为 Volta 固定了 Node 22 和 pnpm 10.28.0。这个固定是必要的：Volta 通过 `bin/pnpm.cjs` 启动 pnpm，而 pnpm 11 及以后不再带这个文件，所以 Volta 里的 pnpm 11 或更高版本在本仓库之外会报 `Cannot find module …/bin/pnpm.cjs`，在本仓库里则能正常运行。

```bash
make install       # pnpm 依赖，以及 .venv 里解析 worker 的 Python 库
make up            # ParadeDB（Postgres 16 + pgvector + pg_search）、Valkey、SpiceDB
make migrate       # 所有已安装组件的 SQL 迁移
make authz-schema  # SpiceDB schema
make check         # Biome、tsc、契约是否最新、除耗时很长的语料运行外的所有测试（要求运行环境已启动）
make check-full    # 同上，再加上耗时很长的语料运行，与 CI 相同
```

不用 make 时，对应的步骤是 `pnpm install`、`python3 -m venv .venv && .venv/bin/pip install -r engine/parsing/worker/requirements.txt`、`docker compose -f infra/compose.yaml up -d --wait`、`pnpm exec inspiration-migrate`、`pnpm exec inspiration-authz-schema` 和 `INSPIRATION_REQUIRE_STACK=1 INSPIRATION_QUICK=1 pnpm test`（`make check-full` 则不加 `INSPIRATION_QUICK`）。

需要运行环境的测试在环境未启动时会跳过，除非设置了 `INSPIRATION_REQUIRE_STACK=1`（CI 中就是这样）。每个测试都有自己的数据库（从已迁移的模板复制）和自己的 Valkey 键前缀。`make test-unit` 只运行什么都不需要的测试。

`make check` 不跑三项要几分钟的语料运行：整个共享盘测试集，以及在运行环境上的 Kubernetes 页面和 GitLab 制度历史（后两项仍在内存中运行，检查的是同样的数字）。在产品负责人的笔记本上，完整的测试用了 162 秒，其中共享盘测试集占 149 秒。`make check-full` 运行全部测试，与 CI 相同；改动引擎读取、治理或回答的方式时，在提拉取请求前运行它，因为这些数字由那几项运行把关。

密钥和密码不进仓库。配置里只写存放密钥的环境变量名（`api_key_env`），`.env` 被 git 忽略。CI 的 `secrets` 任务用 Gitleaks 扫描所有分支的每一个提交，规则是它的默认规则加上 DeepSeek、OpenAI 和 Anthropic 密钥的格式（`.github/gitleaks.toml`）；发现任何一处就失败，输出时隐去密钥内容。`infra/compose.yaml` 里的密码是公开的开发默认值，所以运行环境的端口只监听 127.0.0.1；其他人也能登录的机器要自己设置 `INSPIRATION_PG_PASSWORD` 和 `INSPIRATION_SPICEDB_KEY`。

除解析 worker 外全部是 Node 22 上的 TypeScript；解析 worker 用 Python，因为最好的文档解析器是 Python 的。引擎把 Word、PowerPoint、Excel 和 PDF 文件发给 `INSPIRATION_PARSING_URL` 上的 worker；`pnpm parsing` 在默认的 8790 端口启动它。没有它时，这些文件读取失败并说明 worker 连不上；其他格式不需要它。[`components.yaml`](../../components.yaml) 列出每个组件及其状态（已构建、进行中或已计划），每个包的 `src/index.ts` 说明它做什么。

真实模型配置使用 `INSPIRATION_DEEPSEEK_API_KEY`、`INSPIRATION_OPENAI_API_KEY` 和 `INSPIRATION_ANTHROPIC_API_KEY`。提供方读取 `api_key_env` 指定的变量，没有从这些名称统一自动回退到旧的无前缀名称的机制。迁移旧环境时，设置配置指定的名称。改变进程环境后需要重启进程；如果会话平台只在启动时注入变量，就新建会话或重启容器。

## 在语料上运行引擎

要在一个语料上运行引擎并打印它产生了什么，使用测量工具：

```bash
pnpm bench ingest examples/corpus            # 演示租户，在内存中
pnpm bench ingest examples/corpus --stack    # 在 INSPIRATION_* 设置指向的 Postgres 和 Valkey 上
pnpm bench synthesize /tmp/synth --documents 2000 && pnpm bench ingest /tmp/synth --stack
pnpm bench replay examples/gitlab-expenses   # 一份真实制度的 21 个历史版本
pnpm bench ask examples/kubernetes-docs "How many nodes can a Kubernetes cluster have at most?"
```

[`examples/README.zh.md`](../../examples/README.zh.md) 列出每个语料、它测量什么、怎么运行，以及哪个测试用它的答案来检查。真实模型上的运行及其花费和记录在 [`apps/bench/runs/`](../../apps/bench/runs/README.zh.md)。

## 付费验证前

付费验证步骤在当前任务范围内时，按以下清单执行。18 元的批准、后来增加到 23 元的上限，以及 MVP 每月的试用预算，都只属于各自任务，不是新基准运行的长期预算。优先用最便宜且适合的提供方；便宜的 GPT 模型或 Claude Haiku 只用来佐证结论。成本、准确率和延迟一起评判，计算治理的模型调用和人的时间，不只看回答省下多少 token。

1. 阅读[已有结果](design/validation.md#现在的状况)，把已保存的回复导入基准专用缓存，明确新运行需要验证什么。
2. 用完全相同的语料、网关配置、参数和对比组执行 `--dry-run`。检查输出：答案键里的事实有目录条目，读者能访问已索引的文档，检索能找到预期证据。命令执行成功不代表这些检查通过。
3. 按未命中缓存的调用预测花费，对照当前任务剩余预算。核对提供方当前价格和折扣时段；旧 DeepSeek 价格测量只是当时的证据。仅缓存定价及其局限见[如何让运行保持便宜](design/validation.md#如何让运行保持便宜)。
4. 使用新的基准数据库和没有旧事件流的运行名称。检查磁盘空间、本地模型是否就绪，以及当前环境的进程生命周期。要计入报告的运行不续用旧数据库，也不假设之前云会话的限制仍然适用。
5. 在中英文[运行记录](../../apps/bench/runs/README.zh.md)中保留提交、完整命令、提示词版本、设置、结果和计量费用。导出回复，记录报告和导出文件的可取回位置。历史共享文件路径本身不能证明备份仍然可用。这些产物中不得出现凭据。

## 运行演示

要看产品，运行演示。它用开发用的模型读取演示租户，所以不花钱，然后在 http://127.0.0.1:5173 提供 Web 应用。点登录，会以陈晨的身份登录，不需要密码；账户菜单可以切换你扮演的人和界面语言。以陈晨的身份问深圳住一晚能报多少：回答给出酒店价目表的 650，并说明差旅制度仍写着 600。以李娜的身份在待办里确认 650，答疑和会议纪要里的 600 就标为已过时。以财务空间负责人周敏的身份放入差旅制度第 7 版：一秒之内，它的一线城市那一行就是 650：

```bash
pnpm demo                                          # 引擎在 4100 端口，Web 应用在 5173
pnpm engine serve examples/corpus --dev-identity   # 只启动引擎的 HTTP API，信任身份请求头
pnpm engine serve --issuer <业务层 URL> --audience http://127.0.0.1:4100   # 空引擎，由业务层开通租户
pnpm snapshot dist/snapshot                        # 把演示脚本录制成静态页面
```

演示脚本（`examples/corpus/script.yaml`）列出这些步骤，每一步都写明由谁来做。`pnpm snapshot` 对着引擎走一遍脚本，写出一个从录制结果作答的静态页面，底部有一条引导，以对应的人打开每一步，所以任何人拿到链接就能跟着演示走，不需要引擎。脚本没问过的问题、没做过的步骤，页面会说明没有录制。这个页面包含演示租户里每个人能读的全部内容，打开它的任何人都能看到：在页面里扮演某个人只是模拟，不是访问控制。所以只录制合成的演示语料，或者拿到链接的每个人都可以读全部内容的语料。

## 真正登录

要用邮箱和密码真正登录，就在引擎前面运行 Logto 和业务后端。Logto 在 compose 文件里，属于单独的 profile。第一次需要在它的控制台（http://localhost:3002）里创建一个“Traditional web”应用，重定向 URI 填 `http://localhost:4200/api/auth/callback`，退出登录后的重定向 URI 填 `http://localhost:4200/`，然后把它的 ID 和密钥写进 `.env`，分别是 `INSPIRATION_LOGTO_APP_ID` 和 `INSPIRATION_LOGTO_APP_SECRET`，再加上 `INSPIRATION_LOGTO_ISSUER=http://localhost:3001/oidc`。其他设置见 `apps/business/src/serve.ts`。

```bash
docker compose -f infra/compose.yaml --profile auth up -d --wait   # 即 make up，再加上 3001 端口的 Logto
pnpm --dir apps/web exec vite build                                 # 构建 Web 应用，输出到 apps/web/dist
pnpm parsing                                                        # 读取上传的 Word、PowerPoint、Excel 和 PDF
pnpm engine serve examples/corpus --issuer http://localhost:4200 --audience http://127.0.0.1:4100
pnpm business serve --web apps/web/dist --sample examples/corpus    # 网站在 http://localhost:4200
```

这里的演示语料就是示例企业：任何登录的人都可以打开它，读到全企业可读的内容，但谁也不能修改它。两条命令都去掉语料，就是一个没有文档的引擎。无论哪种方式，引擎都把一切放在内存里：企业和成员来自业务后端，空间在 Web 应用里创建。重启引擎之后，也要重启业务后端，它启动时会把所有企业和成员，以及示例企业的每位访客，重新发给引擎；重启前创建的空间就没有了。

关口检查不用 Logto 也能跑这两层：`apps/bench/test/site.ts` 在一个进程里启动业务后端和它后面的引擎，用替身身份提供方登录，先在内存里跑，服务栈启动时再在 Postgres 和 SpiceDB 上跑。单独跑一个：`pnpm vitest run apps/bench/test/company-isolation.test.ts`；`make check` 会跑全部。

## 试用模型网关

不需要模型服务器也可以试用模型网关，用假的提供方运行它：

```bash
make gateway
curl -s localhost:8100/healthz
```

## 构建网站

`pnpm site` 把产品网站（`apps/site`）写到 `apps/site/dist`，每种语言一个静态页面；`pnpm site --serve` 提供网站，并在每次请求时重新构建。`Site` 工作流从 `main` 把它发布到 GitHub Pages。

README 和网站的数字必须对应同一份[运行证据](design/validation.md#现在的状况)。区分实测和估算；外部研究支持的是机制，不能证明本项目的领先幅度或成本主张（[外部证据](outside-evidence.md)）。公开文案链接研究，不写作者姓名。例子按地区本地化：中文用飞书，英文和日文用 Confluence、Concur、kintone 等熟悉的产品。以可读性为准；开发中提示只在页尾出现一次，不编造联系邮箱。

## 重画架构图

`docs/assets/` 里的架构图由旁边的 `components.html` 和 `deployment.html` 画出，每张图一个文件，文字有英文、中文和日文。用浏览器以 `?lang=en`、`zh` 或 `ja` 打开（深色版再加 `&theme=dark`），把 `#fig` 元素按两倍尺寸截图，存为 `<图名>.<语言>.png`（深色版为 `<图名>.<语言>.dark.png`）。某个组件构建完成后，在那里去掉它的 `planned` 标记再重画。

## 东西都在哪里

[README 的仓库结构](../../README.zh.md#仓库结构)列出每个顶层文件夹，[架构](architecture.md)解释各层以及组件之间如何通信。业务组件放在 `business/`，与 `engine/` 和 `libs/` 并列（见[一个仓库，每层一个目录](architecture.md#一个仓库每层一个目录)），并列在 `components.yaml` 的 `business` 部分。
