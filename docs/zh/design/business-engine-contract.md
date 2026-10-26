# 业务层与引擎契约

状态：已采纳的设计，2026-10-24。本文列出引擎向业务层提供的契约，以及这份契约需要的 Schema 改动。它实现的是[业务层：功能设计](business-layer.md)里的协议。`packages/contracts/schema` 里的 JSON Schema 仍是唯一事实来源：这里的改动落地后，评审以 Schema 为准。main 上已经完成的：成员 ID（拉取请求 #7）。本文是 [docs/design/business-engine-contract.md](../../design/business-engine-contract.md) 的中文副本，两者不一致时以英文版为准。

## 规则

1. **调用向下，事件向上。** 业务层调用引擎的命令和查询，引擎发布事件。引擎从不调用业务层。
2. **三种 ID。** 租户 ID `ten_`、用户 ID `usr_`（账号）、成员 ID `mem_`（用户在某一个租户里的身份）。用户、登录身份和会话从不进入引擎；成员 ID 是引擎识别人员的唯一 ID。
   - 成员 ID 只在所属租户内唯一，完整的键是 (tenant_id, member_id)。凡是在租户范围的行之外存放成员 ID 的地方，都同时存放租户 ID（SpiceDB 对象 ID `<ten_…>|<mem_…>`、缓存、审计、导出）。
   - 业务层的 tenancy 组件按一条规则分配成员 ID。第 1 阶段沿用用户 ID 的主体、换成 `mem_` 前缀（`usr_01H…` 变成 `mem_01H…`）。以后可以改为在每个租户里新生成 ID，只对新成员生效；ID 永远不变。
   - 任何代码都不能从一种 ID 推导另一种，也不能解析 ID 的主体；只能通过成员记录找到用户。
   - main 上的现状（拉取请求 #7）：`PrincipalKind` 是 `member`，SpiceDB 里是 `definition member`，凡是存放在租户行之外的主体都按租户编键。成员、群组、部门和服务都是 SpiceDB 对象 `<ten_…>|<id>`，主体令牌和 ACL 令牌使用同样的形式。引擎不假设任何通讯录 ID 跨租户唯一，所以 ID 用哪种规则生成与它无关。`AclPrincipalKind` 保留 `user`，指来源系统里的人（例如飞书 open_id），由通讯录映射到成员。访问控制的通讯录写入显式带租户，空间授权按空间所属租户为成员编键，上级空间必须在同一租户内，租户只能被授予自己的空间。智能体的 `on_behalf_of` 必须是 `mem_`。
