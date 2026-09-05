# MEM-02 实施前契约

这是推荐实施契约，未实现、未获运行验收。先合入并接受实际 MEM-01 及其 execution/stream 依赖，再按最终 predecessor 实施；不提前注册迁移，不改原票、进度或现有迁移。

读取依据：root 原票 38（MEM-02）与 40（MEM-04），root 对象 `b869ef4a9c483dec8abefcd75c7a182a93308c74`；MEM-01 核心 commit `44606fef5b18eb668e40b4f97655e09009c8b022`；完整检查对象为 **tree** `573f139785149f4ab7301a6c97c10752232c4ad4`，包括其 `MEM-01-HANDOFF.md`。后者两个 UI uncertain-command 修复仍待完成，不是最终 accepted tree。下文源码路径均指该冻结 tree，不能用当前工作区同名文件代替验收 pin。

## 原始六项 AC 与用户故事

1. As an authorized group member and Bot editor, I want to review and explicitly approve one memory promotion so that I understand who may receive the derived content.
2. As a participant using the destination Bot, I want it to use that approved memory across its conversations and groups so that the approved fact follows that Bot.
3. As a source-group member, I want every other Bot excluded and source invalidation respected so that one approval cannot become uncontrolled sharing.

| 原始 AC（顺序不变）                                                          | 推荐行为与将来验证                                                                                                                                                  |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI、REST 在确认前展示 source、目标 Bot、visibility、content                  | 同一 preview DTO 显示来源群/记忆/版本/当前消息版本、目标 Bot/版本、完整内容及 Bot-wide 披露；真实 UI 与 REST 使用同一确认命令。                                     |
| 必须有 authorized human explicit confirmation event                          | 人类 session + 当前双侧授权；独立确认动作提交明确 acknowledgment。预览、选中目标、打开页面、Bot/模型输出均不创建 promotion。                                        |
| 保留 source group ID、source memory ID、approver、approval time、own version | 新私有 identity/version 与不可变 approval、完整 lineage 同事务提交；初始私有 version=1，并保留准确 source memory version/current event。                            |
| 目标 Bot 跨 conversations/groups 使用                                        | scope 属于稳定 destination Bot ID；在其合法 direct/group Run 中可选用。批准的目标版本是首次确认 CAS/provenance，不把记忆永久限制到该 Bot 版本。                     |
| 每个其他 Bot list/search/context 无结果                                      | SQL eligibility 先锁定 workspace + 实际 executing Bot + 有效 approval/lineage，再搜索、排序、分页。覆盖 Bot A 主动请求 Bot B 路径，不能用执行人的 B 权限替 A 放行。 |
| 缺 source group access 或 destination Bot edit 时 403、零记录                | preview 与首次 confirm 均重验当前群 content 权限及独立 Bot edit ACL；同 workspace。拒绝不创建私有记录/版本/批准/成功回执，拒绝审计仅存安全元数据。                  |

原 non-goals 保持：无 bulk promotion、automatic cross-group propagation、template/private-memory sharing、workspace knowledge promotion。无通用 COL-19 approval engine；不把 MEM-03 extraction/candidate job 或 MEM-04 forget/independent retention 提前塞入本票。

## 已有事实与必须新增的能力

- `memories/schema.ts` 的实际 0020 只有 `group_memories`、`memory_versions`、`run_memory_references`。版本表 FK 指向 group memory，约束 `version=1`，没有复制正文；Run reference guard 要求同 Task conversation/group、准确 grant、当前来源。三表 UPDATE/DELETE/TRUNCATE 被拒绝。**改一个 scope 字符串不能得到 Bot 私有存储或跨群 manifest。**
- `memories/current.ts`、`conversations/message-source.ts` 用准确 original creation event/sequence 与 current revision event，排除后续 edit/delete、任何 pending/completed purge；eligibility 在 search/LIMIT 前完成。point selector 本身不授权，调用者须已经 admission 并持有结构锁。
- `lockAuthorizedGroup(..., 'content')` 要求当前 workspace + source group membership；workspace admin 没有越过群 membership 的隐式权限。`lockAuthorizedBot(..., 'edit')` 只允许当前 owner/editor；Bot 可发现性、使用 grant、workspace admin 均不等于 edit。
- `GroupBotTransaction.lock` 校验调用人的当前群权限、**准确未关闭 grant ID**、原 grantor 当前 workspace/Bot-use 权限及 Bot active。重新邀请生成的新 grant 不能替代 Task 已 pin 的旧 grant；它也不借出 Bot 配置检查权。
- `memories/run-context.ts` 当前仅选 group memories，最多 100 条，和 instructions/ordinary messages 共用 1,000 项、1 MiB；claim 保存实际选中 memory version/source event，后续 delta/final 重验。普通 message 的完整 selected provenance manifest 不是现有能力，是 MEM-03 已协调的新范围。
- `bots/copy-service.ts` 已用 allowlist 复制配置并明确排除 `memory`。新增私有记忆不放进 Bot configuration、copy/template/export DTO，也不随新 Bot ID 复制。

