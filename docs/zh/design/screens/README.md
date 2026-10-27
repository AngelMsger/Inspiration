# 界面稿

状态：产品负责人设计画布 “Inspiration UI”（https://claude.ai/artifact/GYXc5GBY3bPq1XGuMUGwAk）的快照，
取于 2026-10-26，2026-10-27 更新（画布第 73 版）。界面稿在画布上绘制和修改；这个文件夹保存一份副本，方便评审者和团队成员对照文档阅读。两者不一致时，
以画布为准。本 README 的英文原文在 [docs/design/screens/README.md](../../../design/screens/README.md)；
两者不一致时，以英文版为准。

界面背后的原则见 [UI 原则](../ui-principles.md)，陈述如何分组和审阅见 [规模化的陈述](../statements-at-scale.md)。

## 如何打开

每个界面是一个静态 HTML 文件，用浏览器打开即可。字体从 Google Fonts 加载。文件里引用了画布的
`support.js`，没有复制过来；缺少它界面照样显示，只是没有画布外框。所有链接都是占位的 `#`。
人物、公司（恒远机械）和数字都是虚构的。

文件与画布逐字节相同。Biome 不检查这个文件夹，语言测试也允许其中出现中文和日文，这样副本不会与画布产生偏差。

界面稿只放在 `docs/design/screens/` 下，这里不再复制一份。

## 第二版（V2 行，中文）

2026-10-27 按 [UI 设计哲学](../ui-philosophy.md) 重画：每个界面同一个顶栏和同一个左侧栏，同一个故事（恒远机械的财务部）和同一组人物，
助手在每个地方都以同样安静的方式出现。第二版和下面各行不一致时，以第二版为准。其余界面接下来按同样的方式重画。

| 文件 | 界面 |
| --- | --- |
| [V2-map](../../../design/screens/V2-map.dc.html) | 每个界面都遵循的结构：区域、左侧栏的四个区域、助手出现的四种方式、人物 |
| [V2-home](../../../design/screens/V2-home.dc.html) | 成员的首页：提问、常看内容的变化、最近看过 |
| [V2-inbox](../../../design/screens/V2-inbox.dc.html) | 待办：先给概述，需要你的写明原因，其余用一次“替我决定”处理 |
| [V2-decision](../../../design/screens/V2-decision.dc.html) | 一个决定：建议已经预先选好，附理由 |
| [V2-space](../../../design/screens/V2-space.dc.html) | 维护空间：概览，以及按领域排列、按真实规模画的主题与维护人 |
| [V2-review](../../../design/screens/V2-review.dc.html) | 维护空间：发布申请（紧凑模式） |
| [V2-admin](../../../design/screens/V2-admin.dc.html) | 管理后台按关注点分组：成员，先搜索 |
| [V2-account](../../../design/screens/V2-account.dc.html) | 账户：替我决定、长期委托及其边界 |

## 选定的系统（D 行，英文）

墨与纸，加上方向 B 的命令面板和方向 C 的提问栏。

| 文件 | 界面 |
| --- | --- |
| [D-system](../../../design/screens/D-system.dc.html) | 设计令牌与组件 |
| [D-home](../../../design/screens/D-home.dc.html) | 带提问栏的首页 |
| [D-steward](../../../design/screens/D-steward.dc.html) | 紧凑模式与命令面板 |
| [D-signin](../../../design/screens/D-signin.dc.html) | 登录并选择企业 |
| [D-inbox](../../../design/screens/D-inbox.dc.html) | 待办 |
| [D-search](../../../design/screens/D-search.dc.html) | 搜索与提问结果 |
| [D-connections](../../../design/screens/D-connections.dc.html) | 管理：来源连接 |
| [D-apps](../../../design/screens/D-apps.dc.html) | 使用知识的应用与授权页 |
| [D-space](../../../design/screens/D-space.dc.html) | 空间设置：角色、按领域排列的主题与维护人、本周的主题变更 |
| [D-review](../../../design/screens/D-review.dc.html) | 发布申请审阅（紧凑模式） |
| [D-conflicts](../../../design/screens/D-conflicts.dc.html) | 冲突队列（紧凑模式），由空间负责人裁决 |

## 演示故事（E 行，中文）

文档先出现，保留原来的形式，知识再一步步叠加上来；各级负责人在追溯里看结构。画布用中文讲演示故事，但中文只是产品支持的三种语言之一，
不是默认语言（见 [UI 原则](../ui-principles.md) 的“国际化”一节）。

| 文件 | 界面 |
| --- | --- |
| [E-doc](../../../design/screens/E-doc.dc.html) | 导入之后：先看原文 |
| [E-doc-layers](../../../design/screens/E-doc-layers.dc.html) | 从原文到知识：批注与“这段讲了什么” |
| [E-doc-knowledge](../../../design/screens/E-doc-knowledge.dc.html) | 文档的知识视图：每一节整理出了什么、用在哪里、和其他文档的关系 |
| [E-model](../../../design/screens/E-model.dc.html) | 知识模型（说明图，不是产品界面） |
| [E-topic](../../../design/screens/E-topic.dc.html) | 主题页（读者） |
| [E-page](../../../design/screens/E-page.dc.html) | 知识页（读者，点开引用） |
| [E-procedure](../../../design/screens/E-procedure.dc.html) | 流程（读者） |
| [E-trace](../../../design/screens/E-trace.dc.html) | 追溯：按大纲分组（主题负责人，规模化的陈述中的方案 C） |
| [E-sources](../../../design/screens/E-sources.dc.html) | 文档与治理级别（方案 C） |
| [E-inbox](../../../design/screens/E-inbox.dc.html) | 待办：来源更新、原文已删除、支持计数 |
| [E-mobile](../../../design/screens/E-mobile.dc.html) | 手机 |
| [E-dark](../../../design/screens/E-dark.dc.html) | 深色主题：保留其令牌，但不在首个版本中 |
| [E-solo](../../../design/screens/E-solo.dc.html) | 一个人用：没有企业 |
| [E-publish](../../../design/screens/E-publish.dc.html) | 发布到空间（可见范围由空间决定） |
| [E-admin](../../../design/screens/E-admin.dc.html) | 管理：可见范围、发布队列（紧凑） |
| [E-trace-topic](../../../design/screens/E-trace-topic.dc.html) | 追溯：主题总览（上千条陈述） |
| [E-i18n](../../../design/screens/E-i18n.dc.html) | 三语对照：界面跟随个人，内容保持空间语言 |
| [E-changes](../../../design/screens/E-changes.dc.html) | 批量变更审阅（紧凑） |

## 没有复制的内容

- **A、B、C 三行。** 这是 2026-10-23 比较过的三个方向：A 墨与纸，B 石墨工作台，C 荧光笔工作室。D 以 A 为基础，
  保留了 B 的命令面板、检查器和紧凑模式，以及 C 的提问栏。这三行留在画布上，仅作参考。
- **日文界面。** 关键界面的日文版尚未绘制；目前由 E-i18n 展示三语对照。

## 快照中的用语

第一版的中文界面把各级负责人称为“负责人”（空间负责人、主题负责人等）。2026-10-26 提议改为“维护人”，等待产品负责人确认；在此之前第二版用“维护人”。
见 [UI 原则](../ui-principles.md) 的词汇表和[概览](../../overview.md)第 4 节。界面保持绘制时的样子，随画布一起更新。
