# PR1：建立 Mission parity 基础合同

本 brief 可直接交给仅能读取此仓库的实施 agent。新增行为的唯一权威是 [design.md](design.md)，本文件展开其第 18.2 节的实施步骤；[codebase-map.md](codebase-map.md)提供当前代码定位。PR1 只交付基础，不开放 parity 产品流程。

## 1. 范围与前置

开始前核对 cwd、git status、HEAD、CONTROL_SCHEMA_VERSION。基线代码的控制库版本为 10；本 PR 将它升为 11。若主线已被其他迁移推进，停止分配版本并报告冲突，先由主线重新分配；不要在功能分支抢占下一版本。保留现有 dirty 工作，不修改其他工作树。

实现这些可独立验证的内容：

- TypeBox 基础 registry、解析器和由 Static 推导的公开类型。
- mission_workflows 一张基础表、data v1、控制库锁内迁移与失败回滚。
- canonical JSON、域分离 H、policy/roles 摘要和合成 fixture。
- 非秘密 daemon 环境开关、只读 workflow 状态与未实现能力的拒绝。
- 基础记录随备份/恢复和私有 export 精确往返。

本 PR 不创建 plan_drafts、mission_plans、milestones、task_runs、预算、交接、资产、环境或阶段表，不定义它们未来全部请求类型。不实现 AcceptPlan/TaskRun/SubmitPlan、真实模型调用、执行命令、服务、UI、远端协议或 NodeJournal 迁移。不注册没有 handler 的模型工具。后续 PR 各自带迁移和行为测试。

## 2. 文件与迁移责任

| 文件 | 本 PR 的责任 |
| --- | --- |
| src/workflow-schema.ts | 基础 TypeBox registry、版本化 data v1 解析、canonical/H 与基础错误 envelope；无 shell/网络 |
| src/contracts.ts | 只导出已实现的基础类型与只读 detail 类型，引用 registry 的 Static 类型 |
| src/control.ts | CONTROL_SCHEMA_VERSION=11；复用构造器 owner 锁、BEGIN IMMEDIATE 和 migrate；读基础 workflow，按持久 mode 守 gate |
| src/backup.ts | 识别基础 data v1，保留原离线锁、manifest/hash、恢复隔离和不升级恢复库规则 |
| src/workflow-observability.ts | detail/export 的基础行投影；不建统计表 |
| src/server.ts | 复用认证/同源规则的 GET /api/missions/:id/workflow 与结构化错误；不新增 mutation 空入口 |
| test/migrations.test.mjs、test/backup.test.mjs、test/control-owner.test.mjs 及新的基础测试 | 合成 fixture、迁移、解析、摘要、gate 和备份行为 |
| README.md | 本阶段能力、版本/回退、gate 关闭保护，不能宣布 parity 可执行 |

现有入口先按函数名核对：ControlPlane 构造器、checkStartupCompatibility/migrate/transaction、detail/exportMission；backupHome、restoreHome 和恢复隔离函数；worker 的 Type.Object 风格。地图中的行号仅辅助定位。本 PR 不改 worker/node 的工具白名单或远端 envelope。

控制库在现有 owner 锁和同一迁移事务内新增下表。不得为了迁移启动第二个 ControlPlane，不做 DROP 或清空旧业务行：

```sql
CREATE TABLE mission_workflows (
  mission_id TEXT PRIMARY KEY REFERENCES missions(id),
  mode TEXT NOT NULL CHECK(mode IN ('classic','parity-v1')),
  phase TEXT NOT NULL CHECK(phase IN ('planning','awaiting_plan_acceptance','executing')),
  revision INTEGER NOT NULL CHECK(revision > 0),
  data TEXT NOT NULL CHECK(json_valid(data))
);
```

保留 0→既有布局→11 的累计升级，未来版本拒绝，不支持自动降级。版本相等时不重复迁移；出错必须整事务回滚。PR1 的 parity 合成行只允许 phase=planning；awaiting/executing 留给 PR2 的完整 data v2 解析。classic 旧 Mission 不回填虚构 workflow 行。

## 3. 基础数据和解析

索引列为权威，data 不重复存 mission_id、mode、phase、revision。`MissionWorkflowDataV1={schemaVersion:1,policy,policyRevision,roleBindings,createdAt,updatedAt}`，不允许额外键。policyRevision 初始 1，只有政策内容实际变化才增；workflow.revision 初始 1，未来由 PR2 的动作推进。PR1 无政策修改入口。

