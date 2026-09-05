# COL-12 — 层级执行限制：只读实施交接

准备日期：2026-09-05。**COL-12 仍为 blocked；本文不实现、不验收六条 AC，不改票据、源码或 migration，不启动任何服务。** Root 已确定本文三项关键语义；其余内容是供后续作者评审的明确实施建议。

## 1. 固定输入与当前事实

| 输入 | 本次读取的固定来源与边界 |
| --- | --- |
| 接受根基线 | `ae41c6a2bc0b624202cd5a4ea506f90779e9e0b2`，tree `347f8a9ff6ba2350cd19afc75f19300b1a122b30`；实际 registry 到 0022，Verify workflow 14 jobs |
| COL-07 候选 | `fc03c7b4d345ca9fc3cf8c59cd53b6c74ea82799`，tree `6282d0c603441ec0126fc24dae2cb949120294bf`；实际 0023、16 jobs；两轴 CLEAN，独立 merger 接手，新 native/Compose 门不能当成已执行 |
| 原票 | 根基线 `.scratch/openbot/issues/29-col-12-enforce-hierarchical-execution-limits.md`；依赖 COL-06、COL-08；后者尚不是此 pin 的实现 |
| 已保存设计 | 根基线 `.scratch/openbot/COL-{08,10,11}-PREIMPLEMENTATION-HANDOFF.md`；读取的是这三份固定版本，不是其引用的旧开发源替代当前实现 |
| 设计版本指纹 | COL-08 SHA256 `0bceb021747e000742bd79e4104113c15ea1b37f66abed0d1a96695a4d7c9d84`；COL-10 `b563c680f8ca22cf0c2496a1bf0ca4233700eebd2748c99a254298e50faa6f5c`；COL-11 `04d5a4b9c48f3044d023cd17516af08abfc9c80ce1966c63942a3809cf59f71a` |

代码路径以下均相对 `/workspace/scratch/2bc98607b3a9/openbot`，Task 事实按 fc03 读取；Bot/scope 设置也与 ae41 核对。

| 实际已有能力 | 实际缺口 |
| --- | --- |
| `apps/api/src/bots/service.ts`：duration 默认 300 秒、turns 8、depth 2；合法范围分别 1..3600、1..100、0..8 | 无 handoff 字段；不向旧 Bot JSON 加字段，不改上述默认值/范围。tokens 字段及现有单 Run 检查保留，本票不扩展 |
| `tasks/service.ts`：submit 原子创建人类 trigger、根 Task、queued Run、routing/audit/delivery；retry 创建连续新 Run 和原 human receipt | 无 starting-policy snapshot、预算计量、soft warning、waiting_budget、grant 或共享 next-attempt writer |
| `tasks/queue.ts`：claim 完成当前身份/model/MEM 准入后，按 Bot duration 创建不可变 deadline；delta/final 重验当前 claim、来源、deadline | 现时钟来自注入的应用 Date；没有累计 duration、turn/depth/handoff enforcement，没有动态 scope policy |
| `tasks/worker.ts`：实际 AbortSignal、单个串行 1 秒 observer、deadline timer、迟到 callback fence；网络在 claim 事务后开始 | 无 durable heartbeat/lease/recovery；COL-11 的 15 秒 lease 是已定设计，不是当前实现 |
| `tasks/tree.ts`、`cancellation-{schema,postgres}.ts`：immutable root/parent/depth，根后有序 Task/Run 锁，子树取消、当前 Run 同态与 terminal guards | 现 ancestry 只禁止 cancelled；生产 submit 仅创建根。子 Task fixture 不是 COL-14 delegate producer；无 COL-16 Lead transfer |
| `partial-output.ts`、`conversations/append-event.ts`：delta/progress/完整 partial 同 TX；32,000 UTF-16 units、128,000 UTF-8 bytes；仅 canonical completion 删除同 Run partial | 当前 private reader 只接受 cancelled；failed timeout 的已提交 partial 可保留但尚不能通过该 reader 读取；需明确扩展 |
| `infra/postgres/grant-runtime-privileges.mjs`：精确列权限，audit 仅 INSERT；0022/0023 要求合法 receipt、current Run、固定 claim/provider | 新 control state、policy/counter/receipt 必须有真实 SQL guards；不能靠应用 if 或删除旧约束实现 |

## 2. 原六条 AC 原文及映射

