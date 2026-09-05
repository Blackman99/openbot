# COL-08 — Pause/resume 预实现交接

设计准备，2026-09-05。本文只形成可实现契约，没有实现 COL-08、修改原票或登记任何 migration，也不构成运行验收。Root 审阅后决定如何纳入仓库。实施时先固定已验收的 COL-07 最终源及 COL-10 共享 writer 接口，再只审与本基线的必要差异。

## 1. 权威输入与边界

| 输入 | 本次读取的固定来源 | 用途 |
| --- | --- | --- |
| 原票 25 / COL-08 | `aeb6560b3e4740bf287e4d901b8ad70131c53026:.scratch/openbot/issues/25-col-08-pause-and-resume-tasks-from-checkpoints.md` | Outcome、原五条 AC、非目标；冻结票仍被 COL-07 阻塞 |
| 实际 COL-07 组合 | commit `aeb6560b3e4740bf287e4d901b8ad70131c53026`，tree `de310b7026198ef789b9389cf00434592b24bf27` | 取消事务、Task 树、durable partial、当前 claim/祖先 fence、实际 0023 guards；此 pin 的窄共享合并已 Spec CLEAN，不冒充整票最终验收 |
| 已验收统一组件源 | `0ff6898eee671f04987fd5024a0bbc3c2d0afef4`，已导入上述 COL-07 pin | COL-05 流、COL-06 routing、COL-09 重试/历史、MEM-01 最终源准入及 pending command 修复 |
| 组件意图 | COL-05 `9425c6647869668bc6de9112349d69219cd40131`；COL-06 `9be9f17baba8cde4ec801b32ab091e36520f64fc`；COL-09 `4c025e593cb2db80c767abe74896bac7344bd1c7` | 已完成组件的原契约；不重复全量审查 |
| COL-10 预实现契约 | `/workspace/scratch/2bc98607b3a9/COL-10-PREIMPLEMENTATION-HANDOFF.md`，SHA-256 `af3c78ab8c8af45e2b29bd1d17901f0a622b808dc5c24a95127f8413b99fbf75` | 版本化模型计划、共享 chain budget、唯一 next-attempt writer |
| COL-11 预实现契约 | `/workspace/scratch/2bc98607b3a9/col11-preimplementation-handoff.md`，SHA-256 `04d5a4b9c48f3044d023cd17516af08abfc9c80ce1966c63942a3809cf59f71a` | 未来 lease/recovery origin、相同 writer、相同锁序和累计预算 |
| Root 本轮决策 | 本次交接消息确认 | manual_resume 新链；递归 pause/仅所选 Task resume；当前 paused Run 的窄 cancel 例外；restart_from_task_input_v1；保留所选模型位置；新 notBefore 使用恢复事务数据库当前时间 |

源代码只通过 `git show <pin>:<path>` 读取，没有读取作者变化中的 UI 工作树代替 pin。COL-10/COL-11 旧文档中“仅 initial/manual_retry 开新链”的表述由本轮明确批准的 `manual_resume` 扩展；不能把这些尚未实现的设计写成既有能力。

仓库路径为 `/workspace/scratch/2bc98607b3a9/openbot`；下文 `tasks/...` 源文件均位于其 `apps/api/src/tasks/...`，`apps/...` 路径相对该仓库。

## 2. 原票内容与验收映射

Outcome 原文：

> Authorized users can pause queued or running work and resume it exactly once as a new immutable Run attempt.

原五条 AC 原样保留：

- [ ] Queued and running Tasks can be paused through the API and UI.
- [ ] A paused Task holds no execution slot and remains paused across restarts.
- [ ] Resume creates a new attempt without mutating the interrupted Run.
- [ ] Repeated pause or resume requests create no duplicate attempts.
- [ ] Partial output, checkpoint metadata, and transition history remain visible after resume.

原非目标：Provider-native continuation；Offline execution；Automatic scheduling of paused Tasks。

| AC | 可观察行为 | 最小有意义证据 |
| --- | --- | --- |
| 1 | API、普通表单及增强 UI 均能暂停 queued/running，权限一致 | 真实路由 queued pause 零 provider 调用；running pause 保留前缀且中止旧调用；浏览器两条路径 |
| 2 | durable paused 状态阻止 claim/recovery/自动后继，重启后保持；worker 可以处理其他工作 | 独立 worker 的静默 provider 场景、重启、第二 Task 正常执行；数据库拒绝强行 claim |
| 3 | 同 Task 的全局 attempt 加一，新 immutable Run；旧 Run 所有字段不变 | 恢复前后旧 Run、partial、checkpoint、manifest、provenance 快照相同，新 Run 有独立合法 receipt/origin |
| 4 | 同 key replay 返回原 receipt；不同 key/并发命令由 expected Run CAS 决出唯一新 attempt | 真正 commit 后丢响应，再确认原命令；真实数据库同 key/异 key 竞态 |
| 5 | 旧 paused Run 的前缀、checkpoint 元数据和暂停/恢复关联可在历史中读取 | 超过一页的完整 attempt 历史、SSE 过期重新 bootstrap、按旧 Run 读取 durable partial |

用户故事：

1. As an authorized user, I want to pause queued or running work so that it stops using execution capacity while preserving its saved progress.
2. As the original execution human, I want to resume one paused Task from its saved task input so that a new attempt runs with my current permissions.
3. As a user confirming an uncertain command, I want the original key and expected Run retained so that a lost response cannot create another attempt.
4. As a conversation reader, I want interrupted output and transition history to remain distinguishable from a completed answer after resume.
5. As a group owner or administrator, I want to stop a selected subtree without borrowing another user's model authority or silently restarting its descendants.