3. **按主题划分权威。** 业务层是人、租户和策略取值的权威来源；引擎保存它要执行的内容的副本，每一次权限判断都由引擎自己做。
4. **命令幂等。** 每条命令带 `Idempotency-Key`，通讯录对象带 `version`，命令把 SpiceDB ZedToken 作为 `consistency_token` 返回。
5. **仅业务层使用的 Schema**（用户、邀请、审批）放在契约中引擎包从不引用的单独目录里。两层在同一个仓库里构建，各占一个目录；任何引擎包依赖业务包，组件清单测试都会失败（见 [architecture.md](../architecture.md) 的“一个仓库，每层一个目录”一节）。
6. **两个知识域，自上而下的可见性。**
   - **成员域** = 某个成员的个人空间（`Space.kind = personal`，每个成员在每个租户里一个；在个人租户里就是全部内容）。只有该成员能读。租户管理员、空间负责人或群组的授权都进不去，也没有紧急访问通道。唯一的例外由成员自己发起：提交发布请求后，请求的审批人可以读该请求里的条目，不能读其他任何内容，直到请求被决定或撤回。
   - **租户域** = 其他所有空间。可见性 = 空间角色（`viewer`、`commenter`、`editor`、`steward`、`owner`；沿空间树向下继承），由租户管理员和空间负责人自上而下授予成员、群组和部门，再按敏感级别过滤：只有当单元的标签 ≤ min(成员许可级别, 令牌 `max_sens`) 时才可读。发布者对自己发布的每个单元获得一项授权（`publisher`：按空间规则阅读和编辑），租户管理员可以移除。
   - **合并范围 = 域。** 实体消解、陈述去重、事实槽和冲突检测按域键运行：个人空间是 `member:<space id>`，租户域是 `tenant`（覆盖所有租户空间）。两个键之间从不合并或比较。个人页面可以链接到其所有者能读的租户域条目；租户域知识从不引用成员域条目。主题按空间划分，因为跨空间的主题会把可读和不可读的陈述混在一起。
   - **可见性来自空间和依据，而不是来源 ACL。** 陈述、页面或 SOP 所在的空间可读，它就可见；陈述还需要至少一个读者能读的完整依据。依据是所在空间位于读者可读空间集合中的证据片段（每次请求做一次 LookupResources，并缓存结果），或是一个 `ClaimDerivation`：`merge` 的各个输入互为替代，任意一个可读的输入就构成依据；`aggregate`、`infer` 和 `translate` 则要求每个输入都可读，并按同样方式检查。没有可读依据的陈述会被隐藏，对该读者而言，由它构成的一切也一并隐藏：事实槽的提议值、冲突中的一个变体、页面中的一整个块（从不去掉行文中间的文字，而是重新编译页面）、一个回答。可读集合之外的其他引用和证据片段直接略去，不留标记，不透露它们的存在。带 `spaces` 的智能体令牌会进一步缩小这个集合。
   - **跨越受众需要审批**（在提议的[汇编知识的权限](compiled-knowledge-permissions.md)中改为按陈述放行）。 输入分布在受众不同的多个空间里的派生结果，只对能读全部输入的读者可见（不能读财务空间的销售读者，看不到用财务成本算出的毛利）。要让结果对它所在空间的受众可见，派生单元需要经过一次发布到该空间的发布申请，由该受众无法阅读的每个输入空间的负责人审批；记录下来的审批成为该单元的依据。审批针对这条派生，所以在输入不变时，重新计算出的值仍然保持发布状态；新增输入需要重新审批。如果某个输入空间之后收窄了受众，这些空间负责人会收到一条 `publish_review` 待办，决定保留还是撤回审批；在此期间读者看到什么，由 `source_restricted` 策略决定（`notify` 保留，`quarantine` 隐藏）。
   - **共享缓存遵循同一边界。** 回答缓存以可读空间集合和授权级别为键；缓存项用到的任何单元的标签、依据或授权发生变化时，该缓存项即被丢弃。用到了只能通过读者本人授权（作为发布者或审批人）才可读的单元的回答，只为该读者缓存。
   - **来源 ACL 只作参考。** 来源同步保留 `kb.acl_snapshots` 和身份关联，但它们只用于：(a) 发布时的可读差异检查；(b) 已发布文档的 ACL 收紧时（`acl_hash` 变化且移除了主体）生成 `source_restricted` 待办。企业策略在 `notify`（默认）和 `quarantine`（在空间负责人决定之前隐藏受影响的单元）之间选择。
   - **发布是移动，不是复制。** 选中的来源（或文件夹子树，它会成为一个独立来源）、页面和 SOP 从个人空间移到目标租户空间。人工产生的内容（上传、编辑、覆盖、评论）一并移动。被移动来源的派生知识在成员域里关闭，在租户域里重建并合并。
   - **凭据只决定保鲜方式。** 每个已发布来源可选：`tenant_connection`（覆盖检查后切换到租户连接）、`member_connection`（保留发布者的连接；需要一条 `ConnectionConsent`，凭据代理只在该同意有效期间把成员连接提供给租户域的来源），或 `snapshot`（无连接，冻结，必须设定复核日期）。成员离开或连接被吊销时，使用该成员连接的来源暂停，该来源的负责人收到 `reauthorize` 待办（改换连接或冻结）。
   - **已发布子树里的新文档**要经过敏感信息和个人信息扫描；被标记的文档成为给空间负责人的 `publish_review` 待办，其余的直接进入（策略 `new_documents: scan | approve_each`）。
   - **租户与成员之间是商业关系。** 租户设定用量池和每个成员的上限（模型预算、存储）；用量按租户、成员和空间计量，每次模型调用同时检查成员上限和用量池，以较低者为准。
7. **引擎不替人写句子。** 主体令牌带 `locale`，引擎生成任何内容（例如编译出的摘要）时都能选对语言，却不接触账号。待办和事件载荷只带消息键和参数，不带展示文字；业务层用英文、中文和日文的消息目录渲染它们。

### 引擎如何实现规则 6