- [ ] Workspace, Group, Task, and Run policies resolve to the strictest effective limit per dimension.
- [ ] Each Task stores an immutable snapshot of its starting limits and their sources.
- [ ] Crossing a soft threshold appends a visible warning event.
- [ ] Reaching a hard limit starts no further Run and moves the Task to waiting_budget.
- [ ] An authorized idempotent grant changes only the selected limit and resumes without rewriting usage.
- [ ] A Run timeout aborts its provider stream and preserves partial output and audit evidence.

| AC | 实施落点 | 验收要点 |
| --- | --- | --- |
| 1 | 版本化 scope policy、Task allowance、Run admission snapshot、祖先余额检查 | 四维分别取严；缺 Group 的 direct 路径；多来源并列；当前 cap 缩小；并发 live 用量不能超额准入 |
| 2 | Task 建立时同 TX 存 immutable starting limits 与全部来源 | Bot/scope 后续变更、grant、retry/resume 不改原 snapshot；初始事务失败不留半份 policy |
| 3 | durable budget event + typed conversation delivery + Task timeline | 80% 边界、重启/并发/丢响应不重复；feed 过期后仍可读 warning |
| 4 | 唯一 writer/claim/发布 fence + exact budget stop/wait receipt | 耗尽后无新 Run/调用；有效最后一个 turn 可结束；真正需要下一步且不足时 waiting；无伪造空 Run |
| 5 | selected-dimension grant receipt + typed manual_resume | 同 key 同结果、异 payload 冲突；只改所选 allowance；仍有别维阻塞则留 waiting；旧 usage/Run 不变 |
| 6 | DB-clock deadline、独立 observer、timeout terminal evidence、scoped partial reader | 静默 HTTP 与已输出两种 abort；保留 prefix/审计；旧写入和最终答案均被 fence |

用户故事：
1. As an execution human, I want the strictest limits and their sources visible, so I can understand what constrains my Task.
2. As a workspace or group administrator, I want my current scope cap enforced, so a Task grant cannot bypass it.
3. As a conversation reader, I want a durable warning before work stops, so I can see why progress changed.
4. As the original execution human, I want to grant one dimension and confirm an uncertain request, so work resumes once without losing its history.
5. As a reader of interrupted work, I want saved partial output and timeout evidence, so interruption is distinguishable from a completed answer.
6. As an operator, I want waiting work to remain stopped after restart, so recovery or another worker cannot spend exhausted budget.

## 3. Root 已确定的计量与默认策略

| 维度 | 唯一单位、计费点与边界 |
| --- | --- |
| duration | 整数 active-Run 毫秒。起点为**锁等待后 DB clock 写入的持久 startedAt**，不是无法预知的 COMMIT 时间；终点为真实 terminal 时间或已失效 lease 边界。全部 attempts、所有后代 Run 累计；并行两个 Run 各执行 1 秒计 2,000ms |
| turns | 每个成功提交的新 Run 消耗 1，包含 first/manual/automatic/resume/recovery、queued 后取消或准入失败的 Run；事务回滚和 receipt replay 消耗 0；永不退款。SSE chunk、usage event、HTTP 重连不是 turn |
| depth | 根为 0 的 parent 边数；检查拟创建 child 的 depth，已存在合法节点到达 cap 仍可执行自身。root subtree 记录最大已达 depth，不能因 child 结束而归零 |
| handoffs | 真实已提交的同 Task Lead transfer 消耗 1，向每个 Task 祖先累计；重放/失败事务不计。此 pin 无 producer，实际用量为 0 |

queued（包括 future notBefore/backoff）、paused、waiting_budget 不计 duration；running 内 provider 等待、流、工具等待或被标 running 的父工作都计，不能靠客户端“空闲”标记免责。未来等待 child 若要不计时，必须由真实 producer 将父 Run 转入可证明的非 running 状态。

Workspace/Group 是**每个 root 树的 cap 模板**，不是多个无关 Task 之间共享的每日配额。每个 Task 另有覆盖其子树、跨全部 chain 的 lifetime ledger；一个 Run 在每个祖先各计一次，计算 root 总量时不再把 child 的已聚合 ledger 重复相加。

新 versioned execution policy：handoff 默认 **2**、范围 **0..8**，来源记 `policy_default_v1`，绝不伪称旧 Bot 有该字段。duration/turn/depth 起始提案来自 pinned Bot 的 300/8/2（或其已保存值）。建议 system/Workspace 缺省 cap 为现有范围上界 3600s/100/8，handoff 8；Group 缺省 inherit；缺省 Run 无额外收紧。新 scope 值保持这些整数范围，不引入 duration/turn=0 的隐含禁用状态。