## 3. 已定状态语义

`paused` 是当前 Task 的持久状态，也是被中断 Run 的冻结状态。Task 与 latest/current Run 的状态始终同态。暂停不新建 Run、不退款 attempt、不清空旧 claim 字段；恢复新建 Run，绝不把旧 Run 改回 queued/running。

| 当前所选 Task / Run | 操作与前置条件 | 提交结果 |
| --- | --- | --- |
| queued / queued | 授权 pause，expectedRunId 匹配 | 同 Run → paused；finishedAt=本次 pause 数据库时间；claim/provider/usage 仍按原值（未 claim 时为空）；建立 checkpoint |
| running / running | 授权 pause，expectedRunId 匹配 | 同 Run → paused；finishedAt=本次 pause 数据库时间；保留原 claim/token/deadline/provider/usage 与已提交 partial；旧回调失去写权限 |
| paused / paused | 同 key pause replay | 原 receipt；不变更 Run、checkpoint、时间或事件 |
| paused / paused | 新 key、相同 expectedRunId 的 pause | 稳定 no-op receipt，引用原 checkpoint/pausedAt，affected counts=0；不改写原暂停归属、不追加重复状态/audit |
| paused / paused | 原 execution human 授权 resume，严格祖先可执行，expectedRunId 匹配 | 新 Run queued，Task queued，全局 attempt+1，新 manual_resume chain；旧 Run 完全不 UPDATE |
| paused / paused，仍 current 且未有 successor | 授权 cancel | 唯一例外：旧 Run 仅 status → cancelled；Task cancelled；原 finishedAt、checkpoint、claim/provider/usage/partial 全冻结；独立 cancellation marker/event/audit 记录取消时间 |
| 更早的 paused Run，已有新 Run | 任何旧命令要求更改它 | 拒绝；尤其不能对旧 paused Run 执行取消例外 |
| completed、failed、cancelled | 新 pause/resume | 状态冲突；failed 的新执行仍是 COL-09 manual_retry，cancelled 不恢复 |

推荐与现有取消 API 一致：所选节点必须 queued/running/paused 才接受新 pause；completed/failed/cancelled 节点可以是被遍历的中间节点，但不成为新 pause 的直接目标。用户可选择其未完成子 Task。终态中间节点不阻断后代遍历。

暂停选中子树内的所有 queued/running 当前 Run，跳过已 completed/failed/cancelled 的 Run；已 paused 后代保留更早的 pause command/checkpoint/时间，不归并到新命令。一次递归暂停不能部分提交。恢复仅恢复所选 Task，不遍历或解除后代暂停；新父 Run 不改变 Task 树结构。祖先之后再次 pause/cancel 会按照当时子树的当前 Run 生效。

严格祖先中的 paused/cancelled 阻止新 resume、queued claim、worker recovery、provider retry、model fallback、子 Task 创建及任何旧执行发布。暂停/取消属于停止操作，可以取得结构锁并停止工作，不要求祖先处于可执行状态。不要把这种停止权限变成启动路径通用的 ancestry bypass。

## 4. 授权、API 与幂等命令

### 4.1 当前 authority

- **Pause / cancel**：复用 COL-07 当前 conversation inspect、workspace/group membership/direct creator privacy；原 execution human 或该 group 的当前 owner/admin 可以停止。停止不要求模型仍可用，不能因为模型被禁用或凭据被撤销就无法暂停。
- **Resume**：仅 Task 原 execution human 可以发起；group owner/admin、Bot creator、worker service identity 都不能代理执行。原用户可恢复管理员暂停的 Task，但仍受当前权限及严格祖先状态约束。
- 新 resume 逐项重验当前 conversation 执行权限、原 exact group grant（包括 grantor 当前 authority）、原 Bot lifecycle/固定 version、所选完整 binding 的当前权限/credentials/capabilities。关闭再重新邀请的 grant 不是原 grant，不能替换。
- 入队检查不替代 claim、每次 delta 与最终 publication 的当前授权检查。沿用 MEM-01 source final admission、COL-05 deadline/current claim guards；访问失败不可用新 route/default/model 或其他用户凭据绕过。
- receipt 的再次读取也先做当前授权；受保护 receipt 不因权限撤销而删除。若已存相同 key receipt，返回它不能分配 Run、重建上下文或消耗预算。状态/祖先改变不能使 receipt replay 变成新执行；新动作仍被 ancestry fence 拒绝。恢复 replay 的模型检查使用该 receipt 原 selected binding，而非后来 attempt 的模型。

### 4.2 建议的窄 HTTP 契约

继续内部 cookie API 基址 `/api/v1/workspaces/:workspaceId/conversations/:conversationId/tasks/:taskId`：

| 路径 | 严格请求 | 响应 |
| --- | --- | --- |
| `POST .../pauses` | `{idempotencyKey, expectedRunId}` | 200，`{task, pause}`，Task 是当前投影，pause 是原稳定 receipt |
| `POST .../resumptions` | `{idempotencyKey, expectedRunId}` | 202，`{task, resume}`，Task 是当前投影，resume 精确指向该命令创建的 Run |
| 现有 `GET .../runs/:runId/partial-output` | 保留 exact scope/path 与不接受 query 的契约 | 对 paused 与 cancelled 的合法历史 Run 返回现有 bounded partial envelope；queued 时暂停可为 `partial:null` |