新增逻辑存储/DTO：短期 promotion preview intent、不可变 promotion approval/command receipt、Bot-private memory identity + version（payload kind `source_reference`）、Bot-private selected Run references，以及严格 preview/confirm/private-read DTO。优先新增私有表/typed manifest 分支并保留 group 约束；具体 DDL 只在真实依赖存在后确定，不能重写 0020 或先占迁移号。

## 一次确认与引用语义

推荐 **source reference**：目标有自己的私有 memory/version，正文仍由准确 source group-memory version 和当前消息版本物化；不复制独立正文，不自动跟随来源的新版本。来源变更后，旧私有版本立即不可检索/使用，重新批准当前有效记忆才能产生新的可用记录。

一次批准扩展的仅是这条派生内容的使用范围。之后目标 Bot 的合法参与者可以不属于原群；每次使用都要求参与者重新加入原群会违反 AC4。批准不开放原消息、源群历史、其他群记忆或其附件接口，也不允许另一个 Bot 检索这条私有记忆。

预览中的明确文案建议：**“批准后，［Bot 名称］可在它的所有私聊和群聊中使用这条记忆；回答可能向这些对话的参与者透露派生内容，包括不在来源群的成员。”** 内容、来源和目标紧邻该文案，确认不得默认勾选或在选择目标时自动提交。不需要第二个通用 approval 流程。

推荐 session-only REST 边界（均为新接口名称，非现有能力）：