Bot 的这些值是 Task **起始提案**；明确的人类 grant 可在上级 cap/系统上界内提高同一维度的后续 allowance。旧 Bot version、starting snapshot、旧 Run deadline 都不改变。每个新 Run 按新准入结果固定自己的 policy/deadline；已有 Run 不能被 grant 延长。

## 4. 解析、snapshot 与当前 cap 收紧

1. 保存 scope policy 为 append-only revisions；版本写权限沿现有 Workspace `owner/administrator`、Group `owner/admin` 的当前 manage 规则。普通成员不能通过 Task 表单修改 scope cap。
2. 每维解析 `min(system ceiling, current Workspace cap, current Group cap if any, approved Task allowance, explicit Run cap if any)`；再分别检查每个祖先实际余额，不用一个静态 min 代替累计账。显式 Run cap只能收紧，默认 inherit 不是一个永远钉在旧数值上的额外 cap。
3. Task snapshot 同时存 schema/version、单位、初始提案、所有来源的 scope/ID/revision/值、最终每维值及所有并列最严来源；不存在的层记 inherit，不伪造 Group。child 本地 depth allowance 转为 `child.depth + localDepth` 的绝对上界，再与全部祖先的绝对 depth 上界取严。
4. Root/parent/Task starting snapshot 和每个 Run admission snapshot 不可变。单维 grant 追加 overlay，不覆写 snapshot；新 Run 引用所用 overlay/revisions。Run 的 turn/depth/handoff cap约束其所在 Task 子树的相应拟行动；祖先 ledger 独立再验，不能把 root 的累计用量错误当成 child 本地用量。
5. 当前 scope 降低 cap 后，下一次 claim/新 Run/发布/observer 使用新值；不追改历史 allowance、usage 或成功状态。若已用超过新 cap，remaining=0，另显示实际 excess，不把 usage 截成 cap。影响到的活跃工作进入有来源的 budget wait。
6. scope cap 提高不扩大旧 Task 的 approved allowance，也不自动唤醒 waiting；重新有余额仍需明确 human resume。Task grant不能越 Workspace/Group cap、显式 Run 上限或祖先 allowance；祖先不足须针对该祖先另行授权，child 表单不能顺手改它。
7. 手工 retry/resume 新开 COL-10 chain，但上述 lifetime 用量、max depth、handoff 数不清零。chain ceiling/per-model/recovery cap 是额外限制，本票 grant 不提高它们。

## 5. live duration 与硬准入

- 时间取锁后数据库时钟；按每 Run 的累计 `(effectiveEnd - startedAt)` 向下取整到毫秒，再减去其已结算累计值，避免每次 heartbeat 独立舍入丢失时间。已终止 ledger 不改写，结算与 grant 分离。
- 硬准入必须同时读取持久已结算量和**所有尚未 terminal 的 live 差额**。在同 root、全部相关 Task/Run/lease 锁下取得统一 DB now 后重算，再创建 Run/claim；不能只看上次 observer 的缓存 counter。
- 对一条新 claim，immutable deadline 不晚于该 Run duration cap及每个祖先当时剩余 duration；既有并行工作使余额变化，故这个初始 deadline 不能替代动态 live fence。未来 fan-out 必须消费同一检查。
- 每次 delta/partial/final/后继分配以及 mandatory audit/feed 等等待之后，重验实际 live 总量、当前 scope caps、latest/token/ancestry/lease/deadline。超额时整笔输出尝试回滚，再提交独立合法 stop；不先发 final 再补 waiting。
- duration 达到 cap 后，独立 observer 即使 provider 无 callback 也能发现并 abort；与 COL-11 的单个串行 1 秒 loop协调，不另建重叠 timer。正常 DB 下按该 cadence 观察，不承诺网络 abort 零延迟或 DB 故障时固定 SLA。
- 实际 terminal/lease 边界可能令已计 duration 超过 cap；忠实保留该事实/安全 overrun 证据，不退款或抹平。硬保证是没有超预算的新准入和可见发布；实际物理请求中止仍有观察与网络延迟。
- turn 检查拟新增后的计数 `<= cap`；最后一个已计费 Run仍可完成，不因 used=cap 立即取消它。下一 Run/action 需要而不足才 waiting；正常最终成功仍 completed。depth/handoff=0 只禁止对应新行动，不阻止普通根 Run 或立即制造 warning。

