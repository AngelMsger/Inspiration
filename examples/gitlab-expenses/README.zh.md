# GitLab 费用制度回放

一份真实的制度文档，按它六年来的编辑历史逐版回放，用来衡量知识在变化时抽取和治理的表现。文档是 GitLab 公开手册中的差旅与费用制度，取 2020 年 11 月到 2026 年 9 月之间的 21 个版本。回放把每个版本依次覆盖写入，引擎时钟设为该版本发布当天，执行 ingest，然后询问 governance 关于 14 个事实（酒店上限、每日餐费、收据门槛、报销期限等）会告诉读者什么。英文版见 [README.md](README.md)；两者不一致时以英文版为准。

```bash
pnpm engine replay examples/gitlab-expenses          # 内存中运行，约 6 秒
pnpm engine replay examples/gitlab-expenses --stack  # Postgres 和 Valkey
```

`apps/engine/test/history.test.ts` 在内存和 Postgres 上运行它，并要求结果与 `timeline.yaml` 一致。

## 文件

| 文件 | 内容 |
| --- | --- |
| `history/` | 21 个版本，与 GitLab 发布时逐字节一致，命名为 `<日期>-<commit>.md` |
| `history.yaml` | 按顺序排列的步骤：日期、版本、commit、该 commit 下页面的链接、commit 标题 |
| `timeline.yaml` | 每个事实从哪天起应当告诉读者什么，由人工阅读各版本得出；以及每个事实上引擎目前给出不同结果的地方和原因 |
| `vocabulary.yaml` | 14 个事实，表示为 9 个带限定词的谓词，措辞沿用制度原文 |
| `corpus.yaml`、`handbook/` | 一个受治理的文件夹来源；回放把各版本写到 `handbook/finance/expenses.md` |

## 来源与许可

