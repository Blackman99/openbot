# TPL-01 — 安全单 Bot 模板预实现交接

2026-09-05。只读调查与实施契约；未修改源码、原票、迁移或 CI，未启动服务、运行测试或发布。TPL-01 仍被 MEM-02 阻塞，不构成任何票的验收。仓库为 `/workspace/scratch/2bc98607b3a9/openbot`；下列源码路径均相对此仓库。

## 固定输入与依赖状态

| 输入 | 本次读取的固定对象 | 含义 |
| --- | --- | --- |
| 原票 46、47；实际 Bot/provider/Web | `ae41c6a2bc0b624202cd5a4ea506f90779e9e0b2`，tree `347f8a9ff6ba2350cd19afc75f19300b1a122b30` | 原 TPL-01 六 AC 与 BOT-03/BOT-04/MEM-02/PROV-05 依赖不变；TPL-02 团队导入不提前实现 |
| COL-10 配置增量 | source `23f55355fe74b70f7eba5a128cc576bdb7407c25`，tree `4212d6310a99ea8ed6392a09a62079de44c7f975`；证据 `cd2d5129d7ca50f8c006e1d0607f1ddd46c689e8` | 配置 slice 已独立双轴审查；不是完整 COL-10/自动执行验收，当前不修改该 slice |
| MEM-02 契约 | 上述 ae41 中 `.scratch/openbot/MEM-02-PREIMPLEMENTATION-HANDOFF.md` 与原票 38 | 私有记忆是独立批准的 source-reference；不进入 Bot configuration/copy/template |
| MEM-02 已存在切片 | domain `a948b5de291d1a5c9fce17102af8327a827ce4fd`；clock/client `734da6e325883ae9804e2f4cbfa6b684884467e6`；cleanup `6198b96da1a3575675183fda5ceac803a1c67158`；pending `7d45775a72cac359634f4d935d64f24084f654ba` | 已审域/路由/客户端/纯 helper 不是完整 SQL、Run、页面或 native 验收；不以其类型声明冒充已部署私有读取 |
| Root 本轮明确决定 | 2026-09-05 交接消息 | 真正实施 TPL-01 时新增 immutable optional `requiredCapabilities`，不提前改 COL-10；原 execution workload 不能被模板声明降级 |

Root 正另行整合/发布已验证 COL-07。正式开工必须重新固定当时实际已接受的母树、MEM-02 完整源及 COL-10 配置接合；不可拿旧 ae41 或占位 DDL 冒充这些依赖。COL-10 owner `/root/bot_copy_lifecycle_spec/api02_native` 已确认未来 capability seam。

## 原六条 AC 的实施映射

| 原 AC | 必须完成的可观察行为 |
| --- | --- |
| 1. Versioned JSON contains identity, full instructions, capability requirements, collaboration policy, default budgets | 固定 v1 allowlist；完整指令、全部已声明能力、depth/预算及已保存 retry/fallback 顺序可导出、预览、导入后再导出 |
| 2. No API key, secret header, connection ID, history, private memory, attachment body or stored object reference | 从已授权版本逐字段构造新文档；不序列化 configuration/provider/memory/object 整个记录，逐项验证排除 |
| 3. Reject unsupported versions, unknown sensitive fields, malformed values and unmet capabilities with field errors | API 与 BFF 独立有界解析；嵌套未知键也拒绝；每个合法字段的错误定位；不兼容绑定阻止提交 |
| 4. Before creation show complete instructions, capabilities, permissions, budgets and differences from selected local Bot | 原始行为原文、目标权限结果、完整原始/最终模型计划及授权 local diff 可审阅；没有默认勾选的确认 |
| 5. Disabled until explicit compatible connection/model binding | 主模型及每个保留 fallback 都明确映射；当前 enabled/exact model/all required capabilities 同事务复验 |
| 6. Independent Bot, no mutable reference/read path to exported Bot/source Workspace | 新 stable ID、version 1、private、导入者 sole owner；不导入 source ID/ACL/grant/memory/objects，也不后台访问来源 |

原非目标保持：不检测任意用户 prompt 原文内的秘密，不导出私有记忆，不做 marketplace、远程 URL 导入或 live sync。导出完整指令不等于执行文件中的指令。