## 6. waiting_budget、timeout 与 terminal immutability

| 输入状态/事件 | 必须提交的结果 |
| --- | --- |
| queued/running 因累计预算或当前 cap 被停止 | source Run → frozen `waiting_budget`，Task 同态；持久 stop/checkpoint，保留原完整 claim/provider tuple（queued NULL 也保留）、已有 usage、partial；无新 Run |
| 已 failed/paused 的 current source，其后继因预算不足未创建 | 旧 Run 零 UPDATE；Task → waiting_budget，唯一 active wait receipt 精确指向该 current source。只允许这个有类型证明的 Task/Run 非相等关系 |
| Run 自身 immutable deadline 到期 | 保留 COL-10/11 的 `failed/execution_timeout` 终止事实，不作 transient retry/fallback；Task 可由同事务 exact timeout wait receipt 进入 waiting_budget，旧 failed Run随即冻结；没有伪装的自动 recovery |
| 所选 Task waiting；一维 grant 后仍有其他阻塞 | 追加 grant/稳定 receipt，仍 waiting，无新 Run/chain/provider；响应明确列出剩余限制来源 |
| waiting 的全部准入满足，明确 human resume | 唯一 writer创建新 queued Run，Task queued；旧 waiting/failed/paused source 不 UPDATE；旧 checkpoint/partial/usage/结束时间保持 |
| complete/cancelled 或更旧历史 Run | 永不作为恢复源；cap控制记录不会重启终态 Task。严格 paused/cancelled/waiting 祖先阻止后代执行；停止操作仍可取结构锁 |

`budget_wait_receipt` 至少固化 owner Task、所选 Task/current source Run、blocking dimensions/来源与计量快照、DB stop time、checkpoint/strategy，以及**待恢复的完整 binding/modelPosition**。它可以是已计划 fallback；不得根据后来 Bot/live graph 回 primary。没有这种 typed receipt 的 failed 仍只能走正常 COL-09 manual_retry。

预算 owner 耗尽会停止其全部 unfinished descendants，穿过终态中间节点；terminal Task/Run不回退。每个实际被停止的 current Run有自己的证据，ancestor来源指向同一控制决定。提高 ancestor allowance 不批量 resume 子树；只对明确选择的 waiting Task执行恢复。

对 `waiting_budget` 的 cancel沿 COL-08已定的“当前冻结 source”窄规则：无 successor时可仅将该 waiting Run status→cancelled，结束时间/claim/provider/usage/checkpoint/partial全不变，取消时间在独立 marker。若 Task waiting而 source已failed/paused，cancel只终止Task控制态并保留该历史Run，必须有分型 cancellation control receipt；不把失败改成取消。所有其他 terminal rewrite继续拒绝。

## 7. grant、权限与唯一 next-attempt writer

- 推荐私有 `POST .../tasks/:taskId/budget-grants`；严格 body为 idempotencyKey、expectedRunId、expectedWaitId、dimension、newTotal。newTotal是该维度的**绝对新额度**，不是可重复相加的增量；duration以整数秒传输（1..3600）并精确转为毫秒计量，其余维度使用上表整数单位；普通新grant必须高于已批准值且不高于上级cap/系统范围。其他维度键、actor、provider、usage输入一律拒绝。
- 唯一键 `(taskId, actorUserId, idempotencyKey)`；对全部命令字段做精确一致性检查。receipt固定before/after额度、wait/source、是否创建successor及其ID；同key重放返回原结果+当前Task，不能后来“补执行”旧的granted-but-still-waiting receipt。
- 只有原execution human且当前conversation inspect/execute、workspace/group membership、原exact grant及grantor、Bot lifecycle、固定版本、所选model/capability/credentials都成立，才可grant-and-resume。管理员能管理本scope cap但不能借管理员provider权启动别人的Task；Bot/worker不能grant。
- 若别维仍不足可成功提交本维grant但不启动；后续另一维grant或明确resume再次准入。若current scope cap已恢复而无需提高额度，可走有typed budget receipt证明的明确resume，不伪造no-op grant。ancestor cap的授权记录独立，不能复用child命令越级。
- 恢复沿 COL-08 `restart_from_task_input_v1`：原Task/trigger horizon/current revisions/tombstones/MEM source重新准入，新Run offset0，旧partial不进prompt。仅恢复所选Task，不自动恢复child。
- 消费 COL-10 owner 的 `tasks/next-attempt.ts`（**本基线不存在，须取正式冻结接口**）和caller-owned TX；`manual_resume` 新chain/self root/ordinal1、全局attempt+1，保持 wait receipt 的modelPosition/完整binding，只向后fallback；notBefore=锁后DB now。
- 扩展manual_resume的source谓词为合法paused checkpoint，或精确budget-wait checkpoint/receipt；不能放开任意failed。其余provider retry/fallback/recovery仍共享既有chain预算与唯一source→successor约束，各有分型origin/receipt；不能伪造human retry命令。
- grant/resume的权限/Run CAS不满足时整笔回滚；已成功commit后丢响应为unknown outcome，保留原key/expectedRun/wait/dimension/newTotal。UI普通form与enhance都能确认原命令；401才清session，403保留，409要求refresh，SSE resync不能换key。