请求拒绝额外键、重复 form 值、不合法 UUID、空 key、超界 key。key 继续使用现有可打印 ASCII 1..128 字符限制。POST 保持 exact Origin、session、private/no-store；scope 校验在产生任何写入前完成。不存在新的 public `/v1` 执行接口。

建议 pause receipt：`commandId, taskId, rootTaskId, runId, attempt, checkpointId, pausedAt, affectedTaskCount, affectedRunCount`。第一次命令计数包含所有本次实际转为 paused 的 Run；same-key replay 返回原计数；新 key 的已暂停 no-op 返回零且保留原 pausedAt。

建议 resume receipt：`commandId, taskId, fromRunId, checkpointId, runId, attempt, resumedAt`。`fromRunId` 是不可变 source；新 Run ID/attempt 是 receipt 本身的结果，不得用当前 latest Run 代替。bounded provenance 可单独投影，命名与唯一 writer 的冻结接口对齐。

命令唯一键为 `(taskId, actorUserId, idempotencyKey)`，pause/resume 使用各自分型 receipt。相同 key 改 expectedRunId 返回 idempotency conflict。相同 key replay 必须在分配新 Run 和检查新动作状态之前识别；不同 key 的 resume 一旦 source 已不 current，即 expected Run conflict，不能自动把表单改成新 Run 再提交。一个 paused source 最多有一个实际 successor。

语义错误保持安全错误码：invalid=400、当前访问拒绝=403、expected Run/state/idempotency/ancestor/budget/attempt exhaustion=409、无法确认事务结果=503。最终代码名与现有 Task error union 协调，不能把已知 409 伪装为可自动重试的网络错误。只有明确 401 清 session，其他失败保留用户命令。

### 4.3 丢响应与界面命令生命周期

在第一次发送前保存不可变 `{operation, workspaceId, conversationId, taskId, idempotencyKey, expectedRunId}` intent。此对象独立于 SSE feed、SSR load 的新随机 key、Task 当前 Run 和 live preview；网络错误、commit 后响应丢失、410/expired、断流、resync/bootstrap 不清空或改写它。用户点击“确认原命令”时原字段逐字重发；明确成功或用户明确放弃后才释放。正常 full-page form 的失败页也必须保留原字段，不能只支持 enhance 路径。

页面重新加载而处于不确定状态时，保留/恢复命令所采用的浏览器机制不得泄露 token 或原文；若采用 sessionStorage，只存上述最小 intent，并按用户/route 隔离，在登出时清除。不要求离线执行或后台重发。机制由 Web 作者与已验收 MEM pending-command helper 对齐，不能恢复此前“reset feed 导致换 key”的缺陷。

## 5. Durable checkpoint 与重新执行语义

唯一策略为 **`restart_from_task_input_v1`**，schema version 1。其含义是按原 Task 的输入范围重新执行一次，不是继续 provider KV cache、恢复 stream session 或从 token 断点续写。UI 文案应明确“按原输入重新执行，保留旧片段”。

每个真正暂停的 Run 恰有一份 immutable checkpoint，与 pause command/marker 在同一事务创建；queued 且零字节也必须有 checkpoint。推荐独立表以 `runId` 唯一键约束，而非修改 Task 原输入或把长文本塞进 receipt。

| Checkpoint 内容 | 保存规则 |
| --- | --- |
| identity/version/strategy | checkpoint ID、runId、taskId、version=1、固定 strategy；不可更换 |
| pause provenance | pauseCommandId、pausedAt、previousStatus queued/running；精确 command subtree 归属 |
| 原执行范围 | 用外键/可验证引用关联 Task 的 workspace/conversation、execution human、Bot version、exact grant、trigger event/creation-sequence horizon；不复制可变 prompt |
| 原 selected plan | 引用 source Run 的 immutable 完整 binding/modelPosition；尚未 claim 的 queued Run 记录“已排定计划”，不伪造 provider claim/connection revision |
| 输出 checkpoint | `endByte` 可为 0；引用同 Run durable partial；已有 prefix 必须恰好对应已提交 delta progress，字符/字节上限沿用 COL-07 |
| 既有上下文证据 | 保留 source Run 的 memory manifest/引用；不把旧 plaintext、credentials、provider session 或未提交 callback 缓存放入 checkpoint |

COL-07 每次 delta 的 durable partial 已与 progress/delivery 同事务更新。pause 在 source Run 锁下读取这些事实并冻结，绝不从可能过期的 SSE feed 拼接，也不把未提交的最后 callback 字符写入 checkpoint。零字节使用 endByte=0、partial=null，不制造不符合现表 body 非空约束的空 partial 行。

恢复沿用同一 Task/trigger horizon、Bot version、grant、routing decision；模型输入由现有当前授权 source reader 重建：采用原 horizon 内当前 revision/tombstone，排除后来的消息，不重放旧捕获 prompt。MEM 重新执行现有 selection/admission，在新 claim 持久化新 Run manifest，每次 delta/final 继续检验其来源；旧 manifest 作为旧 Run 证据保存，不复制为新 Run 的授权证明。

旧 partial 只作带 Run 标识的历史片段，不拼入 prompt、不作为新 delta 的 prefix、不转为 final message、不启用保存为 memory 等永久消息操作。新 Run byte offset 从 0 开始，只有其正常完成流程能产生那一个 canonical Bot answer。旧 Run 的部分 usage 如已记录则原样保留；未知 usage 继续 unknown/null，不从文本估算、归零或写到新 Run。每次新调用独立计费事实由其自身 Run 记录。

