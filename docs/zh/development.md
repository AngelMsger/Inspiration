# 开发

如何在本仓库里构建、测试和运行 Inspiration：运行环境、检查、测量工具和演示。产品是什么、往哪里走，见 [README](../../README.zh.md) 和[总览](overview.md)；修改任何东西的规则见 [AGENTS.md](../../AGENTS.md)。本文是 [docs/development.md](../development.md) 的中文副本；两者不一致时以英文版为准。

## 安装和检查

需要 Node 22.18 或更高版本（Node 24 也可以）、pnpm，以及带 Compose 的 Docker。`package.json` 在 `packageManager` 里固定了 pnpm 10.28.0，corepack（`corepack enable`）和 10 及以上的任何 pnpm 都会照它切换；它还为 Volta 固定了 Node 22 和 pnpm 10.28.0。这个固定是必要的：Volta 通过 `bin/pnpm.cjs` 启动 pnpm，而 pnpm 11 及以后不再带这个文件，所以 Volta 里的 pnpm 11 或更高版本在本仓库之外会报 `Cannot find module …/bin/pnpm.cjs`，在本仓库里则能正常运行。

```bash
make install       # pnpm 依赖
make up            # ParadeDB（Postgres 16 + pgvector + pg_search）、Valkey、SpiceDB
make migrate       # 所有已安装组件的 SQL 迁移
make authz-schema  # SpiceDB schema
make check         # Biome、tsc、契约是否最新、所有测试（要求运行环境已启动）
```

不用 make 时，对应的步骤是 `pnpm install`、`docker compose -f infra/compose.yaml up -d --wait`、`pnpm exec inspiration-migrate`、`pnpm exec inspiration-authz-schema` 和 `INSPIRATION_REQUIRE_STACK=1 pnpm test`。

需要运行环境的测试在环境未启动时会跳过，除非设置了 `INSPIRATION_REQUIRE_STACK=1`（CI 中就是这样）。每个测试都有自己的数据库（从已迁移的模板复制）和自己的 Valkey 键前缀。`make test-unit` 只运行什么都不需要的测试。

除解析 worker 外全部是 Node 22 上的 TypeScript；解析 worker 用 Python，因为最好的文档解析器是 Python 的。[`components.yaml`](../../components.yaml) 列出每个组件及其状态（已构建、进行中或已计划），每个包的 `src/index.ts` 说明它做什么。

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
pnpm engine serve examples/corpus --issuer http://localhost:4200 --audience http://127.0.0.1:4100
pnpm business serve --web apps/web/dist --sample examples/corpus    # 网站在 http://localhost:4200
```

这里的演示语料就是示例企业：任何登录的人都可以打开它，读到全企业可读的内容，但谁也不能修改它。两条命令都去掉语料，就是一个没有文档的引擎。无论哪种方式，引擎都把一切放在内存里：企业和成员来自业务后端，空间在 Web 应用里创建。重启引擎之后，也要重启业务后端，它启动时会把所有企业和成员，以及示例企业的每位访客，重新发给引擎；重启前创建的空间就没有了。

## 试用模型网关

不需要模型服务器也可以试用模型网关，用假的提供方运行它：

```bash
make gateway
curl -s localhost:8100/healthz
```

## 构建网站

`pnpm site` 把产品网站（`apps/site`）写到 `apps/site/dist`，每种语言一个静态页面；`pnpm site --serve` 提供网站，并在每次请求时重新构建。`Site` 工作流从 `main` 把它发布到 GitHub Pages。

## 重画架构图

`docs/assets/` 里的架构图由旁边的 `components.html` 和 `deployment.html` 画出，每张图一个文件，文字有英文、中文和日文。用浏览器以 `?lang=en`、`zh` 或 `ja` 打开，把 `#fig` 元素按两倍尺寸截图，存为 `<图名>.<语言>.png`。某个组件构建完成后，在那里去掉它的 `planned` 标记再重画。

## 东西都在哪里

[README 的仓库结构](../../README.zh.md#仓库结构)列出每个顶层文件夹，[架构](architecture.md)解释各层以及组件之间如何通信。业务组件放在 `business/`，与 `engine/` 和 `libs/` 并列（见[一个仓库，每层一个目录](architecture.md#一个仓库每层一个目录)），并列在 `components.yaml` 的 `business` 部分。