Id 为 1..240 字符，Text 为 1..20000 字符，Digest 为 64 位小写十六进制，Revision 为非负安全整数。时间为服务器 ISO 字符串。未知外部输入先解析；默认值显式填入，不依赖 TypeBox 的 default 注解。

`WorkflowPolicy` 完整字段与默认值为 `{autoAcceptPlan:false,autoAcceptRepairs:false,defaultAttemptLimit:5,maxParallelTasks:1,skipScrutiny:false,skipUserTesting:false}`。请求 schema 接受 boolean 的 autoAcceptRepairs 和 1..1000 的 maxParallelTasks，领域校验统一将 true 或大于 1 拒绝为 409 CAPABILITY_UNAVAILABLE；存储 schema 只允许 false/1。defaultAttemptLimit 为 1..1000。未知字段、错误类型或小于 1 为 400 OPERATION_REJECTED。即使本阶段只有解析/测试入口，也要固定此边界，不能用 Literal 先变成 400。

roleBindings 恰好包含 orchestrator、worker、task-validator、scrutiny、user-testing 五个唯一 slot，后三者的角色 kind 均为 validator。每项为 `{slot,expectedRoleId,reasoningEffort?,resolved:EffectiveExecutionConfig}`。requested effort 可省略；resolved 必填。

`EffectiveExecutionConfig={profileId,profileRevision,profileSnapshot,roleId,roleRevision,roleSnapshot,reasoningEffort,adapterVersion}`。profileSnapshot 使用现有 ModelProfile 的全部字段，roleSnapshot 使用现有 RoleProfile 的全部字段；复用嵌套 MCP 权限 schema，不能 Type.Any/Unknown 透传。ID、revision、role kind 必须与快照自洽。profile/role revision 是正安全整数；adapterVersion 是 Id。effort 枚举为 off|minimal|low|medium|high|xhigh|max，reasoning=false 时只允许 resolved off。PR1 只解析保存的快照；实际 provider 能力映射与角色默认解析归 PR2。

只存 credentialEnv 名称，不存凭据值。fixture 的 endpoint、模型和资源均用合成值，不访问外部 provider。更新全局 profile/role 后不得从最新值覆盖旧行内快照。

## 4. 编码、错误和 gate

逐字实现设计第 3.6 节的 C 与 `H(domain,value)`：UTF-8、固定 `mc:<domain>:v1\n` 前缀、SHA-256、小写 hex。键用 UTF-16 code unit 排序，字符串/有限数按 ECMAScript JSON.stringify，数组保序；按 schema 指定的集合排序，roles 按 slot。拒绝重复键、额外键、undefined、非有限数、稀疏数组、未配对 surrogate。不要使用 localeCompare 或原始对象插入顺序。

PR1 登记 policy、roles、command-payload、execution-config 域并提供通用 H；未来域的精确投影由其负责 PR 与 handler 一起增加。本 PR 不实现未来 plan/stage 请求 schema。文件/CAS sha256 继续校验原始字节。服务器重算 policy/roles 摘要，不信任调用者自报值。

基础中央 ErrorCode registry 只包含 OPERATION_REJECTED、AUTHENTICATION_FAILED、INTERNAL_ERROR、CAPABILITY_UNAVAILABLE、DIGEST_MISMATCH。HTTP envelope 为 `{error:string,code,details?}`，SafeErrorDetails 遵守设计第 5.3 节白名单，不透 stack/凭据。以后每个 PR 原子加入自己所需错误码与 handler；PR1 不枚举未来所有业务码，不改 classic 远端 parser。

`missionParityEnabled` 只等于 daemon 启动时 `MC_ENABLE_MISSION_PARITY === "1"`，缺省 false，无新配置表。开启环境开关不能使未实现 handler 可调用。所有 parity 执行能力在本阶段均返回 409 CAPABILITY_UNAVAILABLE。API 省略 workflowMode 仍为 classic；已有 parity 行不能因关闭 gate 被解析为 classic。