## 6. 与 COL-10/COL-11 共用唯一 next-attempt writer

COL-10 实施作者 `/root/bot_copy_lifecycle_spec/api02_native` 已确认负责唯一 writer，拟定模块为 `apps/api/src/tasks/next-attempt.ts`，借用 caller-owned `SqlConnection`。这是**待冻结的接口位置/契约**，不是本基线已有导出；正式签名由该作者对齐 COL-09 与最终 COL-07 guards 后给出。COL-08 作者不得另写 allocator、直接 INSERT 第二套 Run 流程或调用现有仅接受 failed 状态的 `TaskService.retry` 冒充恢复。

共享 provenance 的拟定字段及 resume 取值：

| 字段 | `manual_resume` |
| --- | --- |
| `origin` | 增加显式成员 `manual_resume`；与 initial/manual_retry/provider_retry/model_fallback/worker_recovery 区分 |
| `previousRunId` | 本次确切 paused source Run |
| `chainRootRunId` | 新 Run 自身 ID |
| `chainAttemptOrdinal` | 1 |
| `chainLimitSnapshot` | 按 pinned Bot policy 与当前更严格准入形成有效快照；现 COL-10 设计默认 4、硬上限 4；后续累计约束只能收紧 |
| `modelPosition` | 原 paused attempt 实际/已排定 binding 在版本计划中的位置，不回 primary |
| `modelAttemptOrdinal` | 新链从 1 开始 |
| selected binding | 保留完整 scope/connection/model 身份；当前重新准入 credentials/revision/capabilities，不能复用旧 secret |
| 全局 `Task attempt` | locked latest attempt+1，不因 chain 重开回到 1 |
| `notBefore` | **恢复事务在锁等待之后使用的数据库当前时间**；不继承旧自动退避。旧 queued Run 的 notBefore/绑定/position 完全不变 |

Root 已确认：resume 新链后 fallback 只能沿 pinned 计划从该 modelPosition 向后推进，绝不回更早模型。`manual_retry` 回到原 primary 是另一个显式动作；UI 和 origin 不混称。新链不意味着刷新 Task 已花费的 usage、全局 attempt 或未来层级累计预算；已有全局/层级/并发准入仍必须执行。暂停已创建的 queued attempt 不退款，其旧 chain 计数保持。

COL-10 provider retries/fallback 与 COL-11 worker recovery 继续共享单链总量；COL-11 的一次 recovery 子额度也不能被自动动作重置。只有成功提交的显式新 manual_resume（或已授权的 manual_retry）开新链；重复 receipt、事务回滚、权限拒绝都不产生 chain。未来 hierarchical 累计预算跨链累计，不能因人工动作重复而绕过。

共享 writer 的必要职责：

1. 使用外部已持有的资源/Task/Run 锁和同一个事务；根据 origin 的具体 source 状态、authority、plan、真实预算做准入。
2. 将 global attempt、chain ordinal、model ordinal 与 selected binding 作为一份受 guard 保护的事实写入；`(taskId,attempt)`、`(chainRootRunId,chainAttemptOrdinal)` 和实际 source→successor 唯一性共同保护。
3. `manual_resume` 必须有独立 human resume receipt + exact checkpoint；不能制造 `task_retry_commands` 人工重试行。初始、manual_retry、provider continuation、recovery 各自保留原分型 receipt/audit。
4. 分配最多一个 queued successor，并原子切换当前 Task、写 typed queued event、mandatory audit。receipt replay 在进入 allocator 前解决。
5. 自动 stop/no-successor receipt 不是已创建 successor；不要用过宽约束妨碍其后明确获授权的新 manual_retry。不同 origin 争用同 source 时最多一条实际新 Run。

COL-08 只消费 manual_resume 分支及通用守卫，不提前实现 COL-10 失败分类或 COL-11 lease/recovery。若共享 writer 尚未交付，先完成不依赖其签名的契约/TDD 准备，由 root/唯一 owner 协调落点，不能为赶进度复制 writer。最终 migration 必须反映实际已合并 origins；不能用未来占位 receipt 表解除约束。

## 7. 事务与锁顺序

沿用当前资源顺序：workspace → group（如有）→ Bot（该入口已有需要时）→ conversation → root Task → 其余所需 Task（稳定 ID 顺序）→ 所有 current Run（与 Task 顺序一致）→ 命令/checkpoint/共享 provenance（及已存在时的 lease）→ provider admission 资源。

取得任何 Run 锁前先取得本次所需全部 Task 锁。跨子树命令由 immutable root Task 锁串行化；遍历沿 parent/root 结构并穿过终态中间节点。新辅助表的 trigger 不得在持有 Run 锁后临时反向取得新资源锁。当前 `lockTaskAncestry` 将结构锁与“无 cancelled”布尔条件绑定；实现应明确分离锁定的结构事实与 origin-specific eligibility：resume 可以要求 self=paused，但严格 ancestors 必须无 paused/cancelled。不能把 `allowPaused=true` 变成任意旧 Run 都可写的开关。

### Pause 事务

1. 当前 inspect/停止 authority，scope 确认，根与子树全部 Task/current Run 锁；逐一验证 Task/current Run 同态。
2. 找同 key receipt；存在则比对 expected Run 并返回。新命令检查 expected Run CAS、允许状态和完整子树。
3. 在锁等待之后取同一数据库当前时间；确定实际 queued/running 集合。写 human command、每个 source 的 pause marker/checkpoint；原 partial/progress 精确校验，保持所有旧 claim/provider/usage。
4. 每个受影响 Run 只更新 status/本次 execution finishedAt，Task 同步 paused；typed paused state、mandatory safe audit 与 command/counts 在同一提交中成立。
5. 任何 mandatory checkpoint/event/audit/count 不满足，整棵选中子树回滚。commit 后旧 provider callback 已不能写；observer 负责中止进程内调用。