## 8. 数据、锁与实际 guard 扩展

新增窄记录建议：scope policy revisions；Task starting snapshot/单维grant；Run admission snapshot；monotonic execution ledger；immutable warning/stop/wait/resume receipts。effective/live读模型可重建；原provider input/output tokens与这些执行单位分开，不建COL-17式token reservation。

锁序保持实际资源→root→全部所需Tasks→全部current Runs→budget/checkpoint/provenance/lease→provider；MEM新增source scopes按最终接受代码排序。scope编辑使用相同Workspace/Group资源锁。不能从持有Run的窄heartbeat里反向取root/Task锁：预算settlement需先取完整顺序，或先结束heartbeat TX再串行调用预算事务，仍由单observer编排。

必须在下一实际migration扩展：`protect_task`、`protect_task_run`、`require_current_task_run`、origin/receipt/deferred完整性、`lock_task_ancestry`、cancel subtree guard、partial/publication fence、status/nullability CHECK与typed delivery receipt。保留普通Task/currentRun相等；仅通过精确active wait/cancel control receipt开放上节列出的关系，new successor仍须同TX把Task切回queued。

原waiting source在其恢复后成为immutable历史；不得再次cancel/改变plan/finishedAt。预算snapshot/grant/usage来源/事件禁止UPDATE/DELETE；计量表仅有受校验的单调累计更新，不接受runtime伪造消费/退款/归零。新guard同时校验exact actor/scope/source/currentRun/计量/必需audit+delivery，不能授予通用bypass。

warning建议为80%整数阈值 `ceil(4*hard/5)`，每个owner/dimension/effective-limit revision只追加一次；零额度无无意义warning。记录全部最严来源与安全used/remaining；改变cap后重新比较，能同时出现warning和hard-stop，但各自只一次。独立durable Task budget timeline保留事件，SSE用既有单conversation allocator/receipt同TX发送，不伪造Bot最终消息。

## 9. timeout/partial 与只读界面

- 完整已提交partial仍由delta/progress同TX保存，停止时只冻结；不从过期SSE或内存未提交callback猜prefix。queued零输出为null，不造空body行。保留32k UTF-16/128k UTF-8及当前COL-07的503后台恢复修正。
- 私有partial reader显式增加waiting、合法历史paused及`failed/execution_timeout`（COL-11另加worker_interrupted），始终exact scope+当前inspect。task列表/SSE不塞全partial；正文单独安全GET，显示Interrupted、真实timeout/预算来源，不能冒充canonical answer或供human edit/delete。
- known usage照实际已有事实保留，null仍unknown；grant/retry不重算旧provider usage。timeout/stop在当前Run锁下与mandatory audit、safe budget evidence、checkpoint和typed状态同TX；任何写失败全部回滚。过期claim的后续usage/final/partial均不得补写。
- safe Task/Run/BFF/Web strict union须分辨Task控制waiting与source状态；current投影、全部attempt分页、旧Run partial、receipt source/successor都保留。不得通过放宽为任意status/string/object解决旧JSON兼容。
- COL-11 liveness失效、hard deadline、budget exhaustion、用户pause/cancel分别有原因；预算等待不被reaper视作crash，lease不续活，grant不直接续旧lease。实际Run deadline到期优先执行timeout事实，不用新增recovery绕预算。

## 10. 可验证边界、TDD与发布门