## 真实现状与复用边界

- `bots/service.ts` 当前身份/指令/limits/modelBinding 才是配置事实；COL-10 加 optional retryPolicy/fallbackBindings。当前没有 Bot 的声明能力、通用工具权限、Lead/delegate policy、模板 producer 或模板幂等 receipt。
- `providers/capability-policy.ts`、`fallback-policy.ts` 已有 Basic=text AND streaming；Collaboration=Basic AND (toolCalling OR structuredOutput)；visionInput 也须先满足 Basic。unknown 不算满足；不能把整张当前能力表变成模板要求。
- `bots/postgres-bot-access.ts` 当前 workspace + direct Bot inspect 允许 owner/editor/user；workspace admin/discovery/group grant 不赠送配置检查权。导出/对比用 inspect；新增 Bot 用目标 workspace 当前 membership。
- `bots/postgres-bot-repository.ts:create` 自己开启事务，原 create/copy 没有 import 幂等；不可在新 import 事务内调用它并声称原子。提取 caller-owned connection 的共享新 Bot writer，保留原 create 的事务外壳。
- `bots/schema.ts` 有 version immutability、同 Bot current pointer；`configuration-view.ts` 是响应 allowlist，`version-data.ts` 有完整配置变更及闭合比较字段；`append-version.ts` 处理 CAS/restore。新字段须覆盖这些真实路径及 strict Web/OpenAPI。
- `bots/copy-service.ts` 允许同权限头像引用复制，但模板必须排除它；不得直接拿 copy preview 当 export。MEM-02 的私有 identity/approval/lineage 和 selector 独立，不给新 Bot 任何引用。

## 推荐 v1 JSON 契约

这是本票要实现的格式，不是当前导出。顶层和每层 object 均 `additionalProperties:false`，不提供透传 `metadata`/extensions。

```ts
type BotTemplateV1 = {
  format: 'openbot.bot-template'; schemaVersion: 1;
  identity: { name: string; roleDescription: string; description: string };
  instructions: string;
  requiredCapabilities: Array<'basic' | 'collaboration' | 'visionInput'>;
  collaborationPolicy: { maxDelegationDepth: number };
  defaultBudgets: { maxTotalTokens: number; maxDurationSeconds: number; maxTurns: number };
  modelPlan: { primary: { modelId: string }; fallbacks?: Array<{ modelId: string }> };
  retryPolicy?: { maxAttemptsPerModel: number; maxRunsPerChain: number };
};
```

- identity 复用 100/200/2000 字符边界与既有规范化；预览明确展示实际存储值。instructions 非空、最多 32000 个 UTF-16 单元，逐字符保留空白、换行、Unicode；超界拒绝，禁止裁剪、总结或 prompt 改写。拒绝不能合法保存的 NUL/孤立 surrogate 并定位字段。
- capability 数组为闭合 set，含 basic、无重复、最多 3 项，规范次序 basic/collaboration/visionInput。v1 不接受任意工具名、URL、shell、file/knowledge 权限声明。
- collaborationPolicy 只映射实际 `limits.maxDelegationDepth` 0..8；defaultBudgets 精确保留 tokens 1..1000000、seconds 1..3600、turns 1..100。整数不 coercion/夹逼；不因导出/导入重设默认值。
- retryPolicy 保留 absence；存在则两字段都必填，attempts/model 1..3、chain 1..4，均含第一次。未来自动执行仍受实际 COL-10/12 实现约束；保存它不启用 worker。
- modelId 非空、最长 256，仅作原模型意图提示，不是可执行绑定；不从 provider 取 protocol/endpoint 作为不存在于配置的 producer。fallbacks 保留 absence 与 `[]` 差别、0..3 长度及顺序；同 modelId 的不同位置不可合并。非空 fallback 必须有 retryPolicy。
- 文档没有 source Bot/Workspace/version/user ID、scope、connectionId、avatarObjectId、object key、memory/approval/lineage、history、ACL/grant、凭据、header、endpoint 或嵌入附件。不得用可解析 source URL/自定义字段补回它们。
- 已知被排除字段与行为字段分开处理：avatar 等明确排除并披露；若未来真实配置出现 v1 不能表示的行为 policy，拒绝导出该 schema，不能默默遗失它。

