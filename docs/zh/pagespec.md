# PageSpec 与视图

页面是数据，不是 HTML。page compiler 构建一个 `PageSpec`：一个有序的、有类型的块列表，其中的句子引用陈述。
知识存储把每个渲染出的版本保存为不可变的 `PageSnapshot`。界面、导出、Agent 和差异比较都读取同一个结构。
Inspiration 就是这样在接近 Claude Artifacts 展示能力的同时，让每条陈述都可追溯，并保持每位读者的权限不受破坏。
本文是英文版 [pagespec.md](../pagespec.md) 的中文副本，两者不一致时以英文版为准。

## 对标 Claude Artifacts

| Artifact 能力 | Inspiration | 说明 |
| --- | --- | --- |
| Markdown 文档 | `heading`、`paragraph`、`list`、`quote`、`callout`、`table`、`code`、`math`、`divider` | 文本是一个 `Sentence` 列表，每个句子带 `claim_ids`。看不到某条陈述的读者也看不到它的句子。 |
| 图片和 SVG | `image` | 带替代文本和说明的 Blob 引用。没有内联脚本。 |
| Mermaid 和其他示意图 | `diagram` | `mermaid`、`echarts` 或 `graph` 格式的 `DiagramSpec`。`DiagramCompiler` 插件根据结构（一个 SOP、一个实体的邻域、一条时间线）构建它；模型可以选择展示什么，但从不自己画边。 |
| 图表 | `chart` | 带 `DataRef` 的 `ChartSpec`。数据可以内联，可以来自陈述（固定的或按查询，在重建时、按计划或在查看时刷新），也可以来自已接入系统的注册查询。每行都保留它的陈述 ID，所以读者无权看到的行会在渲染前被去掉。 |
| 交互式 HTML 或 React | `view` | 一个在沙箱中运行的 `ViewSpec`（见下文）。每个视图块都有一个静态的 `fallback` 块，在视图获批之前、对没有 JavaScript 的读者以及在导出中显示。 |
| 复用内容 | `embed` | 按引用嵌入另一个单元（一个 SOP、一张实体卡片、一个知识模型），使它保持最新。 |
| 在 artifact 中调用 Claude | `insp.ask` | 视图可以提出问题。宿主用 retrieval 的有依据回答、以读者的权限回答它，并用 `insp.answer` 回复。 |
| 下载文件 | `insp.download` | 视图把它生成的文件（CSV、图片）交给宿主；宿主提供给读者。 |
| 持久存储 | 不提供 | 视图是无状态的。评论通过 `insp.comment` 进入 collaboration，所以会像其他评论一样被审核。 |
| 网络访问 | 从不 | 视图只通过宿主获得数据。 |

## 视图

一个视图是一段交互代码的一个已批准版本：

- **模板或代码。** `ViewTemplate` 是随产品提供的可复用包（SOP 步骤导航、决策树、对比矩阵），每次使用时配置。
  视图也可以是生成的或手写的代码。两者都是一个内联 CSS 和 JavaScript 的单一 HTML 文件。
- **代码与数据分离。** `ViewSpec` 保存代码和一个 `data_schema`。页面的 `view` 块保存一个 `DataRef`。在提供服务时，
  宿主通过知识存储解析数据，去掉读者无权看到的行，按 `data_schema` 校验其余部分，并用 `insp.data` 发送。同一份
  已批准的代码服务每一位读者。
- **审批。** 新的视图版本从 `draft` 开始。一次无头渲染检查（`RenderReport`：控制台错误、被拦截的请求、几种宽度下的
  截图）把它变为 `checked`。在该空间有核验权限的人批准它。只有已批准的版本才会提供给读者；在此之前读者看到的是
  fallback。
- **沙箱。** 视图运行在从独立域名提供的 iframe 中，带 `sandbox="allow-scripts"`（不同源）、一个拦截所有网络请求的
  内容安全策略，并且无法访问主站点的 cookie 或存储。
- **消息。** 宿主和视图只使用 `page.yaml` 中的有类型协议通信：宿主到视图是 `insp.init`、`insp.data`、`insp.theme`、
  `insp.answer`；视图到宿主是 `insp.ready`、`insp.resize`、`insp.navigate`、`insp.ask`、`insp.comment`、
  `insp.download`、`insp.error`。视图只能使用其规格声明的能力。

## 版本与差异

每次改变内容的渲染都会写入一个带 `SnapshotCause`（来源变化、被接受的提议、提示词或模型升级、恢复）的新版本。
块键在各版本之间保持稳定，所以 `PageDiff` 能说出哪些块被新增、删除、修改或移动，锚定在某个块上的评论也能在重建后
保留。恢复一个旧版本会写入一个新版本，其中的块被固定为覆盖，这样下一次重建不会撤销它。

`libs/contracts/examples/PageSpec.travel-policy.json` 中的完整示例用到了每一种块类型，并由契约测试校验。
