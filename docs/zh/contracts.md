# 契约

每个跨越组件边界的类型只定义一次，用 JSON Schema（draft 2020-12）写成 YAML，放在 `libs/contracts/schema/`
下。TypeScript 类型、运行时校验器和事件目录都由它生成。线上传输和数据库中的数据是 `snake_case`；TypeScript API
是 `camelCase`。本文是英文版 [contracts.md](../contracts.md) 的中文副本，两者不一致时以英文版为准。

| 文件 | 内容 |
| --- | --- |
| `common.yaml` | ID、时刻、区间、哈希、敏感度标签、Blob 引用、生产者信息、组件名 |
| `source.yaml` | 来源、连接器能力、版本、规范化文档、片段、分块、审批流 |
| `knowledge.yaml` | 陈述和证据、实体、关系、SOP、知识模型、研究、保鲜、血缘、冲突、事实槽每个取值的状态 |
| `page.yaml` | PageSpec 及其 14 种块类型、数据引用、图表、示意图、视图及其消息协议、快照 |
| `collab.yaml` | 评论、锚点、提议、覆盖、待办、发布 |
| `authz.yaml` | 主体和主体令牌、权限、判定、索引过滤器、ACL 快照、空间、空间角色和授权、审计事件 |
| `tenancy.yaml` | 业务层开通的租户和成员，以及引擎保存的目录副本 |
| `api.yaml` | 引擎的 HTTP API：空间及其管理、文档、主题、待办、概览、错误 |
| `gateway.yaml` | 补全、向量、重排和 OCR 的请求与结果、用量、预算、错误 |
| `retrieval.yaml` | 检索和回答的请求与结果、引用、关于有争议和已被取代的值的说明、反馈 |
| `events.yaml` | 事件信封和每种事件类型的载荷（`x-events`） |
| `agents.yaml` | 工具规格、Agent 规格、运行上下文、步骤和结果 |
| `business/accounts.yaml` | 业务后端面向浏览器的 API 中关于已登录账户的部分：会话、语言和退出登录 |
| `business/companies.yaml` | 业务后端面向浏览器的 API 中关于企业的部分：成员及其产品角色、邀请链接 |

`schema/business/` 里的文件是业务层自己的类型。它们并入同一个打包文件，所以 `parseAs` 能像校验其他类型一样校验它们，
它们也可以引用引擎的类型（`../common.yaml#/$defs/TenantId`）；但它们的 TypeScript 类型生成到 `src/business.ts`，
各包以 `@inspiration/contracts/business` 引入。引擎的契约文件从不引用它们，`engine/` 和 `libs/` 里也没有任何代码引入这个入口
（`test/manifest.test.ts`）。

组件之间的接口（`KnowledgeStore`、`AuthZ`、`ModelGateway`、`Retriever`、`AgentRuntime`、`SlotVerdicts`、`StalenessReader`、插件接口）是在生成的类型
之上手写的 TypeScript，位于 `libs/contracts/src/interfaces.ts`。

## 修改契约

```bash
$EDITOR libs/contracts/schema/page.yaml
pnpm contracts           # 打包，然后生成 src/generated.ts、src/business.ts 和 src/events.ts
pnpm contracts:check     # CI 运行的检查：任何生成文件过期都会失败
pnpm vitest run libs/contracts   # 示例按 schema 校验
```

永远不要手工编辑 `dist/inspiration.schema.json`、`src/generated.ts`、`src/business.ts` 或 `src/events.ts`。

规则：

- 类型名在所有文件中唯一；打包器把它们展平到一个命名空间中（`libs/contracts/dist/inspiration.schema.json`，
  其他语言读取的就是这个文件）。
- 每个枚举，以及每个在多处使用的对象，都有自己的命名定义，这样生成的代码名字可读。
- 跨线传输的联合类型带有标签（块和视图消息用 `type`，数据引用用 `kind`）；打包器会为代码生成器加上
  `discriminator`。
- 为每个新的跨组件类型在 `libs/contracts/examples/<Type>.<name>.json` 中放一个示例；测试会校验它。
- 用 `parseAs(typeName, value)` 或 `contractErrors(typeName, value)` 校验来自进程外部的数据。`newEvent` 会校验它
  构建的每个事件。
- 文本中的偏移量（`quote_start`、`char_start`）是 UTF-16 码元，也就是 JavaScript 字符串使用的下标。parsing 工作
  进程负责转换。

## 兼容性

- **增量**（新的可选字段、新类型、消费者可以忽略的新枚举值）：任何分支都可以做。在 PR 中说明。
- **破坏性**（删除或重命名字段、把字段改为必填、收窄类型、改变取值的含义）：先达成一致。对于事件，增加一个新的
  载荷版本：在 `x-events` 中提升该事件的 `version`。消费者会把版本比自己所知更新的事件放入死信，所以不会有任何
  数据被悄悄误读。

## ID

ID 是一个简短的种类前缀加一个 ULID（`clm_01JC...`），所以它们按创建时间排序，并说明自己指向什么。
`newId("claim")` 生成一个；`stableId(kind, ...parts)` 为必须在重建之间保持 ID 的单元生成确定性的 ID（例如从分类
键得到页面 ID）。`kindOf(id)` 读回种类。内容哈希是 `sha256:<hex>`；`combineHashes` 用一个产物的输入以及其生产者的
名称、版本、模型和提示词版本构建它的输入哈希。

来源文档没有自己的 Inspiration ID。`ResourceRef` 用 `"<source id>:<external id>"` 命名它们。access-control 不为它们
建对象：谁能读来源所在的空间，谁就能读这份文档。

组件名（`ComponentName`）是 kebab case：`extraction`、`page-compiler`。组件名就是它的事件生产者名、它的消费者组，
以及它的模型任务名的第一部分（`extraction.extract_claims`）。

## 事件

`newEvent(type, payload, { tenantId, producer })` 用该类型的当前版本构建一个经过校验的 `EventEnvelope`；
`payloadOf(event, type)` 按类型读回载荷。一个事件引出另一个事件时传入 `causation`，这样关联 ID 会贯穿整条链。

| 事件 | 发布方 | 消费方 |
| --- | --- | --- |
| `source.changed` | connectors、source-sync、research | source-sync |
| `document.fetched` | source-sync | normalization |
| `acl.changed` | source-sync | collaboration |
| `blocks.changed` | normalization | extraction、freshness、retrieval |
| `claims.updated` | extraction、governance、collaboration | freshness、governance、page-compiler、retrieval |
| `artifact.dirty` | freshness | extraction、page-compiler、retrieval |
| `review.due` | freshness | collaboration、research |
| `todo.requested` | extraction、governance、views | collaboration |
| `todo.created` | collaboration | collaboration |
| `todo.resolved` | collaboration | governance |
| `page.rendered` | page-compiler | collaboration、retrieval、views |
| `comment.created` | collaboration | extraction、collaboration |
| `unit.published` | collaboration | retrieval、agent-api |

`test/manifest.test.ts` 让 `components.yaml` 与事件目录保持一致；两者任一变化时都要更新本表（英文版中的表由测试
检查）。本表只列出引擎组件；业务层，连同它的 Web 应用，也消费引擎事件（例如为它的待办箱和阅读界面消费待办和
已渲染的页面）。