| 操作                                                                  | 命令与响应边界                                                                                                                                                            |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/workspaces/:w/groups/:g/memories/:m/promotions/preview` | 输入 destination Bot ID、expected source memory version/event、expected destination Bot version。服务器重新取内容并返回 preview ID、完整 review DTO、披露版本及过期时间。 |
| `POST /api/v1/workspaces/:w/groups/:g/memories/:m/promotions`         | 只接受 preview ID、稳定 idempotency key、`acknowledgeBotWideUse: true`；不接受客户端指定 approver/time/visibility 或替换正文。首次 201，同命令已提交回执 200。            |
| 目标 Bot 的 private list/read、POST search                            | 人类管理路径要求当前 destination Bot edit；Bot 执行路径单独绑定真实 Run 身份，不能把管理权限当执行身份。沿用有界 limit/cursor、POST search/no-store 和安全错误约定。      |

Preview intent 建议有效 5 分钟，保存 actor/workspace、source group/memory/version、source conversation/message/current event/original creation event+sequence、destination Bot/current version、规范 intent hash、disclosure version、issued/expires time。其 hash 绑定准确审阅内容与字段；持久 preview/audit 不复制正文。Preview 不是批准。只有先通过双侧当前授权才能返回内容，严格拒绝未知字段及跨 workspace 参数。

首次 confirm 在同一 SQL transaction/connection 中：按 workspace → source group → destination Bot → source conversation 顺序取得结构锁，重新验证人类当前双侧权限、来源完整 current lineage、目标版本与 preview 绑定、未消费且未过期的 intent，再写 private identity/version、approval、唯一 command receipt 与 mandatory `memory.promoted` audit。最后在提交前再次检查 preview 截止时间；等待或 audit 写入越过截止时间须整体回滚。源/权限写入也必须遵守相同结构锁，不能在另一条连接上只做一次预检。

目标 archived 可按现有 edit 权限管理并明确显示暂不可执行；`use` 仍要求 active。推荐 deleted 目标不接受新 promotion，独立明确该 guard，因为现有 Bot `edit` 本身不拒绝所有 deleted ACL 持有人。无需 provider/model 调用或 provider 凭证来预览/批准。

## 不可变批准、重放与冲突

Approval/version 至少持久化：workspace、destination Bot、approved Bot version、私有 memory/version ID/number、source group/memory/version、完整原始/当前 source locators、approver user ID、approval time、preview ID、disclosure version、intent hash。公开 projection 给出 AC3 provenance；普通 Bot/provider contribution 仅含必要私有内容与识别信息，不赠送来源群或消息访问能力。

- 命令 key 1..128 可见 ASCII，按 workspace + actor + promotion command 域唯一；规范 intent hash 排除 key。数据库唯一约束承担并发幂等，不能依赖进程缓存。一个 preview 至多产生一次 promotion；换 key 消费已用 preview 返回 conflict，不制造第二份批准。
- **首次提交**要求预览仍有效、source 仍是准确已审阅版本、目标仍是已审阅 Bot version。当前授权先于详细冲突判断；权限失效/不存在/跨 scope/源已删除或 purge 返回安全 403。已授权但 source revision 或 target version 改变返回安全 409，必须重新预览，不能悄悄把旧内容替换成新内容。过期未提交 preview 为 409 `promotion_preview_expired`。
- **相同 key/相同 intent 的已提交重放**先校验当前双侧权限及原引用仍有效，然后返回原 approval/private version。Preview TTL 到期、同一 Bot 后来升级不重新执行首次 CAS，不产生新版本/审计/批准。相同 key 不同 intent 为 409。来源失效或当前权限失效则安全拒绝，不从回执恢复旧正文、不重建记录。
- 审批是当时合法的人类决定，不是持续借用 approver 的 session/provider grant。之后普通角色变化本身不改写已批准事件；后续有效性由 destination 使用权限、current lineage 和将来的显式 revoke 状态决定。MEM-04 可增加撤销事件，不原地修改批准历史。
- private identity/version、approval、receipt、mandatory audit 同 commit；任一写入或最终 guard 失败全部回滚。沿用 MEM-01 的拒绝审计模式：拒绝 audit 成功提交后 403；audit 故障为安全 503，不能把写入失败报成已批准。
- UI 为一次确认固定 preview ID + key，uncertain response 保留原命令，按钮只重发同命令并能解析原回执；reload 后仍恢复未确认命令。恢复的是命令标识，不把预览正文写入长期浏览器缓存。不得静默换 key、自动刷新 preview 后批准，或把没收到响应当成服务端没提交。已知 source/preview conflict 才进入明确重新预览动作；取消未解决命令后也不能暗中再发。

## 私有选择、当前授权与 Run manifest

人类管理授权和 Bot 执行授权是两个入口。执行时 destination 来自已持久 Task/Run 的 workspace + Bot ID，沿用原 execution user、pinned Bot version、direct 权限或 exact group grant admission。客户端、Bot 工具参数、prompt、自报 Bot ID 都不能建立这个身份。当前没有独立的任意 Bot HTTP principal；不要宣称传一个 botId 参数就是安全的 Bot API。

实际 selector 先断言 trusted executing Bot 与 requested Bot 一致；Bot A 请求 B 路径即使执行人拥有 B edit 也拒绝，不能返回 B 的 count、snippet、cursor 或命中信息。对 A 自己的 list/search/context，B 的记录根本不进入候选集合。Source current checks 通过精确 approval/lineage 容许这一条跨群引用，不能给执行人通用 source-group read；原消息 locator 仍走原群权限。没有人类管理 API 兜底绕过执行 selector。

合格版本必须同时满足 same workspace、exact destination Bot、批准已提交、准确源 memory/version/current event、无 superseded/tombstone/pending-revocation/revoked/purge 状态。未来新增状态必须接入同一 predicate，检索索引不是权威。来源群当前是否仍存在及源事实有效性要检查；未来参与者是否为源群成员不是派生内容 scope 的额外条件。

保持现有总预算：**group + Bot-private 合计最多 100 条记忆**，UTF-8 内容与 instructions、普通上下文共用 1 MiB/1,000 项，不给每种 scope 各加一份额度。无静默截断或新检索排名承诺；超限沿用 context-limit 失败且 provider 零调用、零 partial manifest。贡献标为记忆数据而非 system 指令，保留 Task trigger 在上下文末尾。

claim transaction 保存实际发送的 private version、approval、source memory/version/event locators，与现有 group 引用原子提交；只保存引用，不在 manifest 再复制正文。每次新 Run claim 独立选择当时合格集合；同一 Run 的后续 delta/final 只重验其已选 manifest，新批准的记忆不得中途加入。

跨群 private source 不受**目标群** grant lower-bound/trigger sequence 数值限制，因为不同 conversation sequence 不可比较；它靠显式批准的 lineage 授权。目标群 ordinary/group-memory 仍保留原 exact-grant lower bound + trigger horizon，不能因加入 private 分支削弱旧检查。

新增结构锁安排：现有 `TaskQueue.lockStructure` 仅锁目标群/Bot/conversation，随后锁 Task/Run，不能再向后追加跨群源 conversation 锁。先在 workspace 锁下发现有界源集合（claim 的候选来源，publication 的固定 manifest 来源），将目标及源 groups/conversations 按稳定 ID 顺序锁定，再到 Task/Run、provider。所有源使用同一连接，结构锁不等于授予读取权限。源变更、权限/grant 撤销在等待期间发生后必须重新读事实；失败状态 publication 也要遵守顺序。

source 编辑/删除/purge、grant 关闭或当前 execution 权限丢失后：未 claim 的 Run 不选失效记忆；已选该引用的 Run 不再提交后续 delta/final，也不生成替代正文绕过拒绝。已合法传出的字节不能召回。最终输出、state/feed、audit 与 guard 失败之间仍需原子回滚，保留现有 deadline 与 claim-token fencing。

## MEM-03 / MEM-04 窄接口与实施门

与 MEM-03 规划者已对齐：可共用 destination admission、canonical confirmed-intent/receipt、current-lineage reader 和已批准目的 memory writer；candidate/job lifecycle 独立。MEM-02 的 immutable payload 是 `source_reference`；MEM-03 的 edited approved-fact body 是另外必须实际新增的 `approved_fact`，不能声称 MEM-01 已有，也不能用禁用目的 scope 代替其 AC。普通上下文来源 manifest 由 MEM-03 新增；两类已选来源应在同 claim transaction 提交和 publication admission 中合并。

MEM-04 是显式演进边界：edit 追加版本；forget/tombstone、源删除及 purge 立即使所有 linked derivatives 不可用，将来追加 pending-revocation 状态而不等后台索引更新。逐层检查 source memory/version 到原消息的 lineage，不能仅检查最后一条引用。**MEM-02 没有 independent retention 开关或复制正文后继续使用的退路。** MEM-04 的授权人另行明确 retain-independent 或 revoke，产生新版本/批准语义；原 promotion 不等于这次决定，源已 purge 时也不从日志或旧 preview 恢复文本。

索引重建必须重新经过完整 eligibility；普通历史/审批审计保留 ID、时间、动作等必要元数据，不含被遗忘正文。任何将来历史详情或 independent-fact 存储也须承担实际 content purge，不能凭 immutable 元数据名义永久保留文本。

实施时在真实合入依赖上先写并观察失败，再实现；这里只规划下列门，未运行测试或服务：

| 门                                         | 必须覆盖的真实行为                                                                                                                                                                                                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain/REST + strict Web DTO               | 六 AC；完整 preview；无确认零写；source/Bot version conflict；过期；未知字段；same-key replay/changed payload；wrong Origin/session；source/Bot/current workspace 权限矩阵；无配置/模板泄漏。                                                                                   |
| SQL/current-source + provider seam         | A/B/其他 workspace 的 list/search/context；A 请求 B 路径且执行人恰有 B edit；B direct 与另一群合法使用；source edit/delete/purge；private + group 共享预算；新记忆不加入已选 manifest；失效后无后续 delta/final；旧 grant 拒绝。                                                |
| Native runtime-role + 实际迁移/provisioner | 真实 concurrent confirm 同 key/preview 唯一；版本/批准/lineage immutability；mandatory audit/最终过期回滚；观察 `pg_stat_activity` Lock 与 `pg_blocking_pids` 的 source/ACL/grant 撤销等待；跨来源锁序；claim/selected references 与 output/feed 原子性。pg-mem 不冒充 native。 |
| 实际浏览器/BFF/worker                      | 一次明确披露并确认，刷新 provenance；网络丢失但服务端提交后的同 key 恢复；完整内容不混入未批准状态；目标 Bot direct/异群回答可用、另一 Bot 没有注入；来源失效 UI 及后续输出拒绝。不能仅靠模型口头回答证明隔离，须同时断言 provider 输入/manifest。                              |

MEM-01 handoff 里的 14 个 native cases 是 registered/skipped，Compose 也是 external，旧 browser/type/build 数字仅是其 checkpoint 报告。此规划无测试门重跑、无 native/Compose 成功证据；实际 MEM-01 两项 UI 修复、最终统一依赖、独立审查与部署门保持外部待办。