- **访问控制。** 个人空间有自己的 SpiceDB 定义（所有者，加上一条供引擎工作进程使用的直接服务关系），因为 `space.admin` 包含 `tenant->administer`，读者包含 `tenant#member`。单元新增 `publisher` 和 `approver` 关系。`canReadDerived` 保留对派生关系的遍历，但检查的是空间而不是来源文档，并采用上面的依据规则；目前只要任意一个支撑的来源版本可读，它就允许读取，这对 `merge` 是对的，对 `aggregate` 和 `infer` 则过于宽松（目前没有已构建的组件写入这两种派生）。`mirror` 保留 ACL 快照，但不再写入读取元组。检索尚未实现，所以它的过滤条件从一开始就按新规则编写。
- **验收用例。** 权限测试覆盖四种情况，分别在内存图和 SpiceDB 上运行：互相独立的替代依据（任一可读即可）、共同必需的输入（除非全部可读，否则隐藏）、经审批的跨空间发布（对目标受众可读），以及之后某个输入空间收窄受众（产生待办，然后按 `notify` 或 `quarantine` 处理）。同样的用例也通过搜索、事实槽读取和回答缓存运行。
- **合并范围。** 事实槽和冲突按域编键：`slotOf` 和治理相关的表使用域键，而不是只用租户。
- **移动 = 显式重建。** 规范化会跳过未变化的版本，所以移动时发出一个引擎内部的 `source.moved` 事件，目标空间里的每个块都会被重新读取。陈述从不删除；“丢弃”的意思是关闭。
- **个人页面重新指向。** 引用基于片段，片段 ID 由块 ID 和文本得出。整个来源被移动时片段 ID 不变，所以个人页面仍能解析到原段落，现在通过发布者授权可读。完全匹配（相同片段、相同陈述）时，用重建后的陈述取代成员域里的陈述；否则旧陈述以“已移动”撤回并显示标记。成为独立来源的子树会得到新 ID，所以移动时写一份新旧文档对照表，片段按文档、锚点和文本哈希重新匹配。页面保持不可变：读取时解析，下一次编译写入新 ID。

## 主体令牌

Web、CLI 和 MCP 共用一条校验路径。由业务层签名的 JWT（EdDSA），引擎用公布的 JWKS 校验。Web 签发的令牌有效期最多 5 分钟，OAuth 访问令牌 10 到 15 分钟。

```
iss, aud = engine canonical URI (RFC 8707 resource), exp, iat, jti
sub        PrincipalId (mem_ | agt_ | svc_)   # never a usr_ user ID
tid        TenantId
kind       PrincipalKind
obo        PrincipalId          # agents: the member they act for
scope      "knowledge.read knowledge.propose comments.write" | "provision.directory" ...
spaces     SpaceId[]            # optional agent space scope
max_sens   SensitivityLabel     # optional
locale     Locale               # the account's UI language: en, zh-CN or ja
auth       { method, mfa: bool, at: Instant }   # how the session signed in
grant      string               # agent grant ID, for revocation
```

令牌对应现有的 `Principal`（`authz.yaml`），后者新增可选的 `auth_context` 和可选的 `locale`（使用已有的 `common.yaml#/$defs/Locale`）。`auth_context` 只用于策略（例如管理命令要求 MFA），从不当作身份。`max_sens` 只能收窄：有效许可级别 = min(令牌 `max_sens`, SpiceDB 许可级别)。代表成员行事的智能体，只有在 `spaces` 缺省或包含该成员个人空间时才能进入它。

## 新文件 `tenancy.yaml`

- `TenantKind` personal | team | enterprise；`TenantStatus` active | suspended | deleting。`Tenant` 新增 kind、status、region 和 `default_locale`。
- `MemberStatus` invited | active | suspended | left。
  `Member { id: mem_, tenant_id, status, display_name, email?, roles: [owner|admin|security_admin|auditor|member|guest], clearance?: SensitivityLabel, guest_spaces?: SpaceId[], guest_expires_at?, version }`
  这些是内部角色。产品里的超级管理员同时持有 `owner`、`admin`、`security_admin` 和 `auditor`；引擎把它们分开保存，所以以后的三员分立预设只改变业务层授予的组合。