### Resume 事务

1. 当前 inspect/原 execution human 及执行 admission；锁严格祖先、所选 Task/current source Run。按固定 source receipt 处理 replay，不采用页面后来生成的 expected Run。
2. 新命令必须 source=current paused，checkpoint 完整且策略受支持，无取消 marker，无实际 successor；严格祖先可执行。重新准入原 selected plan 与可用预算/并发条件；整数 attempt 上限不能绕过。
3. 使用 caller-owned 事务调用唯一 writer 的 manual_resume 分支；产生新 Run、原 source/checkpoint 关联、command、provenance 和 queued current Task/event/audit。notBefore 是本事务锁后数据库当前时间。
4. 不 UPDATE 旧 Run、partial、checkpoint、usage、notBefore、旧 manifest 或旧 chain；不建新 Task、不重建 trigger、不运行 routing、不直接调用 provider。
5. commit 后由正常 queued claim 执行新 attempt 的 fresh source/model admission。新 provider claim/token/deadline 独立，不能继承旧 token。

Race 结果由同一 root/Task/Run 锁和 expected Run CAS 定义：pause 先提交则 claim/final/自动后继拒绝；合法 completion 先提交则新 pause 状态冲突且保留成功；pause 与 resume 同时只能基于各自确切 source；resume 先提交则针对旧 paused Run 的新 cancel 冲突；cancel 先提交则 resume 冲突。父 cancel 命令若仍指向有效当前父 Run，可以在 resume 子 Task 后取消该子 Task 的新当前 Run，不能仅凭旧 descendant snapshot 跳过它。

## 8. 当前 0023 的精确扩展点：保持暂停冻结与取消例外

以下位置属于固定 `aeb6560b...` 中可重现的新功能缺口，不是对现有 COL-07 的新缺陷结论。实现用**下一次实际有序 migration**替换相关函数/约束，保留已发布 0022/0023 原内容；不把本表直接当作可执行 SQL。

| 固定文件/位置 | 当前事实 | COL-08 必须实施的窄变化 |
| --- | --- | --- |
| `tasks/cancellation.ts`（约 149–154） | 新取消仅允许 queued/running/cancelled；affected 只含 queued/running | 增加 current paused 目标及 descendants，仍验证 exact command、scope、current Run |
| 同文件（约 162、188–191） | cancelled no-op 取 current.finished_at；所有取消都 SET finished_at=cancelledAt | paused→cancelled 分支只 SET status；no-op 从 immutable cancellation marker 取真实 cancelledAt |
| `tasks/cancellation-schema.ts` | Task/Run/delivery/receipt status CHECK 无 paused；cancellation previous_status 无 paused | 在实际迁移加 paused 及严格空值/finishedAt 形态，previous_status 仅为窄取消例外扩展 |
| `tasks/cancellation-postgres.ts` `protect_task_run`（94–114） | ancestry 只认 cancelled；只允许 queued/running 向终态；INSERT 只接受 first 或 failed→queued | 新 paused fencing；queued/running→paused 必须 checkpoint/command；paused→新 Run 的合法插入必须 manual_resume receipt；旧 source 不更新 |
| 同文件 `protect_task_run`（116–127） | marker.cancelled_at、command.cancelled_at 必须等于 NEW.finished_at | 保留旧 queued/running 取消分支；仅 OLD=paused 时允许取消时间独立，要求 NEW.finishedAt=OLD.finishedAt=原 checkpoint.pausedAt |
| 同文件 `protect_task_run`（135–145） | started Run 的结构校验只接受 Task 的 primary binding | 与 COL-10 的 immutable selected plan guard 对齐；暂停/取消验证历史 binding 身份而不要求它现在可调用，resume 再做 fresh model admission；不能允许任意替换模型 |
| 同文件 `protect_task_cancel_command`（177–191） | 允许状态、active count 无 paused，cancelled no-op 仍将 finishedAt 当取消时间 | counted unfinished 集合加入 paused；no-op 指向原 cancel marker，不能覆盖原 checkpoint/finishedAt |
| 同文件 `protect_task_run_cancellation`（202–208） | marker 仅可附 queued/running 的 current Run | paused marker 仅在 exact current source、存在有效 pause checkpoint、无 successor 时插入；来源必须本 command subtree |
| 同文件 `require_cancelled_task_tree`（227–235） | deferred 无 active descendants 检查不含 paused，全部 Run.finishedAt 必须等于 command.cancelledAt | 加 paused descendants；按 previous_status 分型验证时间，保留 exact-one audit/delivery/counts 原子约束 |
| `tasks/retry-schema.ts` `require_current_task_run`（约 133–135）及 0023 Task queued guard | attempt>1 必须 manual retry receipt | 与 COL-10 owner 统一 typed origin/receipt guard；manual_resume 要求 checkpoint，不能伪造 manual retry 行或删除 later-attempt 证据要求 |
| `tasks/tree.ts` 与 SQL `lock_task_ancestry` | 只防 cancelled | 所有启动/发布路径防 paused/cancelled；合法停止路径与 self-paused resume 显式分类 |
| `tasks/cancellation-postgres.ts` partial/publication guards | partial UPDATE 要 current running；DELETE 仅 same Run completed + canonical output | 保留；paused 完全冻结，恢复的新 Run complete 不能删除旧 paused partial；所有发布额外保持 paused ancestor fence |