各版本来自 GitLab 手册：2023 年 10 月之前是 `gitlab-com/www-gitlab-com` 中的
[`sites/handbook/source/handbook/finance/expenses/index.html.md`](https://gitlab.com/gitlab-com/www-gitlab-com/-/commits/master/sites/handbook/source/handbook/finance/expenses/index.html.md)，之后是 `gitlab-com/content-sites/handbook` 中的
[`content/handbook/finance/expenses.md`](https://gitlab.com/gitlab-com/content-sites/handbook/-/commits/main/content/handbook/finance/expenses.md)。它们 © GitLab Inc. 及贡献者，采用 [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) 许可，原样复制；`history.yaml` 为每个版本链接到它的 commit。本目录其余文件由我们编写。

在两个仓库中该页面最近的 500 个 commit 里（旧仓库 200 个，最早到 2020 年 11 月；新仓库 300 个，最晚到 2026 年 9 月），保留的是 14 个事实中有事实变化、出现或消失的版本，以及不改变任何事实的编辑（仓库迁移、改名、薪资截止日期），这些编辑不应改变任何知识。只重复已保留变化的 commit 被略去，以缩短运行时间。

## 制度经历了什么

| 日期 | 所跟踪事实的变化 |
| --- | --- |
| 2020-11-17 | 保留的第一个版本。"Itemized receipts are required for all expenses"（门槛为 0）、"submitted within 30 days"、一张硬件表：外接显示器 $380，便携显示器 $200 |
| 2021-05-10 | 显示器 $400 |
| 2021-06-23 | 显示器 $500，超宽屏 $1,000 |
| 2021-12-03 | 页面重组；硬件表从页面上移除，制度摘要缩进了四个空格 |
| 2021-12-13 | 年终节日预算；与所跟踪事实无关 |
| 2022-01-20 | "Itemized receipts are required for all business related expenses that are greater than $75" |
| 2022-01-27 | "submitted within 90 days"；电话服务 "$200 monthly threshold" |
| 2022-05-31 | 页面重写并缩短；"Cell phone service is reimbursable up to $200" |
| 2023-02-08 | 重新要求所有费用都提供收据；电话 $50；每月上限 "$5K"；居家办公补贴新员工 $1,500、每年 $500，写在表格单元格中；不再写报销期限 |
| 2023-05-17 | "Expense claims over 90 days ... will not be reimbursed"；电话上限移入 HTML 表格 |
| 2023-08-29 | 全球差旅与费用制度：酒店每晚 $300，餐费每天 $100，差旅中上网每天 $50，美国员工超过 $50 才需收据，每月上限 "$10K"，E-Group "$20K"，补贴写成句子；不再写电话上限 |
| 2023-10-05 | 突出显示邮箱地址；与所跟踪事实无关 |
| 2023-10-16 | 页面迁到新的手册仓库；与所跟踪事实无关 |
| 2024-01-22、2024-02-06、2024-02-08 | 措辞修改；与所跟踪事实无关 |
| 2026-02-17 | 薪资截止日期；与所跟踪事实无关 |
| 2026-03-18 | 页面被替换为两行通知："This page has moved"，指向内部手册 |
| 2026-05-14 | 页面恢复，所跟踪事实不变 |
| 2026-06-19 | 餐费每天 $120 |
| 2026-09-13 | HelpLab 改名为 Compass；与所跟踪事实无关 |

当某个版本不再写某个值、也没有给出新值时（硬件表、电话上限、迁移通知），`timeline.yaml` 保留这个值：知识绝不会悄无声息地消失（[来源变更](../../docs/zh/design/source-changes.md)，规则 1），而本次回放中没有人将它退役。

## 运行结果

使用替身模型时，**294 个事实版本中有 165 个**（14 个事实 × 21 个版本）给出了应当告诉读者的值。这可以分成截然不同的两半：

- 制度尚未写出任何值的 82 个事实版本全部正确：没有凭空编造，不过有一条陈述落进了一个单独的槽位（见下文）。
- 制度写出了值的 212 个事实版本中，83 个正确。其中 2 个给出了错误的值（`receipt_threshold` 从缩进摘要的上一行取了 "$5,000 USD"），其余 127 个什么都没给出。

回放做对的正是引擎负责的部分：新版本在发布当天取代旧值（2022-01-27 报销期限从 30 天变为 90 天，2023-02-08 电话从 200 变为 50，2026-06-19 餐费从 100 变为 120），无关的编辑不改变任何内容，2026-05-14 页面恢复后所有值都回来了。

错误的 129 个来自两个地方：

| 原因 | 事实版本数 | 具体情况 |
| --- | --- | --- |
| 新版本不再写某个值时，引擎丢掉了它 | 20 | 迁移通知撤回了上一版本的所有陈述，于是两个月里每个事实都悄无声息地消失了（7 个事实版本）。电话上限和报销期限在某个版本不再写出、或只写在替身模型读不到的地方时，也同样消失（13 个）。 |
| 替身模型没有读出这个值 | 109 | 以千为单位的金额（"$10K"）、带货币符号的表格单元格（"Average Price in USD" 下的 "$380"）、HTML 表格、没有数字的规则（"required for all expenses" 即门槛为 0），以及目录之外的措辞（"**Phone** \| $200"，用 "new Team Members" 指新员工）。 |

所以引擎自身的差距是 20 个事实版本。修复它（保留新版本不再写出的内容，加上标记，并把这次变更作为一个整体审核：来源变更设计的规则 1 和规则 4）后，结果会达到 294 个中的 185 个。其余部分衡量的是替身模型：它只读取目录词语旁边的数字，而真实的制度文本往往不是这样写的。配置好真实模型后，应当再用同一份语料运行一次，届时这 109 个衡量的就是抽取质量。

真实文本还带来两个发现：

- **一条陈述落进了单独的槽位。** "providing new Team Members with a $1,500 USD ... stipend" 提到了补贴，但没有限定词的词语，于是它落进一个不带限定词的 `home_office_stipend` 槽位，与两个带限定词的槽位并列。检查把它报告为 `timeline.yaml` 没有列出的槽位。
- **一个过长的主题名会让整个回答的名称全部作废。** page compiler 的替身模型原先把英文名称截到 60 个字符，但 `name_topics` 的回答只允许 40 个，所以一个较长的真实标题使网关拒绝了整个回答，其中每个主题都退回到它的第一个标题（"no valid names for topics"）。英文语言包现在截到 40。真实模型也可能犯同样的错误，所以因为一个名称就拒绝整个回答的做法，值得在 page compiler 中重新考虑。

`timeline.yaml` 完整给出了每个事实的原因。某个改动弥补了其中一个差距时，历史测试会失败，直到删除那里对应的条目，所以每一次改进都会体现为该文件的一处 diff。