- `MemberLimits { member_id, model_budget?, storage_bytes? }`（由业务层根据套餐设定）
- `Group { id: grp_, tenant_id, name, member_ids, group_ids, version }`、`Department { id: dep_, parent_id?, name, member_ids, version }`
- `ExternalIdentityLink { provider: PluginName, external_tenant?, external_id, principal_id }`（例如把飞书 union_id 映射到 `mem_`；只用于可读差异检查）
- `AgentRegistration { id: agt_, tenant_id, owner_id: mem_, kind: client | tenant_agent, scopes, space_scope?, max_sensitivity?, status }`
- `DirectorySnapshot { tenant_id, version, members, groups, departments, links, agents }` 和 `DirectoryDrift`（按分区计数）
- `TenantPolicy { version, publish: { member_connection_freshness: allowed | off, new_documents: scan | approve_each, source_restricted: notify | quarantine }, dispute: { serve: last_verified | both | withhold }, models: { max_external_sensitivity }, retention: { departed_personal_space: Duration } }`。`departed_personal_space`：个人空间被锁定、任何人都不能读，经过这段时间（默认 30 天）后删除。
- `ApprovalPolicy { mode: single | any | all | quorum, quorum?, deadline: Duration, fallback_ids? }`。没有 `fallback_ids` 时，投票分裂或超过截止时间交给空间的负责人；冲突跨空间时交给租户管理员。
- `OwnershipScope` space | taxonomy_node | page | sop | knowledge_model | claim；
  `OwnershipAssignment { scope_kind, scope_id, owner_ids, backup_ids, approval_policy }`。引擎按最近一级被指定的范围、空间负责人、租户管理员的顺序确定待办的处理人。存放在 governance 组件自己的 Schema 里（不在知识存储的 `kb` Schema 里）；负责人和备份只能是 `mem_` 或 `grp_` ID。只用于租户域。

## 对现有文件的改动

- **`authz.yaml`、`packages/access-control/schema.zed`：** `Principal.auth_context` 和 `Principal.locale`（都可选）。`ResourceType` 新增 `connection` 和 `agent`。`tenant`：新增关系 `security_admin`、`auditor`。`space` 不新增 `arbiter` 关系：截止后的决定人是空间的 `owner`，跨空间时是租户的 `admin`。个人空间只有 `owner`，不继承租户上的任何关系。单元（页面、SOP、来源）：新增关系 `publisher`。`publish_request`：新增关系 `approver`，只授予请求内条目的读取权。陈述、页面和 SOP 的读取权 = 其所在空间的读取权；陈述还需要一个读者能读的依据，证据片段和派生输入按可读空间检查，而不是按来源 ACL 检查（规则 6）。
- **`collab.yaml`：**
  - 新增 `SourceFreshness` tenant_connection | member_connection | snapshot。
  - `PublishRequest`：单个 `unit_id` 改为 `items[]`（页面、SOP、来源、文件夹子树）；`to_space_id` 即目标空间；在已有的 `gates` 旁新增 `source_actions[] { source_id, subtree?, freshness, connection_id?, consent_id?, review_at? }` 和 `checks { coverage: CoverageDiff[], audience_gap: AudienceGap, sensitivity { suggested_label, findings[] }, conflicts: ConflictPreview[] }`。
  - 新增 `ConnectionConsent { id, connection_id, source_id, member_id, granted_at, revoked_at? }`。
  - 新增 `Decision { scope: ResourceRef, resolution_key | proposal_id, decided_by: PrincipalId[], approval_id?, rule?: PrecedenceRule }`，供“决定待办”和“决定发布请求”使用。引擎复核每位审批人在该范围上都有 `verify` 权限。发布决定可以修改 `to_space_id` 和敏感级别标签。
  - 新增 `ResolutionRecord { id, conflict_id?, todo_id, options, votes[] { principal_id, option_key, at, note? }, outcome, rule_id?, decided_at }`。
  - 新增 `PrecedenceRule { id: rul_, scope, match { entity_type?, predicate?, source_ids? }, prefer: source | authority | newest_effective | human, status: active | retired, created_from }`。
  - `TodoKind` 新增 handover、reauthorize、source_restricted（publish_review 已有）。
  - `Todo.title` 改为 `message { key, params }`，由业务层用读者的语言渲染。