**paused→cancelled 的完整 SQL guard 条件必须同时成立：**

- OLD.status=paused，NEW.status=cancelled；Task 仍为该 paused Run 的 Task，latest/current=OLD.id，尚无已提交 successor；正常 command CAS 不能编辑更早 attempt。
- exact immutable pause checkpoint/marker 存在且属于该 Run；exact cancellation command 和其 subtree marker 存在，current actor stop authority 在同一事务成立。
- `id/taskId/attempt/createdAt/startedAt/finishedAt/claimToken/deadline/provider scope/connection/revision/protocol/model/inputTokens/outputTokens/error/outputEventId` 全部与 OLD 相同；任何新增的 per-Run plan、schedule、provenance 字段同样冻结。
- partial/checkpoint/旧 manifest 及其时间/字节位置全冻结。`finishedAt` 仍是原 pause 的执行结束时间，不能改成此次取消时间。
- 取消时间只在独立 marker/command/event/audit 中记录，使用本次锁后数据库时间且不早于 pausedAt；matching canceled delivery receipt/audit/counts 必须同事务满足。no-op/replay 不产生第二 marker 或第二状态事件。
- 当新 resume Run 已提交，旧 paused Run 永远不再满足 current/source 条件；其任何 UPDATE，包括“仅改为 cancelled”，都拒绝。

不能只在应用 if 分支实现此例外，不能放宽为通用 terminal rewrite，不能通过清 token/usage/finishedAt 来配合现有 guard。Run 不可变性的 AC3 是 resume 本身零旧 Run 更新；上述 cancel 例外是另一个明确授权的终止命令。

pause 的 deferred 完整性 guard 需要区分“本次暂停事务的 current Task 同态”和“历史 checkpoint 永久完整”。新 resume 提交后 Task 合法为新 Run 的 queued/running/终态；旧 checkpoint 仍属于原 paused Run，不能要求 Task 永远保持 paused，也不能因当前 Task 变化而修改/删除旧 checkpoint。paused→cancelled 后 checkpoint 仍证明原 pause 的 endedAt/partial，仅独立取消 marker 解释后续状态例外。

## 9. Worker、容量与未来 recovery

当前 `tasks/loop.ts` 是等待 `worker.runOnce()` 的串行 loop；基线不存在可供本票释放的 execution-slot 表或 reservation 模块。AC2 的当前实现证据是：paused 从可 claim/active running 中消失，旧调用被现有 serial observer/withAbort 释放，worker 能服务另一 queued Task。不要为了表面满足 AC 新建 COL-13 并发系统。

扩展 COL-07 已有 1 秒 serial cancellation observer，一次调用只有一个 observer，provider I/O 前立即检查一次。当前 Task/Run/token 不再 running 就 abort；旧 promise 迟到 resolve/reject 必须被消费且不能触发新 final/usage/partial/failed 清理写入。数据库写 fence 自 pause commit 起成立，网络中止在健康连接下按 observer cadence 被发现；不声称数据库故障时固定 1 秒 SLA。保持有限 query/lock/provider waits。

启动、poll、due schedule reconstruction 只考虑可执行 queued，绝不把 paused 视作 crashed/runnable；重启不隐式 resume。未来 COL-11 lease observer 复用同一 loop；pause 后 heartbeat 不续租，recovery 不把 paused 标为 worker_interrupted、不消费 recovery 次数、不建自动 Run。恢复后的新 claim 才生成自己的 lease。所有旧 token 的迟到写在新 Run 创建前也已被 paused fence 拒绝。

若实施基线已经有真实 slot/budget 模块，pause 同事务调用其既有释放 hook，resume/claim 走既有准入；不能以新 chain 绕过它。这里只约定连接点，不实现 COL-12 层级调度或 COL-13 容量产品。

## 10. SSE、DTO、历史 UI

- 扩展 API `TaskStatus`、Run/ExecutionState、所有 strict API/BFF/Web status unions 与 nullability。paused 必须 finishedAt 非空、error/output 为空；未 started 的 queued pause 不能有伪造 provider/claim/usage。Task/current Run 同态继续由 DB 与 decoder 验证。
- typed `task.run.updated` 增加合法 paused 投影，复用 COL-05 单个 conversation allocator、durable receipt、cursor/order/retention/backpressure。pause 的已提交 delta 必须排在其 paused 状态之前；resume queued event 指向新 Run，而不是同 Run 从终态降级。
- 当前 Web reducer 将所有非 queued/running 判为终态；应保持 paused 的 late delta 不生效和 interrupted preview，并仅允许同 current Run 的受控 paused→cancelled 事件。比较 identity、startedAt/finishedAt、provider、usage、checkpoint 等不可变投影，不能允许 arbitrary terminal-to-terminal 或旧 Run 的状态改写。无法验证的矛盾流触发受控 resync。
- 对旧存储 execution JSON 保持兼容：历史 queued/running/completed/failed/cancelled 不新增必需字段；新 pause/checkpoint/cancellation/provenance summary 采用明确 bounded optional 字段与 exact allowlist。缺字段兼容不意味着接受任意对象、raw command 或 expanded routing decision。
- 建议暂停元数据最小投影为 checkpoint ID/version/strategy/pausedAt/source status/endByte；取消元数据单独给 cancelledAt。界面区分“执行在暂停时结束”与“后来取消”；不能把 unchanged finishedAt 显示为此次取消时间。resume receipt/new Run provenance 提供 fromRunId/checkpointId 关联。
- `TaskView.runs` 继续只含 current Run，`runCount` 继续真实全局 attempt。COL-09 cursor/horizon/keyset history 保留，旧 paused attempt 分页可见且可读取自身 partial/checkpoint；不把全历史长文本塞进每个 Task 列表或 SSE state。
- durable partial detail reader 扩展 paused（包括已经 resume 后的旧 paused）；exact workspace/conversation/task/run、当前 inspect、字节/字符限制和 no-store 保留。410/bootstrap 只能使 live preview 丢失，不能使 durable checkpoint/历史消失。
- 保留已存小 routing summary、单个 selected decision、原 trigger/Task；直接会话不伪造 routing。pause/resume 不重新选 Bot，不把后来的 group default/version 改动加入旧 Task。
- Task detail/列表的 queued/running 显示 pause，paused 显示原用户可用的 resume 与授权 stop 用户可用的 cancel；必要的 ancestor conflict 由 API 最终裁决。历史 paused Run 没有能改写它的按钮。SSE 页面保持 MEM live save/edit 的独立 pending snapshots。