只读 GET workflow 对没有行的 classic Mission 返回 `{workflow:null,missionParityEnabled,allowedActions}`；有基础行时返回 `{workflow:完整基础记录,missionParityEnabled,allowedActions}`。allowedActions 只包含当前实际 handler 可安全执行的动作；本阶段无 parity start/resume/accept/admission。认证后的读状态、备份和原有停止/调和保护可用；关闭 gate 不能释放 held 消息或绕过恢复隔离。不要在 GET 中补行或改版本。

## 5. 备份、私有导出与 fixture

基础表在 control.sqlite 中随现有数据库快照备份，不增加任意 home 文件。PR1 基础 data 不引用 CAS；没有 workflow 引用的 classic 备份继续按原规则恢复，不要求计划、skill、候选或报告存在。后续各 PR 才为自己新增的真实引用增加强制完整性遍历。

私有 export 保留 mission-control-replay-v1 外层，增加 controlSchemaVersion、workflowFormat="mission-workflow-v1" 和本阶段实际基础记录。没有行时 workflow 为 null。它是审计材料，不可执行恢复。公开脱敏导出和统计新表不在 PR1。

使用临时 home 和合成 Mission，构造完整基础行后做真实 SQLite/备份往返：

1. 写入非默认政策、五 slot 和完整旧 profile/role/config 快照，保存 C(data)、H(policy) 和 H(roles)。
2. 修改当前全局 profile/role 与默认 effort，关闭再打开 ControlPlane。读回旧行，断言完整内容、摘要和授权配置仍与步骤 1 相同。
3. 按现有离线锁规则 backupHome，再恢复到符合现有 worktree 路径规则的目标；restoreHome 不擅自升级数据库。再启动受支持构建，验证旧基础记录仍完整，原恢复隔离继续生效。
4. 单独覆盖没有 workflow 行的旧 classic 备份恢复成功、未来版本拒绝、损坏/未知 data 版本失败关闭。

不构造尚未定义的 MissionPlan 记录，不证明或宣称“完整 MVP 计划授权恢复通过”。这个承诺从 PR2 的实际计划与资源 fixture 开始逐步补齐。

## 6. 行为验收与命令

提交必须给出以下行为证据：

- 0/10→11、重开幂等、失败回滚、未来版本和 owner 锁冲突拒绝；迁移后只多这一张基础表。
- 数据错误/额外键/重复 slot 拒绝；政策 true/并行值的业务错误为 409，存储只允许 false/1。
- canonical 固定字节向量覆盖键顺序、中文、引号/换行、负零、有限小数、集合次序、重复转义键和不同 domain；用独立字面预期字节验证，不只比较函数自身输出。
- fixture 经重开/备份恢复保留旧政策/角色，classic 无引用恢复成功。GET 不写库，未知 data 版本不转 classic。
- 缺省/0/其他环境值关闭、1 解析为打开；两种状态都不执行未实现能力。gate 关闭后已有 parity 仍可读，start/resume/admission 拒绝，原停止/恢复门不变。
- 结构化 HTTP 基础错误实际到达调用者；classic 所有权、终态/投递恢复回归通过。

使用仓库已有依赖和构建入口；环境准备由调用方负责，不在共享目录重装依赖。纯文档任务不运行下列产品测试，PR1 实现完成后才运行：

```sh
npm run build
node --test test/migrations.test.mjs test/backup.test.mjs test/control-owner.test.mjs
npm test
npm run typecheck
npm run lint
```

新增基础测试加入 test/*.test.mjs，随 npm test 执行。若必需平台能力或依赖缺失，报告具体缺口，不用源码字符串断言冒充迁移/恢复成功。README 和交付报告只声称实际通过的 build/测试，UI、Linux mock、真实模型与容器分别列未执行状态。

## 7. 后续 PR 门槛

PR1 合入并取得 schema11 迁移/恢复与 classic 回归证据后，PR2 基于该主线分配下一控制版本，交付 plan/draft/run/budget、initialBase、RunInputSnapshot、PlanWait、稳定物化和 uncertain close。PR3 交付 handoff/asset/PutWorkflowResources；PR4 交付候选/环境/result/validation intent；PR5 交付持久逐项结果/report/finding/最终门；PR6 组合 UI 与本地链路验收。

每个 PR 自带所需 schema、迁移、handler、中央错误码和往返 fixture。节点版本化、shared/remote parity、inventory/capture 协议扩展继续延期。PR1 不冻结未来所有 handler 类型或预建空表，也不授权后续 PR 偷加未定义 JSON 字段。