| 依赖/producer | 本票可以验证 | 必须等待真实实现 |
| --- | --- | --- |
| COL-08 | 冻结checkpoint/partial、grant的typed manual_resume契约与新Run不改旧史 | 实施前需要实际pause/resume/schema；原票继续blocked，不能拿这份设计代替 |
| COL-10/11 | 统一budget admission接口、origin保留、已耗用chain不刷新 | 集成各自真正next-attempt writer/lease后跑交叉竞态；不自行写第二allocator或宣称recovery已存在 |
| COL-14 | depth与祖先ledger的纯规则、现有合法结构fixture的native边界、多active Run累计 | schema-valid delegate、目标Bot准入、child返回后Lead successor；现fixture每child有独立合法human trigger/hash/grant/首Run/receipt，禁止绕guard假装delegate |
| COL-16 | 四层handoff cap解析、selected-dimension grant、缺少真实transfer来源时不能增counter | 实际source/target/reason公开事件、Lead转移/late-final fence及其原子计费；不造placeholder transfer表/假receipt来证明成功 |

按公共入口逐片RED→GREEN：
1. **policy/snapshot**：四维不同最严层、并列来源、direct/inherit、Bot defaults/ranges不变、scope降低/提高、明确grant overlay；原snapshot字节/来源不变。独立预期边界，避免仅测试实现镜像。
2. **计量/新Run**：queued消耗turn但无duration；所有manual/automatic origin、取消无退款；两个并行child 1秒=2秒、父仍running也计；paused/backoff无耗时；live未settled值阻止另一次claim；时间累计不因多次观察舍入或重启归零。
3. **stop/receipt**：duration到期、最后合法turn完成、再申请被阻止；current active→waiting及failed/paused source窄例外；terminal/claim/provider/usage不改；祖先耗尽原子停止unfinished；完成历史/不相关root不变。
4. **grant/authority**：原human vs group/workspace管理员/普通人/Bot；撤权/重新邀请旧grant；双维耗尽先grant一维仍waiting；同key丢响应/异payload/异keyCAS；等待期间scope变严、planned fallback保留、唯一successor/新chain且lifetime用量不重写。
5. **实际PostgreSQL**：真实migration+restricted role，观察`pg_blocking_pids`后测试claim↔scope减小、并行最后turn、grant↔grant、grant↔cancel/pause/recovery、delta/final↔timeout、ancestor↔child；直接伪造cap/receipt/counter/terminal或missing mandatory audit/feed全拒绝并全snapshot rollback。
6. **独立worker/HTTP/Compose**：silent provider与多字节prefix两种timeout；DB动态live fence后真实socket abort、迟到provider结果无输出；重启仍waiting，另一无关Task能运行；真实grant丢响应后只一个新attempt。若有真实COL-11，另证expired lease计时边界与预算等待零recovery。
7. **Web/SSE**：warning可见、feed过期后timeline/partial仍可读、current/history超过一页、无human mutation控件、unknown命令字段不换、403不清cookie、partial503不阻塞其他Run；实际BFF/worker场景与原Task/MEM/stream/retry/cancel回归。

## 11. 迁移与交接条件

实施前由root提供接受的COL-07合并及实际COL-08/共享writer接口，重新核对真实registry和runtime grants；本文不分配migration编号，不改0017/0019/0022/0023或创建前驱placeholder。ae41的14 jobs和fc03的2新增门都保留；新增exact迁移/列权限断言反映最终实际链。

升级沿用停止新claim、停止/排空旧workers、原子拒绝不安全running状态。已有终态Run/Task不改。legacy turns可由保留Run计数、depth由真实树、duration由可证明started/finished事实保守导入；缺失/矛盾不得假造零用量。旧scope策略不存在时显式记录`legacy_import_v1`及upgrade捕获时间，不宣称还原了Task启动时未保存的政策；不回填虚构handoff，已存在的历史snapshot永不改。不能无损证明的可恢复旧Task须明确阻塞并由root定义一次兼容迁移，而非开新chain清账。

后续作者提交冻结source/tree、原始RED及准确GREEN/skip证据；独立Standards+Spec、专用merger及实际native/Compose是完成门。此准备任务没有运行测试，亦未使用COL-07已有成功门替代COL-12证明。

范围外：token/cost预算、slot/concurrency调度、真实delegate/handoff动作、provider-native续流、旧partial作为prompt、自动恢复waiting、Bot自行加额度、跨group子树、public API新端点、root票据/进度修改。已保存COL-08对`manual_resume`开新chain的明确决定覆盖COL-10/11旧文档中“仅initial/manual_retry开链”的历史表述。