## 11. 迁移、权限与发布前置

本基线实际迁移链终点是 **0023_task_tree_cancellation**。COL-10 等票可能先合并，因此本文**不预留新编号，不添加未合并 predecessor，不登记占位 migration**。实施前读取实际最终 registry、runtime grants、bootstrap/upgrade/Compose literal，并由 root/merger 安排下一真实编号。

增量迁移的范围应包括：status/nullability CHECK；pause/resume command 与 checkpoint/marker 的 immutable 表/索引；共享 origin/receipt guard 扩展；Task/current Run、ancestor、publication 与暂停取消例外；restricted runtime privileges；deferred exact command/checkpoint/delivery/audit 完整性。每个表仅授予业务需要的权限，原 immutable rows 不开放 UPDATE/DELETE，不能给 runtime role 通用触发器绕过能力。

兼容既有 queued/completed/failed/cancelled 历史，不伪造它们有 pause checkpoint。共享 provenance 的 legacy 回填只能从 retained Task/真实 retry receipts 证明，不能编造 pause/resume。升级应沿用 stop new claims、停止/排空所有旧 workers 的协调过程；在实际前驱需要的 preflight 下拒绝不安全 live 状态，不能用旧 worker 继续写新状态再依赖 UI 补偿。重新启动前原子安装新 guards/grants。已有 migration 字节不改，新的 migration count/native/Compose 断言按真实链更新。

最终合并保留 root 已完成的审计、native fixture 修复、现有 CI jobs/门、原票/progress/root 元数据。新增检查只能明确扩展，不能通过删 gate 或把 skip 改成 green 完成票据。

## 12. 实际测试计划与证据要求

以下均为**待实施的测试要求，本次没有运行测试、服务、数据库或 Compose**。按公共行为先 Witness RED，再 GREEN；不要仅模拟 writer 内部字段证明自身正确。

| 层 | 必须证明的行为与竞态 |
| --- | --- |
| API/worker focused TDD | queued pause 零 adapter 调用；running 在首字节前/已有 UTF-8 prefix 后 pause；零字节 checkpoint；silent provider 被 observer abort，另一 Task 得到处理；旧 callback 在 pause 后、新 Run 前及 resume 后均无效 |
| 状态/命令 | 同 key pause/resume replay；异 key pause no-op；异 key resume/source CAS 唯一 successor；wrong expected、changed-key payload、跨 scope/path、attempt 整数上限；mandatory audit/checkpoint/event 失败回滚整个子树 |
| 当前 authority | 原用户、group owner/admin、普通成员和直接会话 creator；停止无 model 可用性要求；resume 必须原用户；blocked 后 membership/grant/grantor/Bot/model/capability 改变，拿到锁后拒绝；reinvite 不替换旧 grant |
| 树语义 | terminal 中间节点下的 queued/running 被 pause；更早独立 paused 后代保持 marker/时间；仅父 resume 后代仍 paused；paused/cancelled 祖先阻止 claim/resume/recovery/自动后继；父 pause/cancel 与子 resume 交错 |
| COL-10/11 连接 | resume 新 chain/self root/ordinal1、Task attempt 递增、model ordinal1、原 binding/position、只向后 fallback、notBefore=新 DB 时间；旧排程/usage/chain 不变；自动路径共享总量，receipt replay 不开链；累计预算/并发准入不能绕过；未合并 origin 只测契约，不声称已集成 |
| MEM/source | 同 Task horizon 内 edit/tombstone/purge/revocation 后的 resume 重建；新 manifest 是 current selection，旧 manifest/partial 保留；发送中再次失效时 delta/final 拒绝；旧 partial 不出现在新 prompt、保存 memory 或最终 answer |
| Strict codec/reducer | 所有 status/optional metadata 的合法与非法形态；legacy absence；paused→cancelled 唯一例外保留 finishedAt；旧 paused after resume 的伪事件拒绝/resync；新 Run offset0；duplicate/cursor gap/retention/bootstrap 行为和原 routing summary |
| History/UI | 当前 Run 投影、>一页完整历史、旧 checkpoint/partial detail、distinct pausedAt/cancelledAt；普通表单与 enhance；按钮权限；原暂停片段与新 final 分开展示 |
| 真浏览器不确定响应 | 让真实 route.fetch 已经 commit，再 abort 响应；expire/disconnect 触发 bootstrap；确认原 pause/resume 时 key/expectedRun/operation 保持且数据库只有一个目标 receipt/successor；覆盖 non-enhance 失败重载，MEM pending helper 回归不退化 |