- **`knowledge.yaml`：** 实体、陈述、事实槽和冲突案例带域键（`member:<space id>` | `tenant`；可以由空间推导，为建索引而存储）。`ConflictCase` 新增 `scope_ids` 和 `participant_ids`。
- **`retrieval.yaml`：** `IndexFilter` = 可读的 `space_ids` + `max_sensitivity`（+ 发布者授权）。结果新增 `dispute? { conflict_id, since, serve }`；读者可读空间之外的引用以 `restricted` 返回。
- **`source.yaml`：** `Source.connection_id`（来自连接器设计）、`Source.freshness`、`CoverageDiff { reachable, unreachable[] { external_id, reason }, added }`、`AudienceGap { audience_size, cannot_open, documents[] { document_id, cannot_open } }`（只在能精确读取 ACL 时计算，否则为 `unknown`）。
- **`events.yaml`：** `todo.updated`、`publish_request.updated`、`decision.applied`、`member.offboarded`、`usage.recorded`（每小时一次，按租户、成员、空间和预算键），以及引擎内部的 `source.moved`（发布时触发重建）。`connection.changed` 来自连接器设计。任何事件载荷都不带展示文字。
- **`gateway.yaml`：** `UsageRecord` 新增可选的 `member_id` 和 `space_id`，预算检查同时读取成员上限和租户用量池。
- **`common.yaml`：** `RuleId`（`rul_`）和 `MessageKey`。组件名是 kebab-case（`^[a-z][a-z0-9]*(-[a-z0-9]+)*$`），所以 `tenancy` 这类业务层名称可以通过。只有引擎发布事件；业务层组件以消费组的形式，列在 `components.yaml` 新增的“外部消费方”一节下。
- **传输：** 原型阶段，业务层消费方用自己的消费组读取引擎的 Valkey 流；产品提供事件拉取端点。访问控制的写操作已经返回 ZedToken，决定把它作为 `consistency_token` 携带，所以开通命令会把它传下去，保证写后读一致。`usage.recorded` 由模型网关通过 outbox 产生。

## 命令与查询

内网 REST，由 Schema 生成。

| 分组 | 操作 | 主体 |
| --- | --- | --- |
| 租户 | 开通（类型、名称、地区、默认语言、默认策略）、停用、恢复、导出、删除（宽限期后加密粉碎） | 服务 `provision.tenant` |
| 通讯录 | 新增或更新成员、群组、部门；批量身份关联；快照对账；分区摘要；成员离开（指定移交对象） | 服务 `provision.directory` |
| 智能体 | 新增或更新智能体登记、吊销授权 | 服务 `provision.agents` |
| 策略、负责人 | 写入企业策略；写入负责人指定 | 租户管理员，或上一级范围的负责人 |
| 空间 | 创建、移动、设定可见范围（授予或撤销角色）、移除发布者授权 | 租户管理员或空间负责人 |
| 发布 | 运行检查（覆盖、可读差异、敏感信息、冲突）、创建发布请求、撤回 | 成员 |
| 决定 | 决定待办、决定发布请求 | 服务 `decide`，并列出审批人 |
| 连接 | 凭据代理的发起、完成、启用、丢弃、吊销；授予或撤销连接同意 | 成员或租户管理员 |
| 用量 | 设定租户用量池和成员上限，按租户、成员和空间读取用量 | 服务 `usage` |

成员离开：删除其权限元组；吊销其成员连接、连接同意和智能体授权；暂停由这些连接保鲜的租户来源（生成重新授权待办）；把已发布单元和负责范围移交给空间负责人（生成移交待办）；锁定其个人空间（任何人都不能读），在 `retention.departed_personal_space` 之后删除；发出 `member.offboarded`。

## 引擎工作量

净增约 4.5 人周。

- **第 1 阶段（3.5）：** 令牌校验和服务主体 0.5；开通、对账和成员离开 1；策略与负责人 1；发布到租户域 1.5（借助 `source.moved` 的移动与重建约 0.5、保鲜方式选择、同意、覆盖、可读差异、新文档扫描）；两个知识域和按空间与依据判定可见性 0.5（域 +1，派生可读性的遍历改为检查空间而不是来源 ACL −0.5）；多人决定 0.5；SSO 和通讯录同步移出访问控制 −1.5。
- **第 2 阶段（1）：** 成员离开的细节 0.5；裁决规则和争议标记 0.5。
- **语言：** `locale` 声明和待办上的消息键包含在上面第 1 阶段的各项里。

## 测试接缝

引擎测试工具包：一个开发用令牌签发器（声明相同）和一条 `seed` 命令（租户、成员、群组、空间）。业务层：一个由 REST Schema 生成的引擎替身，加上内存事件流。双方都在 CI 中对照 JSON Schema 校验录制的样例。域隔离有专门的样例：两个成员发布有重叠的来源；发布前什么都不合并，发布后两者落进同一个合并后的事实槽。