## Root 已批准的新 capability producer

TPL-01 实施时为 BotVersion configuration 新增 optional `requiredCapabilities`，旧版本缺省不回填。更新真实 create/edit/restore/copy、版本 view/diff、Web parsers/forms、public OpenAPI 与回归；不借一个模板旁表伪装配置已保存。

旧 Bot 导出默认明确声明实际 Basic 下限；不能从 depth、指令文字、绑定模型能做什么推断额外要求。已有声明原样保留，出口表单只能明确增加声明；如需降低，先走显式 Bot 配置版本编辑，不能静默导出更弱要求。出口增加要求只改变此次模板，不改源版本。

导入将模板完整声明写入新版本。新的/明确改变能力或任一模型计划字段、所有 restore/copy 都同事务验证最终计划每个模型的全部声明；无关 metadata/avatar 编辑保留原声明而不要求未变模型当前可用。absence 与显式 Basic 在历史/diff 中可区分。

扩展 `providers/postgres-model-admission.ts` 的窄 admission，复用有效 generation/probe/manual override 与现有 scope 锁，不另写简化 boolean 判定。实际 Task/Run 的要求为 pinned 声明与 server-derived workload 的并集；创建检查不能替代 claim/delta/final 当前检查，也不能用 basic 模板绕过实际 Collaboration workload。没有实际 vision 输入/工具 producer 时不虚构执行能力。

## 导出、导入预览与显式替换

1. 推荐 session-only 内部路由：`POST /api/v1/workspaces/:w/bots/:b/versions/:v/template`；只接受额外能力声明。当前 inspect + same-Bot retained version，允许 archived、拒绝 deleted；导出所选确切版本，禁止悄悄换 current version。无需 source provider 仍可用，也不读取凭据/private memory。
2. 输出 canonical UTF-8 JSON，`application/json`、`private,no-store`、`nosniff`，固定安全文件名 `openbot-bot-template-v1.json`；source 版本/precondition 不写入下载文件。导出不创建 Bot 或调用模型。
3. 推荐新 `POST /api/v1/workspaces/:w/bot-template-previews`：接收原始 JSON 文本、可选本地对比 ID/expected version、显式目标 bindings/fallback 决定。服务器解析、授权、算 diff 和当前能力；无绑定时仍可审阅合法文档，但 `ready:false`、无可确认 preview ID，不创建 Bot。
4. 原始 JSON 内重复键、错误 schema、嵌套未知键、wrong type/范围均拒绝，不通过先 `JSON.parse` 丢重复键再称严格验证。返回稳定 JSON-pointer/安全 code；所有已知字段同时检查，未知键用父路径及序号定位，不把恶意键名/字段值反射进错误或日志。最多 64 错误，超出明确标记。
5. 合法文档完整显示原 instructions、声明能力、全部 budgets/depth/retry、原主模型提示/每个 fallback，另列实际最终 bindings 及更改。不能只展示摘要，也不能经 LLM 分析、执行模板、渲染其 HTML/Markdown 或加载其 URL。
6. “权限”展示真实新建结果：private、导入者 sole owner、没有额外 ACL/group grant/源数据访问；depth/模型能力不等于授予工具或私有内容权限。只显示实际已有权限字段，不编造 tool/Lead/delegate producer。
7. 本地对比仅选择目标 workspace 内当前 inspect 可读 Bot/version；用相同安全 export projection 对比每个行为字段、absence、完整指令前后、fallback 数量/顺序。隐藏对象/avatar/memory 不进入 diff；binding 提示与本次真实映射分别标示。
8. 主 binding 必须主动选 `{scope,connectionId,modelId}`；每个保留 fallback 按位置明确选替代绑定，全部 same exact scope、canonical connection IDs distinct 且不等于主连接。不能按 modelId 同名自动匹配，不能读取 provider mutable fallback graph。
9. 默认保留所有 fallback 位置并保持 unresolved；只有明确“移除全部备用模型”才变为 `[]`，展示完整行为差异并重新确认。v1 不提供隐式删单项/重排；若需变更，先明确编辑模板、重新完整预览。主绑定改变时保留选择并标错，不静默清掉备用项。
10. ready 预览将 canonical 文档、最终映射/显式移除、actor/workspace、比较版本、hash 固定为服务器短期 draft，建议 15 分钟，返回完整不可变 review。`GET /api/v1/workspaces/:w/bot-template-previews/:previewId` 按当前权限返回原 review/原 expiry，或该 preview 已提交的稳定 receipt；未提交且过期为明确 409，不刷新 TTL。草稿正文仅服务端短期保存；过期/消费后清理正文，但保留必要命令/receipt 索引，不能因此失去未知结果恢复能力。