### 12.1 真 PostgreSQL（runtime role）

应用完整实际 predecessor 链及新 migration，通过实际 provisioner/restricted runtime role 运行；pg-mem 与纯 service double 不替代 native。沿用 `apps/api/tests/postgres/task-cancellation-runtime.test.ts`、`tasks-runtime.test.ts`、`conversation-stream-runtime.test.ts` 的真实结构及 root fixture 规则。

必须用可观察锁屏障（例如 `pg_stat_activity`/`pg_blocking_pids`）证明实际发生等待，再断言锁后重验，不能只用 sleep 假称 race：

- 两个 resume：same key 与 different keys；两条 overlapping subtree pause；pause↔claim、delta、final、cancel、resume；父 pause/cancel↔子 resume。
- 已合并时增加 provider continuation/recovery↔pause/resume；两个 writer origin 争用 source，at most one actual successor。lease heartbeat 不能反向锁资源。
- runtime 直接伪造 paused status、missing/mismatched checkpoint、wrong command subtree/counts、stale source/manual_resume receipt、越权 actor、任意 binding/origin/chain ordinal，全部被 guard 拒绝。
- current paused→cancelled 合法一次；逐个尝试同时修改 finishedAt、startedAt、claim、provider、usage、partial、checkpoint、schedule、provenance 均拒绝。新 resume 提交后对旧 paused 的仅 status UPDATE 也拒绝。
- 保存原 paused finishedAt；经过新的 DB 时刻 cancel 后验证 cancelledAt 更晚、finishedAt/checkpoint 不变；同/异 key cancel no-op 返回 marker 的取消时间，不返回暂停结束时间。
- 在每个 mandatory receipt/checkpoint/audit/delivery 写处强制失败，检查 Task/Run/partial/checkpoint/事件/command/预算无半提交。
- 原 0023 升级边界、旧 history、restricted grants、canonical answer uniqueness/late callback fences 均保留。

### 12.2 独立 worker 与实际 Compose

使用实际 API、Web、独立 worker、数据库及可控 provider fixture 进程，不用 fixture API 内同步完成代替 worker 生命周期。至少保留一组升级路径及以下完整轨迹：

1. 暂停尚未 claim 的 queued Task，证明 provider 调用数=0；停启 worker/API 后仍 paused；再手动 resume，仅一新 Run 被调用并完成。
2. 真实流式 provider 输出一个多字节前缀后受控停顿；API pause；观察旧请求中止或旧 invocation 释放、另一 Task 可执行；重启、feed 过期后仍能读取原 durable partial/checkpoint。
3. 同一已暂停 Task commit resume 后丢响应，重复确认，只有一个新 Run/chain/provider 执行；旧 prefix 不出现在新 prompt；新成功只产生一个 final message。
4. 原用户失去模型/会话/grant/来源权限后 resume 拒绝，恢复权限不自动启动；管理员仍能停止；父 paused/cancelled 期间子工作不启动。
5. 若该集成 pin 已包含 COL-10/11，验证排定 fallback pause→resume 保留位置、新 notBefore，及 worker 重启不会把 paused 当需 recovery；未包含则明确待对应组合验证。

端口、browser/Compose 独占和长门由 root 统一调度。测试 fixture 只能用有限显式超时/屏障；不得改生产 duration/byte/attempt 限额制造通过。语法检查、测试 discovery、Native/Compose skip 均不是执行通过证据。

## 13. 实施顺序与交接完成条件

1. COL-07 最终 pin 验收后建立独立 COL-08 工作树；读取实际增量，确认 root、Task 树、partial、取消 UI 的最终接口。与 COL-10 唯一 writer owner 固定 manual_resume 分支、字段、receipt/guard 和迁移顺序；COL-11 消费相同 origin 扩展。
2. 先通过真实 API/worker public seam 写 queued/running pause 的 RED；实现当前暂停、checkpoint、树 fence、observer 和必要数据库约束，立即证明 native 旧 claim 不可写及 paused 取消窄例外。
3. 写 expected Run/丢响应/resume 旧快照不变的 RED；接共享 writer，完成授权、计划与预算准入以及分型 receipt；不得复制 allocator。
4. 接 typed stream/strict BFF/DTO/历史与两种表单路径；用实际响应丢失后重新 bootstrap 的浏览器测试关闭 uncertain-command 问题。
5. 运行针对变化的 focused/types/lint、实际数据库、完整项目门与独立 worker/Compose；产出冻结 source/tree、真实执行证据、两条独立 review 轴。原票及全项目进度仍由 root 在验收后更新。

本设计没有尚待用户选择的语义项。共享 writer 的正式签名、最终 COL-07 pin、真实 migration 编号和新增 guard 的具体落点属于后续作者之间的实现协调，不是给当前票开第二套机制的许可。

## 14. 明确不做

不做 provider-native continuation、旧 token/session 复活、离线执行、自动恢复 paused Task、prompt/partial 拼接、重新 routing、隐式替换 grant/用户/model、重写历史 usage、public execution API、COL-12/13 调度/容量产品、未来未合并 migration 占位或 root 票据/进度改动。本 handoff 只完成只读设计任务，不宣称 COL-08 AC 已实现或任何运行门已通过。
