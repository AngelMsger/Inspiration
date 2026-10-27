# 对照语料

一个小租户，每个样例都只有一个正确答案，用来逐个样例衡量流水线，而不是只看一个 truth 总数。它有 14 份文档，分属三个来源：制度库和团队手册，都是受治理文档，权威度 0.9；团队 wiki 是参考文档，权威度 0.5。除一份中文译本外，文档都是英文。`expected.yaml` 是答案，`vocabulary.yaml` 是抽取放入槽位的事实目录。英文版见 [README.md](README.md)；两者不一致时以英文版为准。

用 `pnpm bench ingest examples/control` 运行。在常规报告之后，对照检查把每个样例标为 **right**（正确）、**known gap**（已知差距：与 `expected.yaml` 记录的方式一致地不同）或 **differs**（不同）。槽位中的每个值显示四项：

- 哪些文档把这个值放进了这个槽位，所以放错槽位的陈述会显示出来；
- 它的独立来源，按 governance 的算法：同一文档的陈述、一份文档和它的译本、以及共享陈述所依据段落的文档，都只算一次；
- governance 实际计的数：陈述数、其中已生效的受治理陈述数、文档数；
- 它是否被提议；如果没有，它的结果是什么。

`apps/bench/test/control.test.ts` 在内存和 Postgres 上运行它。使用替身模型时，抽取结果衡量的是流水线和替身模型，不是真实模型。配置好真实模型后，应当再用同一份语料运行一次。

## 样例

| 样例 | 问题 | 预期 | 现状 |
| --- | --- | --- | --- |
| copied-faq | 一份过时 FAQ（180）的三份副本，能否压过差旅制度（200）？ | 200 成立；180 是一条备注；三份副本是一个来源 | 正确 |
| pasted-paragraph | 三本 2025 年的手册粘贴了同一段（50），2026 年的差旅制度写 60。50 会赢吗？ | 60 成立；50 已被取代；一个来源 | 正确 |
| two-named-deadlines | "Refunds are paid within 14 days of approval; customers may object to a decision within 30 days." 两个事实都在目录中。 | 14 和 30 各在自己的槽位 | 正确 |
| unnamed-deadline | "Returns are accepted within 30 days of delivery, and damaged items must be reported within 7 days." 目录中只有退货期限。 | 30 在退货期限槽位，7 不进任何槽位 | 已知差距：替身模型把 7 放进退货期限，claim ID 选中了它 |
| qualified-deadlines | "Travel expenses must be claimed within 30 days of the trip, other expenses within 60 days." | 差旅 30，其他费用 60 | 正确 |
| elliptical-deadline | "Standard orders ship within 3 days; express orders within 1 day." | 3 和 1，各带自己的限定词 | 已知差距：加急订单的期限没有读出 |
| reposted-notice | 一份通知（40）被复制进两个手册目录；两本手册用各自的话写 45。 | 45 成立，两个来源对一个 | 正确 |
| translated-policy | 休假制度（20 天）、它的中文译本和一份入职说明 | 20，两个来源：译本是副本 | 正确 |

`expected.yaml` 中每个已知差距的条目都说明了引擎目前为什么得出不同结果。

## 运行结果

8 个样例：6 个正确，2 个已知差距。

- **陈述：** 23 条中有 22 条以正确的值落在正确的槽位。加急期限没有读出，报告损坏的 7 天落进了退货期限。
- **来源：** 14 个值中有 13 个的独立来源符合预期；退货期限中的 7 天本应没有来源。
- **提议：** 11 个槽位中有 9 个的提议值符合预期，10 个的其他值结果符合预期。

两个差距都来自抽取替身模型，不是引擎：它逐段单独阅读，并把没有目录词的分句归到该段的事实（unnamed-deadline、elliptical-deadline）。真实模型运行时，要重点看这两个样例。

同等权威的受治理值之间，governance 提议独立来源更多的值；再相同，则提议来自较新文档的值；再相同，则提议陈述更多的值。有三个样例取决于这一点：

- **reposted-notice：** 通知和它的两份完全相同的副本全文相同，所以是一个来源，45 以两个来源成立。按陈述计数时，40 以三比二胜出。
- **pasted-paragraph：** 三本手册共享粘贴的那一段，所以 50 只有一个来源，与 60 相同；差旅制度 2026 年生效，手册 2025 年生效，所以 60 成立，50 成为一个待人决定的取代案例。按陈述计数时，50 以三比一胜出。
- **translated-policy：** 文件夹把 `leave-policy.zh.md` 读作 `leave-policy.md` 的中文译本，所以两者是一个来源。知识不依赖于语言。

一段文字至少有 40 个字母和数字（比较时忽略大小写、空白和标点）才算被复制；两份文档碰巧用相同措辞写了一条简短规则时，仍然是两个来源。参考文档永远压不过受治理文档，所以无论 FAQ 被复制多少次，copied-faq 都正确。

## 文档

| 文档 | 级别 | 生效日 | 内容 |
| --- | --- | --- | --- |
| policies/travel-policy.md | 受治理 | 2026-01-01 | 住宿 200，餐补 60，报销期限 30 天（差旅）和 60 天（其他） |
| policies/customer-policy.md | 受治理 | 2026-01-01 | 退款 14，异议 30，退货 30（损坏 7，不在目录中），发货 3 和 1 |
| policies/leave-policy.md | 受治理 | 2026-01-01 | 年假 20 天 |
| policies/leave-policy.zh.md | 受治理 | 2026-01-01 | 同上，中文 |
| policies/taxi-notice.md | 受治理 | 2025-01-01 | 打车每天 40 |
| handbooks/sales/taxi-notice.md、handbooks/support/taxi-notice.md | 受治理 | 2025-01-01 | 通知的完全相同的副本 |
| handbooks/sales.md、handbooks/engineering.md | 受治理 | 2025-01-01 | 打车每天 45，各用自己的话；餐补 50（粘贴） |
| handbooks/support.md | 受治理 | 2025-01-01 | 餐补 50（粘贴） |
| wiki/travel-faq.md 及其在 wiki/sales、wiki/support 中的副本 | 参考 | | 住宿 180 |
| wiki/onboarding.md | 参考 | | 年假 20 天 |