## 确认事务、CAS 与未知结果

- 推荐新 `POST /api/v1/workspaces/:w/bot-template-imports`，只接受 `{previewId,idempotencyKey,acknowledgeReviewedBehavior:true}`。预览加载、选模型、比较和 GET 均不创建 Bot；确认不能默认勾选，初次无 JS 表单也须完整可用。
- 同连接锁目标 workspace；如选择本地比较 Bot，按既有顺序锁其 Bot 并复验 inspect/expected current version；随后取得目标模型 scope 锁并重验当前 actor 的每个完整 binding、全部声明。比较仅审阅 CAS，不是导入后依赖；外部源 Workspace 不参与导入事务。
- draft 的 actor/workspace/hash/映射不能替换；首次确认检查原 expiry，锁等待与 mandatory audit 后以该连接 `clock_timestamp()` 重新检验，超期完整回滚。规范 hash 包括 schema/完整指令/所有行为字段/声明/有序映射/移除决定/比较 precondition，排除 key。
- 新 receipt 唯一域 `(targetWorkspaceId,actorUserId,idempotencyKey)`，同 key 不同 intent 为 409；一个 preview 至多创建一个 Bot，换 key 消费已用 preview 也 409。唯一约束和事务处理并发，不靠内存 map。
- 共享 caller-owned writer 原子创建新 Bot、immutable version 1、current pointer、sole-owner ACL、receipt、mandatory creation/import audit；任一写入或最终 admission 失败全回滚。receipt/audit 仅自身 ID、schema、hash、actor/time 等安全元数据，不含模板正文、凭据或源标识。
- 首次 201 返回新 Bot 与稳定 import receipt；同已提交命令 200 返回原 receipt，不能用后来 current Bot/version 替换创建结果。先检查当前目标 workspace/已创建 Bot inspect；已提交 replay 不重新创建、不重新消耗 draft TTL/比较 CAS，也不为读取 receipt 再要求 provider 可用。ACL 撤销后安全拒绝，保留原记录。
- 提交前持久化最小 pending `{actor,workspace,previewId,key,intentHash,acknowledgement}`；不把 template/raw instructions/diff 存 URL、sessionStorage 或日志。timeout、abort、503、commit 后丢响应、reload 保留原命令；只允许“确认原命令”，禁止自动重发、新 key、新 preview 或读取最新绑定覆盖原选择。
- 原 draft/receipt 的授权恢复路由配合 pending helper；已知未提交且过期/版本冲突才允许明确重新预览。确认成功或明确放弃才清理 pending；放弃不表示撤销可能已提交的 Bot，不触发后台发送。
- 400 字段校验、401 真匿名、403 当前访问拒绝、409 precondition/consumed/idempotency/expiry、413 大小、503 未确认结果；只有 401 清 session，403 不伪装成登出。能力失败定位到具体映射，不回传 provider 原错误/响应体。

## 有界传输、存储与独立性

- 模板原始 UTF-8 上限 256 KiB（可容纳现有 32000 指令及 JSON escaping），最大嵌套 12；严格 UTF-8。包装原 JSON 文本的请求上限 512 KiB；完整 review/diff 响应 1 MiB，错误 16 KiB；30 秒贯穿 headers/body。验证实际字节，不只信 Content-Length；abort/finally 释放读取且不 await 永不完成的 cancel。
- 上传只作为 JSON 数据；不解压、不执行、不解析远程引用，不交附件/对象储存读取器。BFF 原生 form 与 enhanced flow 都保留原 intent，错误渲染及下载 filename 不拼接任意模板文本。
- 成功后的 configuration 只含本地目标 bindings 和已明确行为；任何模板/source/local-compare 指针不得进入执行 reader。没有原 Avatar/knowledge/memory/approval/attachments/references/ACL/grant 的复制、重新授权或懒加载路径。
- 新 receipt/draft/requiredCapabilities 是待实现能力；只有实际已接受的 MEM-02/当时迁移前驱存在后再登记真实 DDL/provisioner/runtime grants。不得预占编号、修改旧 migration、引入 broad UPDATE/DELETE/TRUNCATE 或把 admin 凭据交给 app。

## 必须证明的完整链与门

| 门 | 必须实测的证据 |
| --- | --- |
| 纯 schema/projection/strict DTO | 每层 unknown/重复键、schema/type/范围、UTF-8/字节/完整最长指令、absence vs empty、原顺序、所有 field errors；合法 export→import→re-export 的行为等价，明确映射差异不算丢失 |
| 真实 API/BFF + Bot 全 writer | capability 新 producer 在 create/edit/metadata edit/restore/copy/history/public API 无损；每目标 required conjunction、unknown/disabled/changed model/actor scope；非法操作与预览零 Bot/版本/成功 audit |
| 真正完整的隐私链 | 经实际生产入口创建 source Bot、头像/附件/对话及 MEM-02 approved private memory，再实际 export、由另一 workspace 的合法用户 preview/import；序列化无敏感字段/真实引用，源已存在事实不得用空数组或伪造 DTO 代替 |
| 实际执行隔离 | imported Bot direct/合法新 group Run 可工作；provider 输入与 actual selected memory manifests 没有 source private memory/attachment/history，猜 source IDs 仍拒绝。改变/撤销/purge source 后 imported 行为配置独立；仅口头模型回答不是隔离证据 |
| Native restricted role | 实际迁移/生产 writer 下同 key 与异 key/同 preview 并发只创建一份；actor/ACL/provider/model/capability 等待期间变化；用 pg_stat_activity + pg_blocking_pids 证明锁等待；receipt/version 不可篡改，audit/最终 expiry 失败全快照回滚 |
| 真实浏览器与故障 | 原生无 JS 和 enhanced 完整预览/显式绑定/完整 diff；源 fallback 不静默消失；实际 Fastify commit 后 response abort，再 reload 原 key 得同 Bot/receipt；当前撤权清内容、storage 失败阻止提交；真实 UI/API，provider 可用受控 wire fixture |
| 最终组合与部署 | root 固定整合树独立 Spec/Standards、受影响全测试/types/build/lint、真实普通/OIDC browser、native/Compose 使用 app 最小权限与非敏感验收 receipt；skip/discovery/旧 CI 绿色不可替代本票新门 |

本调查没有运行上述任何门。MEM-02 尚未完整接受前保留 TPL-01 原 blocker，即使纯格式/helper 先行审查 CLEAN 也不能勾掉六 AC。TPL-02 的 atomic team writer 可复用本票窄事务模块，但本票不创建 group/team/routine 或导入用户。

## Suggested Skills

正式实施先用 `matt-skills-curated:implement` 与 `matt-skills-curated:tdd`，按上述公开边界观察 RED→GREEN；冻结实际组合源后用 `matt-skills-curated:code-review` 做独立 Spec/Standards。只有真实合并冲突才应用 resolving-merge-conflicts。

## 精确下一步

```sh
cat /workspace/scratch/2bc98607b3a9/TPL-01-PREIMPLEMENTATION-HANDOFF.md
```

下一提示：先报告 MEM-02 最终 accepted pin、当前母树及 COL-10 配置已接合证据；依赖满足后在隔离分支从“真实 Bot export → 严格 preview → 显式 Basic binding → 同事务独立 Bot/receipt”纵切开始 TDD，再加入 capability producer、完整策略/本地 diff、重载和全部真实门。本文不授权提前解除 blocker 或跳过其余验收。
