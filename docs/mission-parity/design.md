# Mission Control 的 Mission 行为对等合同

本文是 Mission parity 新增行为、数据、状态、工具、错误和 PR 顺序的唯一合同。[代码地图](codebase-map.md)只说明现有代码位置、兼容影响和验证入口。本文描述待实现行为；文档检查通过不代表功能已实现。

## 1. 目标、MVP 与 P0

### 1.1 行为对等与范围

用户先协作制定计划，接受后执行 feature，审阅结构化交接，在串行 milestone 边界完成 scrutiny 和 user-testing，修复并显式重验，最终交付经过独立验收的冻结产品。五类角色可分别配置模型与 reasoning effort。feature 复用 Task，阶段验证使用独立记录。

MVP 仅支持 coordinator-local + worktree：所有 orchestrator、worker、Task validator、stage validator 和服务都在协调端本地，Mission 必须 workspaceStrategy="worktree"。包含计划草稿与接受、拒绝重提、有限取消、TaskRun 与预算、副作用准入、五角色模型、交接与游标、固定版本 skill、输入摘要、完整候选、环境准备、本地服务、阶段验证、finding、显式重验、最终交付和最小中文 UI。parity 的 shared、remote task/validator/service、远端协议扩展、inventory 和 capture 均返回 409 CAPABILITY_UNAVAILABLE；classic 的现有 local/shared/remote 路径保持原行为。

以下延期，不能作为 MVP 的依赖：shared parity、全部 remote parity、NodeJournal 版本化迁移、协议 4 和远端托管服务、公开脱敏导出、运行统计新表、knowledge 自动过期、autoAcceptRepairs、并行度大于 1、旧 Mission adopt、SSE、新浏览器执行器、droid 对照实验。现有知识文本可以作为固定资料引用，MVP 不建自动知识更新引擎。缺 token 或精确时长的数据标“不可用”。

feature gate `missionParityEnabled` 只由 daemon 启动环境中的非秘密开关 `MC_ENABLE_MISSION_PARITY=1` 得到；缺省或其他值均为 false，不新增配置表。全部 MVP handler 和验收齐备后才允许打开；打开后新建 UI 默认 `workflowMode:"parity-v1"`。API 省略 workflowMode 始终为 classic。旧 Mission 不自动采用 parity。

关闭开关后，已有 parity Mission 仍按持久 mode 解析，允许认证后的读状态、备份、pause/cancel、停止证据调和和第 4.4 节 close；禁止 start/resume、新准入、接受计划及其他会扩展执行授权的操作，统一 409 CAPABILITY_UNAVAILABLE。恢复隔离、PlanWait 和停止门始终执行，绝不转成 classic 或派发已有 held 消息。重新开启也不自动 resume。

### 1.2 来源与未知

[Factory Missions 概览](https://docs.factory.com/missions/overview)说明规划、feature、milestone、skill 和计划接受。[规划与验证](https://docs.factory.com/missions/planning)说明里程碑验证和可脚本化产品检查。[Missions reference](https://docs.factory.com/missions/reference)说明模型、effort 和两项 skip。[Introducing Missions](https://factory.com/news/missions)描述交接与不同验证工作。

“本地记录观察到的通用机制”仅用于理解结构化交接、预算追加、资料版本和审阅，不保存任何原始业务内容、私有配置、路径、标识或测量统计。后文的精确 schema、工具名和转换是 MC 的产品决定。droid 未确认的细节见第 16 节。

### 1.3 必须保留的 P0

| 不变量 | 已有代码位置 | parity 约束 |
| --- | --- | --- |
| 非空契约、修订历史、断言唯一归属 | `src/control.ts` 的 `parseAssertions`、`updateValidationContract`、`validateFulfills`、`requirementCoverage`；`src/contracts.ts:48` | 只有正式 Task 的 fulfills 认领断言；草稿映射不参与当前覆盖。模型不能弱化契约。 |
| 独立 validator 的真实回执 | `runValidation` 在 `src/control.ts:4559`；`validateTask` 在 `:4877` | 保留 `RunValidation → ValidateTask`，owner 与 validator 不同，回执绑定当前 revision、run、工件和证据要求。 |
| 全部当前断言通过才能完成 | `completeMission` 在 `src/control.ts:3893`，任务门在 `:3903`，integration 闭包在 `:3941` 附近 | skip 只跳过附加阶段。交接、阶段报告和普通回答不能替代契约通过。第 9 节有限取消只排除严格合格的支持任务。 |
| durable outbox、blocker、不确定操作不重放 | `command`、`enqueueAgentMessage`、`quarantineTerminalLocalDeliveries`、`reconcileInFlightOperations`；`src/worker-mailbox.ts` | 元数据与通知同事务；不确定操作不换 ID 重试，不重绑旧 permit。 |
| 远端冻结快照验证 | `assertRemoteSnapshotInputs`、`runValidation`、`completeMission`；`src/remote-artifacts.ts` | 远端自测与协调端独立验收分开，检验 CAS 与 detached 输入。 |
| 停止证据与恢复门 | `assertRemoteRuntimeReassignable` 在 `src/control.ts:1171`；`confirmedRemoteRuntimeStop`、`blockUnconfirmedLocalWorkerStop`、`confirmLocalWorkerExit`、`missionAction`；`src/workers.ts` | AcceptPlan、grant、问题回答和服务健康均不构成退出证明。保留 stop hold、原 epoch 与不重放规则。 |
| 所有权锁 | `tryAcquireDaemonOwnership`、`claimAgentOwner`；`acquireStoreLease` 在 `src/worker.ts:121`；`src/node.ts` 的节点独占锁；`src/node-workers.ts:246` | 迁移、执行、备份都在各自独占所有权之下，不增加第二个调度写者。 |
| worktree 最终集成 | `completeMission`；`src/prompts.ts` 的 `WORKTREE_INSTRUCTIONS` | 保留唯一 integration、全部有效普通 Task 依赖闭包、提交祖先证明、冻结集成提交上的全契约验收。另加阶段与最终内容绑定。 |
| validator 不修改产品 | `src/worker.ts` 的角色过滤；`workerCommand` | 无通用 write_file/bash；只经受控验收执行身份准备环境、运行检查、提交结果。 |

## 2. 概念映射与权威边界

| droid 概念 | MC 对应 | 决定 |
| --- | --- | --- |
| Mission、计划接受、awaiting input | Mission + MissionWorkflow + MissionPlan + 专用 plan_acceptance blocker | 顶层执行状态与 workflow.phase 分开。计划接受只能来自运营者或预先生效的 autoAcceptPlan 政策。 |
| milestone | Milestone | 串行，按 dependsOn 与 ordinal 推进；内部 DAG 决定就绪，MVP maxParallelTasks=1。 |
| feature、skillName、preconditions、expectedBehavior、fulfills | 接受前 PlanDraft，接受后 Task.workflow 与原 Task.fulfills | 不建立第二套 Feature 引擎。自然语言前提不自动解析成依赖。 |
| worker run | TaskRun | 独立于 Task.attempt 和 generation。持久 Agent 可以承接多次运行。 |
| EndFeatureRun | EndTaskRun | 提交 handoff 并结束本轮，不能接受 Task。 |
| 交接消化与游标 | HandoffItem + ReviewHandoff + 连续 cursor | 遗留逐项采用为任务或有理由驳回；不能手动跳 cursor。 |
| scrutiny、user testing | MilestoneValidationRun + StageResultSet + item receipt | 独立于 Task DAG，不建立验收 Task 环。先 scrutiny，再 user-testing。 |
| validation-state | 原 requirementCoverage + stageCoverage | 原 Task 验收是断言权威来源；阶段覆盖是附加观察。 |
| 修复 feature | purpose=repair 的 Task | 从草稿接受后才正式创建。MVP 逐次接受补修计划，不自动接受。 |
| retry budget、bonus | TaskBudget + TaskRun + BudgetGrant | 按准入次数计，默认 5；grant 只允许运营者，不能自动恢复。 |
| init、services | EnvironmentSpec、EnvironmentOperation、本地 ServiceInstance | 固定已接受 commandRecipe；远端托管服务延期。 |
| skills、library | WorkflowAsset 固定版本 | MVP 实现 skill 和只读 guidance 版本。knowledge 自动更新与过期延期。 |
| 角色模型与 effort | roleBindingsSnapshot + effectiveExecutionConfig | orchestrator、worker、task-validator、scrutiny、user-testing 分槽，后三者权限 kind 均 validator。 |

正式任务集合参与完成门，草稿集合不参与。接受后的计划、政策、角色快照和资源版本不可变。当前投影与审计历史必须可从 SQLite 和 CAS 还原，不能依赖 agent 会话或最新全局设置。

## 3. MVP 数据合同、迁移与恢复

### 3.1 唯一 schema 来源与修订规则

模型工具、HTTP、IPC、mailbox、数据库 JSON、返回和错误的唯一 schema 来源为 TypeBox，沿用 `src/worker.ts` 的 Type.Object 风格。实现从 TypeBox 推导 Static 类型并用同一 schema 校验；不新增 Zod 版本的同一合同。所有object禁额外键，边界解析unknown，内部使用已解析类型。Type与Static沿用已安装@earendil-works/pi-ai的TypeBox导出，不另选并行schema框架。

以下记号都对应同一 TypeBox registry 的命名 schema：Id 为 1..240 字符，Text 为 1..20000 字符，Digest 为 64 位小写十六进制，Revision 为非负安全整数，Ids 为最多 2000 个唯一 Id。标 `?` 的字段可省略，其余必填。默认值由边界解析器显式写入，不能只依赖文档或 TypeBox 注解。各记录的 data 有独立 schemaVersion：MissionWorkflow 在 PR2 升为 2；Milestone 在 PR2/PR4/PR5 分别为 1/2/3；其余本合同首次引入的结构均为 1。控制库 user_version、data schemaVersion 和计划 revision 互不替代。未来修改冻结输入投影必须使用新 snapshot 版本。

- `mission_workflows.revision` 初始 1；政策修改、草稿变更、SubmitPlan、接受或拒绝均递增。SubmitPlan.expectedRevision 与 workflow PATCH.expectedRevision 比较这一列，不能比较 plan revision。policyProposal 在提交时保存待采用的 policyRevision（内容未变则保持，改变则为当前加一），接受时才原子应用，拒绝不增加当前 policyRevision。
- `policyRevision` 初始 1，仅在规范化后的政策内容实际变化时加一；同内容 PATCH 不增。草稿、提交、接受、拒绝和角色修改均不增 policyRevision。PlanDecision 保存决定采用的政策 revision，独立于 workflow.revision。
- PlanDraft 有自己的 revision；编辑同时核对 expectedDraftRevision 与 expectedWorkflowRevision。草稿删除为软删除，不影响已有计划快照。
- MissionPlan.revision 是快照序号。pending → accepted/rejected/superseded 仅改决定字段；快照内容不变。接受后的政策、角色、资源和 TaskDraft 内容永不回写。
- TaskBudget.revision 初始 1，grant 后递增；grant.expectedRevision 只比较预算行。base_limit 在正式任务物化时冻结，不能随新默认值改动。
- Task.attempt 保留原验收返工轮次。TaskRun.ordinal 才是 worker 已准入尝试；不从旧 attempt 捏造历史。

### 3.2 控制库 DDL

下列 DDL 描述六个 PR 合入后的目标布局，并非 PR1 一次建表清单。PR1 仅将 CONTROL_SCHEMA_VERSION 从 10 提升到 11，建立 mission_workflows 的基础存储与解析、gate、canonical JSON 和错误 envelope；PR2–PR5 在自己的 PR 中增加所需表、列、类型、迁移和行为测试。每次升级先核对已合入主线的前置版本，再由主线顺序分配下一个 user_version；并行功能分支不得预占或碰撞。所有新增 schema 都在 daemon owner 锁和现有 BEGIN IMMEDIATE 事务内迁移，禁止隐式建表。逐 PR 所有权与往返 fixture 见第 18、19 节。

```sql
-- PR1：data v1 仅含本节下文定义的基础合同；PR2 迁为 data v2。
CREATE TABLE mission_workflows (
  mission_id TEXT PRIMARY KEY REFERENCES missions(id),
  mode TEXT NOT NULL CHECK(mode IN ('classic','parity-v1')),
  phase TEXT NOT NULL CHECK(phase IN ('planning','awaiting_plan_acceptance','executing')),
  revision INTEGER NOT NULL CHECK(revision > 0),
  data TEXT NOT NULL CHECK(json_valid(data))
);
-- PR2：计划、预算与运行存储。
CREATE TABLE plan_drafts (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id),
  revision INTEGER NOT NULL CHECK(revision > 0),
  draft_key TEXT NOT NULL,
  materialized_task_id TEXT REFERENCES tasks(id),
  status TEXT NOT NULL CHECK(status IN ('editable','deleted')),
  data TEXT NOT NULL CHECK(json_valid(data)),
  UNIQUE(mission_id,draft_key)
);
CREATE TABLE mission_plans (
  mission_id TEXT NOT NULL REFERENCES missions(id),
  revision INTEGER NOT NULL CHECK(revision > 0),
  status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected','superseded')),
  digest TEXT NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data)),
  PRIMARY KEY(mission_id,revision)
);
CREATE UNIQUE INDEX mission_plans_one_pending_idx ON mission_plans(mission_id)
  WHERE status = 'pending';
CREATE TABLE milestones (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id),
  milestone_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  revision INTEGER NOT NULL CHECK(revision > 0),
  status TEXT NOT NULL CHECK(status IN ('planned','executing','ready_for_validation','validating','rework','passed')),
  data TEXT NOT NULL CHECK(json_valid(data)),
  UNIQUE(mission_id,ordinal),
  UNIQUE(mission_id,milestone_key)
);
CREATE TABLE task_budgets (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id),
  mission_id TEXT NOT NULL REFERENCES missions(id),
  base_limit INTEGER NOT NULL CHECK(base_limit > 0),
  revision INTEGER NOT NULL CHECK(revision > 0),
  data TEXT NOT NULL CHECK(json_valid(data))
);
CREATE TABLE task_runs (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  ordinal INTEGER NOT NULL CHECK(ordinal > 0),
  status TEXT NOT NULL CHECK(status IN ('running','suspended','handed_off','failed','uncertain','cancelled','closed')),
  data TEXT NOT NULL CHECK(json_valid(data)),
  UNIQUE(task_id,ordinal)
);
CREATE UNIQUE INDEX task_runs_one_open_idx ON task_runs(task_id)
  WHERE status IN ('running','suspended','uncertain');
CREATE TABLE task_budget_grants (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  request_id TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK(amount > 0),
  data TEXT NOT NULL CHECK(json_valid(data)),
  UNIQUE(mission_id,request_id)
);
-- PR3：交接存储。
CREATE TABLE task_handoffs (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  run_id TEXT NOT NULL UNIQUE REFERENCES task_runs(id),
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  status TEXT NOT NULL CHECK(status IN ('pending','reviewed')),
  data TEXT NOT NULL CHECK(json_valid(data)),
  UNIQUE(mission_id,sequence)
);
CREATE TABLE handoff_items (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id),
  handoff_id TEXT NOT NULL REFERENCES task_handoffs(id),
  status TEXT NOT NULL CHECK(status IN ('pending','accepted_as_draft','accepted_as_task','dismissed')),
  data TEXT NOT NULL CHECK(json_valid(data))
);
-- PR5：阶段结果、检查和 finding。
CREATE TABLE milestone_validation_runs (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id),
  milestone_id TEXT NOT NULL REFERENCES milestones(id),
  kind TEXT NOT NULL CHECK(kind IN ('scrutiny','user-testing')),
  scope_hash TEXT NOT NULL,
  round INTEGER NOT NULL CHECK(round > 0),
  status TEXT NOT NULL CHECK(status IN ('planned','queued','running','passed','failed','blocked','skipped','superseded','cancelled','uncertain')),
  data TEXT NOT NULL CHECK(json_valid(data)),
  UNIQUE(milestone_id,kind,scope_hash,round)
);
CREATE UNIQUE INDEX milestone_validation_one_open_idx
  ON milestone_validation_runs(milestone_id,kind,scope_hash)
  WHERE status IN ('planned','queued','running','blocked','uncertain');
CREATE TABLE milestone_check_intents (
  run_id TEXT NOT NULL REFERENCES milestone_validation_runs(id),
  command_id TEXT NOT NULL,
  mission_id TEXT NOT NULL REFERENCES missions(id),
  item_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('prepared','approval_pending','executing','finished','uncertain','cancelled')),
  data TEXT NOT NULL CHECK(json_valid(data)),
  PRIMARY KEY(run_id,command_id)
);
CREATE UNIQUE INDEX milestone_check_one_open_idx ON milestone_check_intents(run_id,item_id)
  WHERE status IN ('prepared','approval_pending','executing','uncertain');
CREATE TABLE milestone_check_receipts (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id),
  run_id TEXT NOT NULL REFERENCES milestone_validation_runs(id),
  item_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data)),
  UNIQUE(run_id,command_id)
);
CREATE TABLE milestone_findings (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id),
  run_id TEXT NOT NULL REFERENCES milestone_validation_runs(id),
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('open','repair_planned','awaiting_recheck','resolved','dismissed')),
  data TEXT NOT NULL CHECK(json_valid(data)),
  UNIQUE(run_id,fingerprint)
);
-- PR3：固定资料版本。
CREATE TABLE workflow_assets (
  id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  mission_id TEXT NOT NULL REFERENCES missions(id),
  kind TEXT NOT NULL CHECK(kind IN ('skill','guidance')),
  digest TEXT NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data)),
  PRIMARY KEY(id,version)
);
-- PR4：环境规格、操作与本地服务。
CREATE TABLE environment_specs (
  mission_id TEXT NOT NULL REFERENCES missions(id),
  revision INTEGER NOT NULL CHECK(revision > 0),
  digest TEXT NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data)),
  PRIMARY KEY(mission_id,revision)
);
CREATE TABLE environment_operations (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id),
  machine_id TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('prepared','approval_pending','running','succeeded','failed','uncertain','cancelled')),
  data TEXT NOT NULL CHECK(json_valid(data)),
  UNIQUE(mission_id,operation_key)
);
CREATE TABLE service_instances (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id),
  machine_id TEXT NOT NULL,
  service_name TEXT NOT NULL,
  instance_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('starting','healthy','unhealthy','stopping','stopped','uncertain')),
  data TEXT NOT NULL CHECK(json_valid(data)),
  UNIQUE(mission_id,instance_key)
);
```

索引列是权威字段，data 不重复存同名值。各表所需查询索引由引入该表的 PR 提交。外键之外还验证同 Mission、资源版本、角色与执行身份，不级联删除历史。PR2 的 pending 部分唯一索引与 SubmitPlan handler 原子交付；已有 pending 时第二次 SubmitPlan 返回 409 PLAN_PENDING_EXISTS，原 command 同 payload 重试返回原计划。

PR1 的 `MissionWorkflow.data v1={schemaVersion:1,policy,policyRevision,roleBindings,createdAt,updatedAt}`，roleBindings 为五 slot 的完整 RoleBinding 数组。只有合成 fixture 写入 parity 行；不注册产品写入口，也不生成虚构计划。PR2 在同一控制库迁移内将 v1 转为 v2：增加 initialBase、游标和等待字段。fixture 行要求 phase=planning、无已接受计划，initialBase 用显式 `{kind:"empty"}`；真正项目必须在 start 时捕获 initialBase。PR1 的 round-trip 只承诺基础政策和角色授权可还原，完整计划授权从 PR2 开始验证。

### 3.3 持久对象的完整字段

下表列出 data 的权威字段；嵌套类型在本节及相应专节定义。所有时间由服务器写 ISO 时间，identity、digest、实际执行机器不可由模型自报。

| 对象 | data 字段、默认值与历史引用 |
| --- | --- |
| MissionWorkflow（PR2 data v2） | `schemaVersion:2,policy,policyRevision,roleBindings,initialBase:CandidateBase,initialBaseManifestId?,acceptedPlanRevision?,initialFeatureCount?,handoffCursor:0,waitingReason:null|plan_acceptance|plan_settling|question,waitingBlockerId?,planWait?,environmentRevision?,createdAt,updatedAt`。policy 为完整 WorkflowPolicy，roleBindings 为完整当前已生效快照。 |
| PlanDraft | `schemaVersion,task:TaskDraft,createdBy,createdAt,updatedAt`。仅 editable 且未物化行可改；deleted保留历史，不计正式任务。存在pending计划时拒绝编辑/删除，先RejectPlan；执行期可准备后续草稿，但SubmitPlan才进入停止结算。 |
| MissionPlan | `schemaVersion,summary,sourceWorkflowRevision,submittedWorkflowRevision,contractRevision,draftSnapshots:DraftSnapshot[],existingTaskSnapshots:TaskSnapshot[],milestoneSpecs,assertionMap,commandRecipes,candidatePolicy,policySnapshot,policyRevision,policyDigest,roleBindingsSnapshot,roleBindingsDigest,environmentRef?,assetRefs,decision,materialization?,createdBy,createdAt`。policy/role 均存完整快照与 digest，不能只存 hash。 |
| Milestone（最终 data v3；key 在索引列） | `schemaVersion:3,title,description,dependsOn,memberTaskIds,planRevision,policySnapshot,displayRevision:1,checkPlan:[],candidateManifestId?,candidateDigest?,validationGeneration:0,createdAt,updatedAt`。policySnapshot 固定本阶段的 skip 与检查要求。 |
| TaskBudget | `schemaVersion,countingPolicy:"run-admission-v1",acceptedPlanRevision,exhaustedBlockerId?,createdAt`。base_limit 在接受事务写入；未来政策不改此值。 |
| TaskRun | `schemaVersion,agentId,taskAttempt,admissionTaskRevision,planRevision,inputSnapshot:RunInputSnapshot,inputDigest,effectiveExecutionConfig,expectedOwnerRoleId,expectedValidatorRoleId,bindingHistory,environmentRef?,skillRefs,admittedAt,endedAt?,terminalReason?,handoffId?,closeRecord?`。每次新准入 ordinal 递增。 |
| BudgetGrant | `schemaVersion,actor:"operator",reason,expectedBudgetRevision,createdAt`。bonus 为 amount 求和，不另存可改计数。 |
| TaskHandoff | `schemaVersion,successState,effectiveReturnToOrchestrator,handoff:HandoffPayload,submittedBy,taskRevision,reviewRevision:0,createdAt,reviewedBy?,reviewedAt?`。run_id 是唯一来源。 |
| HandoffItem | `schemaVersion,kind:incomplete_work|discovered_issue|skill_feedback|asset_proposal,ordinal,summary,severity,evidenceRefs,disposition?`。disposition 存 actor、reason、task/draft/asset 引用与时间。 |
| MilestoneValidationRun | `schemaVersion,subject:StageSubject,milestoneRevision,contractRevision,requirementRevisions,taskInputs,candidateRef,roleBindingSnapshot,validatorBinding?,checkPlan,selectedItemIds,environmentRef?,assetRefs,policyDigest,previousRunId?,retryRequestId?,retryReason?,blockerIds:[],notificationKey,itemResults:StageResultSet,summary?,reportArtifactId?,reportDigest?,skipDecision?:{policyRevision,policyDigest,reason},createdAt,startedAt?,endedAt?`。subject 为 milestone 或 final-delivery，见第 6 节。 |
| MilestoneCheckIntent | `schemaVersion,validatorId,agentEpoch,inputDigest,command,commandRecipeRef,exactArgsDigest,executionIdentity,approvalId?,executionClaim?,receiptId?,createdAt,updatedAt`。claim 绑定当前协调端 owner 与 process handle。 |
| MilestoneCheckReceipt | `schemaVersion,validatorId,agentEpoch,inputDigest,command,stdout,stderr,exitCode,startedAt,endedAt,snapshotIntegrity,executionIdentity,environmentOperationIds,evidenceRefs,status:succeeded|failed|uncertain`。空 exitCode 不成功。 |
| Finding | `schemaVersion,itemId,featureTaskIds,assertionIds,severity,description,location?,failurePath,evidenceRefs,suggestedFix?,repairDraftRefs:[],repairTaskIds:[],recheckReceiptIds:[],disposition?,createdAt`。stage finding 不创建 HandoffItem。 |
| WorkflowAsset | `schemaVersion,name,entrypoint,bodyArtifactId,resourceManifest,requiredTools,compatibleRoleKinds,createdBy,sourceRefs,scope,supersedesVersion?,createdAt`。entrypoint 对 skill 固定 SKILL.md；guidance 为正文相对名。内容版本不可变。 |
| EnvironmentSpec | `schemaVersion,initByContext,commands,services,machineBindings,createdBy,createdAt`，详细类型见第 11 节。accepted 后不可变。 |
| EnvironmentOperation | `schemaVersion,kind,environmentRef,actorId,actorEpoch,executionIdentity,commandRecipeRef,exactCommand,workspaceIdentity,binding?,approvalId?,effectId?,receiptHash?,result:EnvironmentResult,createdAt,updatedAt`。kind 为 init/start/stop/healthcheck；result 的状态必须与索引 status 一致，见第 11.1 节。 |
| ServiceInstance | `schemaVersion,environmentRef,workspaceIdentity,candidateDigest?,launchNonce,processIdentity?,startOperationId,healthOperationIds:[],stopOperationId?,desired:run|stop,cleanupPolicy:"stop-on-pause",startedAt?,stoppedAt?`。MVP machine_id 必须 local。 |

嵌套 schema 的字段如下，数组默认空只适用于明确写出的 `:[]`；其他必填数组可空但须满足领域检查：

- `WorkflowPolicy={autoAcceptPlan:false,autoAcceptRepairs:false,defaultAttemptLimit:5,maxParallelTasks:1,skipScrutiny:false,skipUserTesting:false}`。请求 schema 的类型分别为 boolean、boolean、1..1000 整数、1..1000 整数、boolean、boolean。请求可表达 true 和大于 1，但领域边界统一返回 409 CAPABILITY_UNAVAILABLE；落库 WorkflowPolicy 只允许 autoAcceptRepairs=false、maxParallelTasks=1。HTTP、工具、PATCH、policyProposal 使用同一拒绝语义，不能先被 Literal 校验变成 400。
- `TaskRef` 为 `{kind:"draft",draftId}` 或 `{kind:"task",taskId}`。`TaskDraft={key:Id,targetTaskId?:Id,title,description,acceptance,purpose:feature|repair|support|milestone_candidate|integration,milestoneKey?,dependsOn:TaskRef[],fulfills:Ids,expectedOwnerRoleId,expectedValidatorRoleId,skillRef?,originHandoffItemIds:Ids,preconditions:Text[],expectedBehavior:Text[],originFindingIds:Ids,affectedTaskIds:Ids,attemptLimit?}`。key 在同 Mission 稳定且唯一，和 draftId 一同保留。integration 无 milestoneKey、fulfills=[]，最终 integration 只允许一个。物化时 `Task.workflow.purpose="integration"` 当且仅当 `Task.integration=true`，其他 purpose 的 integration 为 false；双字段不一致拒绝。support/candidate 也必须 fulfills=[]。请求嵌套依赖统一叫 dependsOn；物化为现有 Task.dependencies，不重命名 classic 字段。
- `DraftSnapshot={draftId,draftRevision,task:TaskDraft}`，`TaskSnapshot={taskId,taskRevision,task:完整正式Task,everAccepted:boolean}`。`MilestoneSpec={key,title,description,ordinal,dependsOn:Id[],memberRefs:TaskRef[]}`。`assertionMap=[{assertionId,owner:TaskRef}]`，一条断言一个 owner。
- `PlanDecision` 为 pending，或 accepted 加 `{actor:operator|auto-policy,at,reason,policyRevision}`，或 rejected 加 `{actor:"operator",at,reason}`。`materialization={schemaVersion:1,draftToTaskMap:[{draftId,draftKey,taskId}],milestoneKeyToIdMap:[{key,milestoneId}],createdBudgetTaskIds:Ids,acceptedAt}`。不可用当前草稿重新解释旧计划。
- `RoleBinding={slot,expectedRoleId,reasoningEffort?,resolved:EffectiveExecutionConfig}`，slot 为五类角色。`EffectiveExecutionConfig={profileId,profileRevision,profileSnapshot:完整ModelProfile,roleId,roleRevision,roleSnapshot:完整RoleProfile,reasoningEffort,adapterVersion}`，只存 credentialEnv 引用，不存值。请求 effort 可省略，但 resolved 必填，接受时解析并冻结。
- `AssetRef={assetId,version,digest}`，`EnvironmentRef={revision,digest}`，`ResourceEntry={relativePath,artifactId,sha256,size,executable:boolean}`。resourceManifest 为 ResourceEntry[]，包含入口正文，路径唯一、拒绝符号链接和穿越。`AssetScope={taskIds:Ids,roleKinds:[orchestrator|worker|validator]}`。
- `WorkerRunBinding={agentId,epoch,taskId,taskRunId,inputDigest,acceptedPlanRevision}`；MVP 只绑定本地 runtime，不扩展 remote descriptor 或 permit。`bindingHistory=[{workerBinding,startedAt,endedAt?,stopEvidenceRef?}]`，不得重绑原 permit。
- `ExecutionIdentity` 为 `{kind:"task-run",taskRunId}`、`{kind:"task-validation",validationId}` 或 `{kind:"stage",stageRunId}`。这里validationId是执行开始前分配的稳定验收身份，不是事后ValidateTask决定ID。引用接受决定时统一叫acceptanceId，对应原Validation.id；receiptId对应ValidationReceipt.id。这三种ID必须使用不同领域类型，不能互换。
- `PlanWait={reason:"plan-wait",submitCommandId,askingAgentId,askingEpoch,submissionMessageId,planRevision,status:settling|stopped|uncertain|released|cancelled,decision?:accepted|rejected,continuationMessageId?,settlementEvidence?:{messageId,outboxId,epoch,eventSeq},stopEvidenceRefs:Ids,requiresExplicitResume:boolean}`。这份记录负责快接受、崩溃和 stop hold，见第 9 节。
- `ProcessIdentity={pid,processStartMarker,processGroupId,launchNonce,commandDigest,workspaceIdentity}`；`workspaceIdentity={workspaceId,machineId,canonicalPath,candidateDigest?}`。标识只证明归属，不证明 OS 隔离。
- StageSubject、CandidateManifest、StageCheck、EvidenceRef、HandoffPayload分别由第6、7节定义，并注册到同一 TypeBox registry。

`TaskInputRef={taskId,taskRevision,taskAttempt,runId,inputDigest,acceptanceId,validationId,receiptId,artifactIds,candidateManifestId,contentDigest,workspaceCommit}`，stage.taskInputs 为此数组，只引用当前已接受证据。`candidateRef:CandidateRef` 在 PR4 定义为 `{schemaVersion:1,manifestArtifactId,manifestSha256,contentDigest,provenanceDigest,workspaceCommit}`。PR5 引用固定值并核对 CAS，不用路径代替身份。`executionClaim={daemonId,ownerEpoch,validatorId,agentEpoch,claimedAt,processIdentity?}`，启动前可无 processIdentity，启动后必须记录或标 uncertain。

现有 JSON 类型扩展由使用它们的 PR 定义：PR2 的 TaskStatus 增加 cancelled；最终 Task.workflow 包含 purpose、milestoneId?、expectedOwnerRoleId、expectedValidatorRoleId、planRevision、skillRef?、preconditions、expectedBehavior、originFindingIds、originHandoffItemIds、affectedTaskIds、deliveryBinding?、candidateManifestId?、cancellation?。`deliveryBinding={runId,inputDigest,taskRevision,artifactIds,candidateManifestId}`，parity review 必须有 candidateManifestId。cancellation 存 reason、actor、removedByAcceptedPlanRevision、cancelledAt。PR2 引入除 deliveryBinding/candidateManifestId 外的字段，PR4 添加这两个输出字段及校验。everAccepted 从不可删除的 validation 历史判断，不能仅看当前状态。

PR4 的 Artifact 增加 `purpose?:delivery|workflow,taskRunId?,inputDigest?,producer?`，缺省 purpose=delivery 保持 classic。控制端 workflow artifact 的 agentId 固定保留值 system:workflow，taskId 缺省，path/snapshotPath 都指 CAS，producer存真实actor、agentId?、eventSeq，以及证据文件的executionIdentity?、inputDigest?、candidateDigest?、artifactType?、surface?。作为结构化证据时这些绑定字段必须齐全。Task 验收的 artifactIds 一律拒绝 purpose=workflow。

PR5 的 Requirement 增加 `verificationMethod,evidenceRequirements,humanStep?`，AssertionResult 增加结构化 evidenceRefs。PR4 同时引入 EvidenceRef 的 validation-command/artifact/effect 基础分支，PR5 增加 stage-command/operator-observation 及完整 Requirement 强制规则。PR4 的 ValidationReceipt 增加 `validationId?,taskRunId?,inputDigest?,candidateManifestId?,environmentRef?,environmentOperationIds?,evidenceRefs?`。validation_intents.data 增加执行身份、阶段、环境与输入绑定，见第 11.3 节。这些语义变化均参与断言/Task revision 与证据失效，不能当纯展示字段修改。

### 3.4 节点独立库与延期边界

MVP 不改 NodeJournal、node.sqlite、node-workers.sqlite、节点 descriptor 或协议。节点现状、各库与锁的只读定位见代码地图第 2.4 节。NodeJournal 的版本化迁移是未来 remote parity 的前置条件，移出 PR1 与全部六个 MVP PR；不分配 NODE_SCHEMA_VERSION，不声明本地 parity 完成节点升级。

未来 remote parity 必须另立合同：先取得 node.ownership.sqlite 独占锁，再在 NodeJournal 的 BEGIN IMMEDIATE 内校验并迁移 node.sqlite；保留既有行、拒绝不支持版本、失败回滚。节点 worker/mailbox/effect 库各有所有权与恢复边界，不能用控制库迁移或备份替代。此处不授权本期实现这些迁移。

### 3.5 升级、备份与精确恢复

控制库迁移仍位于现有 daemon owner 事务内，保留 0→旧布局→当前主线版本的升级、失败回滚、未来版本拒绝及原 outbox 恢复。classic 不回填虚构 plan、run、budget，也不启用新完成门。旧 Mission adopt 延期。

备份只增加数据库记录和已有 CAS 引用，不新增任意 home 目录。每个 PR 在引入引用的同时扩展引用遍历与备份/恢复校验；只对实际 workflow 行引用的 skill 入口、资源、脚本、报告、候选、handoff 与 evidenceRefs 强制核对 artifact ID、同 Mission、大小与 digest。被引用的必需对象缺失就拒绝恢复完成。没有 workflow 引用的 classic 备份按原规则成功，不要求 plan/skill/manifest 存在，不补造记录。

接受后的完整政策、角色与模型快照、资源 manifest、精确命令和映射都随旧 MissionPlan 保存。重启及从备份恢复后，即使全局角色、默认 effort、脚本或草稿已改变，也必须还原旧计划的准确授权。PR1 验证基础政策与角色；PR2 及以后逐步验证其所引入的完整旧计划、资源和命令引用。各 PR 实际改动当前默认、重开并备份恢复，断言旧授权不变。

正常重启仅在受控停止与结算证据齐全时保留 suspended TaskRun；其他在途执行转 uncertain。历史备份恢复时，所有非终态 TaskRun、stage、intent、environment operation 和未停止服务转 uncertain 并建 reconciliation blocker。不得自动 init、重启服务、重验、重发旧投递或续用旧 permit。node store 不在协调端备份内，不能据控制库恢复推断远端退出。

`detail()` 在 src/control.ts:5494，`exportMission()` 在 :5534。保留原 mission-control-replay-v1 外层，增加 workflowFormat:mission-workflow-v1 与完整 MVP 关系记录。它是私有审计导出，不能当可执行恢复输入；公开脱敏导出延期。

### 3.6 canonical JSON 与服务器摘要

所有新增结构化摘要统一使用 `H(domain,value)=lowerhex(SHA256(UTF8("mc:"+domain+":v1\n"+C(value))))`。domain 是下表的固定 ASCII 字符串；换领域不复用 hash。C 的实现规则如下，PR1 以纯函数和合成字节 fixture 固定它：

1. 边界先按版本化 TypeBox schema 解析并显式填默认值，拒绝额外键、重复 JSON 对象键、非有限数、undefined、稀疏数组和未配对 UTF-16 surrogate。重复键检查在 JSON.parse 丢失信息之前完成；转义后相同键也算重复。不存在的可选字段省略，显式 null 仅在 schema 允许时保留。
2. null/boolean 按 JSON 字面值输出。number 用 ECMAScript JSON.stringify 的有限数输出，-0 统一为 0；计数/revision/size 必须是安全整数，费用等允许有限小数。string 用 JSON.stringify 的双引号和转义规则，无额外空白，不做 Unicode 归一化。对象键按 UTF-16 code unit 升序排序，递归编码；禁止 localeCompare。数组保留次序。
3. schema 标为集合的数组先去歧义：重复元素拒绝，按下表主键的 UTF-8 字节升序排序；多字段键逐字段比较。正文、argv、步骤、检查顺序与日志数组保留原序。路径要求 NFC、POSIX 相对路径，无空段、`.`、`..`、绝对路径和反斜杠；拒绝大小写折叠冲突，不静默改写路径。
4. 服务器从数据库快照与实际捕获字节生成投影并重算。客户端的 expectedDigest 只作并发比较；自报 sha256/digest 必须与服务器读取的内容一致，否则 409 DIGEST_MISMATCH。模型不能给一份自造 hash 来替代内容校验。CAS、既有文件 sha256 与 diffDigest 是原始字节 SHA-256，不走 C，也不改变 classic 哈希；结构化聚合一律用 H。

| domain | 精确投影与集合排序 |
| --- | --- |
| policy、roles | 完整落库 WorkflowPolicy；或完整 RoleBinding[]（按 slot）。不含运行状态。 |
| plan | `{schemaVersion,missionId,revision,summary,sourceWorkflowRevision,submittedWorkflowRevision,contractRevision,draftSnapshots,existingTaskSnapshots,milestoneSpecs,assertionMap,commandRecipes,candidatePolicy,policySnapshot,policyRevision,policyDigest,roleBindingsSnapshot,roleBindingsDigest,environmentRef?,assetRefs}`。draft 按 draftId，existingTask 按 taskId，milestone 按 key，assertionMap 按 assertionId，recipe 按 id，asset 按 assetId/version。Task 的依赖、fulfills、origin/affected IDs 与 milestone 成员按 ID 排序。decision、materialization、createdBy/At 不进 digest。 |
| run-input | 第 3.7 节完整 RunInputSnapshot v1；集合规则按该节。 |
| recipe | 完整 CommandRecipe 去掉自身 digest，resourceRefs 按 relativePath，evidenceCapture 按 relativePath；argv 保序。exact-args 以 `{interpreter,script,args,scriptSha256,resourceRefs,environmentRef?,executionIdentity,workspaceIdentity}` 计算。 |
| environment、asset | EnvironmentSpec 的 spec 字段（不含 createdBy/At）或 `{id,version,kind,name,entrypoint,bodyArtifactId,resourceManifest,requiredTools,compatibleRoleKinds,sourceRefs,scope}`；命令/服务按 id/name，机器绑定按 workspaceId，资源按 relativePath，工具按 kind/name 或 serverId/toolName，sourceRefs 按 C 编码字节排序。 |
| candidate-content | `{schemaVersion:1,files:[{path,sha256,size,executable}]}`，按 path 排序；空文件集也显式编码。删除反映在完整文件集合中。 |
| candidate-provenance | 完整 CandidateManifest 去掉 contentDigest/provenanceDigest，再加 contentDigest；files/deletedPaths/excludedPaths 按 path，sourceTasks 按 taskId。包含 base、reviewBase、diffDigest 和 capturePolicyDigest。candidate-policy 为完整 CandidatePolicy，三个路径集合按 UTF-8 排序。 |
| stage-scope | `{schemaVersion:1,subject,milestoneRevision,contractRevision,requirementRevisions,taskInputs,candidateRef,roleBindingSnapshot,checkPlan,policyDigest,environmentRef?,assetRefs}`；taskInputs 按 taskId，requirementRevisions 为键排序对象，assetRefs 按 assetId/version；checkPlan 保序。不含 run 状态、round、结果和 assigned epoch。 |
| stage-input | `{schemaVersion:1,scopeHash,validatorBinding}`；真正 runtime epoch 单独授权，不能用新 epoch 改写旧输入。 |
| finding | `{schemaVersion:1,milestoneId,stageKind,itemId,featureTaskIds,assertionIds,severity,description,location:null|Text,failurePath}`，ID 集合排序。与 run 无关，表内仍以 run_id/fingerprint 唯一；不靠 fingerprint 自动解决跨轮 finding。 |
| stage-report | 第 6.4 节完整 StageReport v1；报告 JSON 字节为 C(report)，artifact sha256 校验实际字节，reportDigest 用 H。 |

其他结构化 payload hash 和 executionConfigDigest 分别使用 command-payload、execution-config，投影为已解析的完整请求或 EffectiveExecutionConfig。新域必须在引入它的 PR 中登记，不能另用未说明的 JSON.stringify 或拼接路径计算摘要。

### 3.7 RunInputSnapshot v1 的冻结投影

PR2 定义并将 `RunInputSnapshot v1` 与 inputDigest 原子写入 TaskRun.data。PR3 负责把同一快照渲染为可读输入包，不再发明另一套摘要。完整字段如下：

```ts
interface RunInputSnapshot {
	schemaVersion: 1;
	missionId: string;
	taskId: string;
	taskSpec: {
		title: string;
		description: string;
		acceptance: string;
		purpose: "feature" | "repair" | "support" | "milestone_candidate" | "integration";
		integration: boolean;
		milestoneId: string | null;
		dependsOn: string[];
		fulfills: string[];
		preconditions: string[];
		expectedBehavior: string[];
		originFindingIds: string[];
		originHandoffItemIds: string[];
		affectedTaskIds: string[];
	};
	acceptedAuthorization: { planRevision: number; planDigest: string; policyRevision: number; policyDigest: string; roleBindingsDigest: string };
	contract: { revision: number; assertions: Requirement[] };
	owner: { agentId: string; expectedRoleId: string; config: EffectiveExecutionConfig };
	validator: { agentId: string; expectedRoleId: string; config: EffectiveExecutionConfig };
	dependencyInputs: Array<{ taskId: string; acceptanceId: string; receiptId: string; manifestId: string; contentDigest: string; workspaceCommit: string }>;
	initialBase: CandidateBase;
	environment: { ref: EnvironmentRef; specDigest: string; resourceManifest: ResourceEntry[] } | null;
	skill: { ref: AssetRef; resourceManifest: ResourceEntry[]; requiredTools: ToolRef[] } | null;
	guidance: Array<{ ref: AssetRef; resourceManifest: ResourceEntry[] }>;
	commandRecipeRefs: CommandRecipeRef[];
	candidatePolicy: CandidatePolicy;
}
```

Task spec 来自当前已接受物化值。普通任务的 assertions 是其 fulfills 所属的完整 Requirement 快照；integration 是全部当前断言；support/repair/candidate 的 fulfills=[] 时 assertions=[]，Task.acceptance 与独立验收仍强制。dependsOn、fulfills、origin/affected IDs 按 ID，assertions 按 id、dependencyInputs 按 taskId、资源按 relativePath、guidance 按 assetId/version、recipe refs 按 recipeId 排序；preconditions/expectedBehavior 保序。PR2 未实现的 skill/environment/guidance 只能为 null/null/[]，非空引用返回 CAPABILITY_UNAVAILABLE；相应 PR 合入后才能解析真实固定版本。

admission 身份为 `{runId,ordinal,taskAttempt,admissionTaskRevision,inputDigest}`，单独存储。inputDigest 排除 Task.status、所有运行 revision（含 Task.revision）、epoch、预算计数、时间、生成状态及本轮输出/manifest/deliveryBinding。进入 running/review 的正常 revision 递增不改变 inputDigest。验收端同时校验准入快照和 review 输出身份 `deliveryBinding={runId,inputDigest,taskRevision,artifactIds,candidateManifestId}`；这里 taskRevision 为进入 review 后冻结的当前 Task.revision，必须匹配 receipt。accepted 过程保留该输出版本，不用 admissionTaskRevision 冒充 review revision。

所有实现副作用与审批消费以原 snapshot 授权，服务器重算当前有效投影再比较。语义输入变化（Task 文本/依赖/fulfills/角色、相关断言 revision、依赖接受证据、recipe、环境、skill/guidance、候选政策）使 run 失效，先停止调和，禁止沿用旧 digest。输出发布和单纯运行状态变化不属此类。

受控恢复仅可沿用原 suspended run 的原快照：必须证明旧进程停止、投递/审批/副作用已结算，且其原接受授权仍是当前任务的有效授权，当前语义投影未变；只在 bindingHistory 追加新 epoch。不把 uncertain 转 suspended。新计划若仅引用旧 Task 且全部任务级授权未变，保留 Task.workflow.planRevision 和旧 snapshot，不因 mission 当前 planRevision 增长使其失效。改变任务级授权必须先显式失效并停止旧 run，再新准入；已 accepted 任务不能隐式重开。关闭/重开 gate 不改变 digest 或授权，也不放松恢复门。

## 4. 状态机与统一准入

### 4.1 Mission 与计划等待

保留 MissionStatus 原枚举。等待接受与 TaskRun 额度用尽时为 blocked，人工 pause 仍为 paused；waitingReason 与 blocker.kind 说明具体原因。

| 触发 | 持久状态 | 后续规则 |
| --- | --- | --- |
| 运营者 start parity | active + planning | 只启动原 orchestrator 规划；不建正式 Task、不派实现、不开放通用副作用。 |
| SubmitPlan 单独调用 | blocked + awaiting_plan_acceptance，plan_acceptance blocker | 先预留 plan-wait 结算，再回复；仅该 orchestrator Harness 获结算窗口，其他工作立即停止。 |
| AcceptPlan | 记录 accepted，物化选中草稿与 budget，phase=executing | 快接受时仍 blocked，continuation 等结算和停止门；安全且无 hold 才恢复，hold 存在必须显式 resume。 |
| RejectPlan | 记录 rejected，phase=planning，不建正式 Task | 原 orchestrator 的修改输入同样等待结算；保留可编辑草稿供删除、修改和重提。 |
| RequestUserInput | 原 user_input blocker 与 blocked | 保留既有问题回答逻辑；普通回答绝不接受计划或断言。 |
| TaskRun 预算用尽 | blocked + limit blocker，Task blocked | grant 只解决对应 limit blocker，之后仍需显式 resume 和原停止证据。 |
| 阶段环境缺失或不确定执行 | blocked + workflow_validation 或原 unsafe_execution/delivery blocker | 未执行不能判产品失败。解决 blocker 后显式请求新 round，不能重放旧命令。 |
| CompleteMission | 满足原 P0 和所有新门后 completed | 见第 6.7 节。 |

新增 blocker.kind 为 plan_acceptance、workflow_validation；PlanWait.status=settling 是独立持久恢复门，即使没有开放 blocker 也拒绝 resume，见第 9.2 节。通用 `POST /api/blockers/:id/resolve` 遇 plan_acceptance 一律返回 409 PLAN_ACCEPTANCE_REQUIRED，不解决、不排队回答；已结束的同类 blocker 也不能成为普通回答入口。只有携带 expectedDigest 的 AcceptPlan/RejectPlan 能结束它。

### 4.2 执行准入矩阵

每次本地实现副作用和审批消费前都调用同一领域准入函数；所有 parity 远端派发在外层能力检查即拒绝。只在工具注册时过滤无效。trusted autonomy 不绕过 TaskRun、计划、停止或预算门。

| 主体与操作 | planning/待接受 | executing |
| --- | --- | --- |
| orchestrator 读取状态、read_file、ListWorkspaceFiles、SearchWorkspaceText | 允许受限读取 | 同样允许 |
| 草稿 CRUD、SubmitPlan、RequestUserInput、Report、WaitForMessage | 允许规划操作 | 可提出后续范围；SubmitPlan 先停止并等待接受 |
| SpawnAgent、Task 指派、批准范围内 SendMessage、ReviewHandoff、ReviewMilestoneFindings、配置 stage | 禁止实现派工；只可给原 orchestrator 规划输入 | 仅已接受计划、角色与对象范围内的协调操作，无需伪造 orchestrator TaskRun |
| worker write_file/bash/实现性 MCP/PublishArtifact/候选捕获 | 禁止 | 必须是当前 owner 的 running TaskRun，inputDigest 与计划范围一致；handoff 后、首次准入前、额度阻断后均拒绝 |
| orchestrator 通用 write_file/bash/产品修改 | 禁止 | 仍禁止；产品改动与合并由 worker TaskRun 做 |
| orchestrator 发布 workflow asset、保存计划/交接审阅 | 只允许草稿资料，不执行其内容 | 专用 handler 的 CAS 元数据操作，按计划权限；不当成产品发布 |
| orchestrator MCP 协调读取 | 禁止通用调用 | MVP不开放orchestrator通用MCP调用；合法协调只走本表专用控制工具。实现性MCP仅worker running TaskRun可用 |
| Task validator 与 stage validator 的准备、服务和检查 | 禁止 | 必须是当前 task-validation 或 stage 执行身份，按精确命令与独立性；不借 worker run |
| approval consume、本地环境 HTTP；remote parity dispatch 始终不可用 | 除原授权的精确停止与证据结算均拒绝 | 再检查 run/identity、inputDigest、acceptedPlanRevision、角色与 exact args；旧授权不因已批准而免检 |
| schedule/watchdog、手动消息、resume、节点重连 | 最多唤醒原 orchestrator 规划 | 经过同一门；不能以消息或恢复隐式新建 TaskRun |

worker 副作用的授权 payload 固定 WorkerRunBinding，增加 acceptedPlanRevision、taskRunId、inputDigest 到本地 approval 的绑定与 hash。MVP 不签发 parity remote permit。handed_off/suspended/uncertain run 不得消费实现授权。传输重试只返回旧终态证据，不再执行。协调操作有自己的 actor/command 审计；它们不能被用于执行任意 shell。

### 4.3 Task、TaskRun 与 Milestone

正式 Task 保留原状态并增加 cancelled。cancelled 仅适用于第 9.3 节运营者有限取消，classic、业务 Task、已 accepted Task 和 integration 均不能调用。完成查询的有效集合为未 cancelled 的正式 Task；草稿从来不在其中。

parity worker `UpdateTask running` 的事务先验证接受计划、真实 agent assignment、依赖 accepted、预算、唯一活动 run 和角色快照，再创建 TaskRun、增加 Task.revision，返回 run 身份。重复请求或同一仍 running 的 run 不重复扣预算。准入前必须已确定本地 owner 与独立本地 validator 的真实 Agent ID 和角色，不能先用占位身份计算输入再补指派。每 Agent 同时最多一个运行/暂停/不确定实现 run；maxParallelTasks=1 是全 Mission 准入上限。

发布绑定当前 run。进入 review 后记录 deliveryBinding；EndTaskRun success 必须已 review，partial/failure 则将未接受 Task 置 blocked。三种交接都使 run=handed_off，successState 留在 handoff；进程异常且没有交接才记 run=failed。Report 不关闭或暂停 run，系统停止事件才可将 run suspended。

`ValidateTask passed=false` 保留原 attempt 递增。受控恢复沿用 suspended run 的 ordinal，先通过旧停止门，再在 bindingHistory 记新 epoch；不能搬迁旧消息或效果。新实现、失败后重开、已接受任务失效后重做都新建 run。uncertain 占 open slot，运营者通过第 4.4 节显式 close 后才能继续。

Milestone 为 planned → executing → ready_for_validation → validating → passed；失败为 rework；blocked 保留 validating 并以 Mission blocker 暂停准入。依赖 milestone 必须 passed，阶段与业务 Task 依赖分开。Task DAG 决定就绪，默认串行；并行度>1 延期。

Stage run 为 planned → queued → running → passed/failed/blocked；配置时始终创建两类审计 run，适用 skip 的 run 在同一事务直接写 skipped 并保存政策来源，不经过 queued/running、不派发、不产生 passed receipt；输入失效写 superseded。执行不确定写 uncertain，不能自动重验。重试在旧操作已结算后创建新 round，旧记录不覆盖。同 scope 最多一个非终态 run。

### 4.4 uncertain TaskRun 的运营者 close

只有运营者可调用 `POST /api/missions/:id/task-runs/:runId/close`，请求 `{requestId,expectedStatus:"uncertain",expectedInputDigest:Digest,reason:Text,reconciliationEventSeqs:Revision[]}`，返回 `{runId,status:"closed",requiresResume:true}`。模型无此工具。PR2 同时引入 closed 状态、解析器、中央错误码和此 handler。

事务前确认 Mission 已停止派发、当前 run 确为 uncertain、摘要一致、原 epoch 的所有本地 handle 已有匹配退出证明；所有相关 validation flight、审批、工作区操作均已停止。相关 uncertain 投递和副作用必须已有运营者审阅的调和事件与已解决 blocker，核对原 message/effect/approval ID，不能只凭 reason。停止未证实返回 409 STOP_UNPROVEN；有未调和操作返回 409 RUN_UNSETTLED；状态或摘要不符返回 409 RUN_CLOSE_CONFLICT；无运营者身份为 403。

close 的 command 事务重查上述门，写 `uncertain → closed` 和 `closeRecord={schemaVersion:1,actor:"operator",requestId,reason,reconciliationEventSeqs,stopEvidenceRefs:Ids,closedAt}`，释放唯一 open slot。保留原 uncertain 消息、回执、run 输入和终止原因，绝不改成 success、handed_off 或未执行，也不补造 handoff。Task 留 blocked、预算不退。只关闭准入占位，不重放、不重绑旧投递/permit、不解除其他阻断。相同 requestId 同 payload 返回原结果，不同 payload 为 COMMAND_CONFLICT；下一次必须显式 resume 后新建 run。

## 5. 工具、提示词与结构化错误

### 5.1 工具合同

下表的 `{字段:Schema}` 是 TypeBox registry 的字段合同。所有对象 additionalProperties:false；工具 payload 上限 256 KiB，完整长日志写 CAS 后引用。模型身份来自授权上下文，不允许参数自报 missionId/agentId/epoch。未列的嵌套结构见第 3、6、7、11 节，不能用 Type.Any 代替。

| 工具 | JSON 参数 schema 字段 | 权限与返回 |
| --- | --- | --- |
| UpsertPlanDraft | `{draftId?:Id,expectedDraftRevision:Revision,expectedWorkflowRevision:Revision,task:TaskDraft}` | orchestrator；新草稿 expectedDraftRevision=0。返回 `{draftId,draftRevision,workflowRevision}`。TaskDraft 可另有 targetTaskId?，表示对未 accepted 正式 Task 的变更提案；不直接改 Task。 |
| DeletePlanDraft | `{draftId:Id,expectedDraftRevision:Revision,expectedWorkflowRevision:Revision,reason:Text}` | orchestrator；返回两个新 revision，只软删 editable 草稿。 |
| SubmitPlan | `{expectedRevision:Revision,summary:Text,contractRevision:Revision,draftIds:Ids,existingTaskIds:Ids,milestones:MilestoneSpec[],assertionMap:AssertionMap[],commandRecipes:CommandRecipe[],candidatePolicy:CandidatePolicy,environmentRef?:EnvironmentRef,assetRefs:AssetRef[],policyProposal?:WorkflowPolicy}` | orchestrator；expectedRevision 核对 workflow。返回 `{planRevision,digest,status,blockerId,workflowRevision}`；必须单独调用并 terminate。完整快照从当前记录生成，不信任客户端 hash。 |
| EndTaskRun | `{taskId:Id,runId:Id,successState:success|partial|failure,returnToOrchestrator:boolean,handoff:HandoffPayload}` | 当前 worker owner；单独调用。返回 `{handoffId,sequence,taskStatus,runStatus,nextAction,effectiveReturnToOrchestrator}`。success 且非 review 固定 409 TASK_REVIEW_REQUIRED。 |
| ReviewHandoff | `{handoffId:Id,expectedStatus:pending|reviewed,expectedRevision:Revision,decisions:HandoffDisposition[]}` | 原 orchestrator；返回 `{reviewed,handoffCursor,adoptedTaskIds,adoptedDraftIds}`。不得漏 item。 |
| PublishWorkflowAsset | `{assetId?:Id,expectedVersion:Revision,kind:skill|guidance,name:Text,entrypoint:Text,bodyArtifactId:Id,resourceManifest:ResourceEntry[],requiredTools:ToolRef[],compatibleRoleKinds:RoleKind[],sourceRefs:EvidenceRef[],scope:AssetScope,reason:Text}` | orchestrator；返回 `{assetId,version,digest}`。字段与资产持久对象完全对应；入口和资源须已在同 Mission CAS。 |
| GetWorkflowAsset | `{assetId:Id,version:integer>=1}` | Mission 成员只读；返回固定版本正文、manifest、digest 与 sourceRefs，正文截断可见。 |
| ListWorkspaceFiles | `{relativeDir?:Text,glob?:Text,limit?:integer[1,200]}` | 受当前工作区约束的只读工具；默认目录 .、glob *、limit 100。返回相对路径、类型、truncated，不读文件正文。 |
| SearchWorkspaceText | `{pattern:Text,relativeDir?:Text,glob?:Text,maxMatches?:integer[1,100],maxBytes?:integer[1,65536]}` | 只读字面文本搜索，pattern 最多 256 字符，无任意正则执行；默认 maxMatches=50、maxBytes=32768；返回路径、行号、截断片段。 |
| PublishCandidateManifest | `{taskId:Id,runId:Id,base:CandidateBase,reviewBase:ReviewBase,expectedDeletedPaths?:Text[]}` | 当前 worker owner 的 running run；按已接受 CandidatePolicy 实际捕获完整文件集。返回 `{manifestArtifactId,contentDigest,provenanceDigest,deliveryArtifactIds}`，不自动review。 |
| ConfigureMilestoneChecks | `{milestoneId:Id,expectedRevision:Revision,subject:StageSubject,checks:StageCheck[],reason:Text}` | orchestrator；选择已接受 commandRecipe，校验完整覆盖，创建两类审计 run（skip 在同事务直接 skipped，其余 planned），返回 `{milestoneRevision,scopeHash,runIds}`。不得引入新命令。 |
| AssignMilestoneValidator | `{runId:Id,expectedScopeHash:Digest,validatorId:Id,expectedAssignmentRevision:Revision}` | orchestrator，仅 planned且尚未派发；返回 `{validatorBinding,assignmentRevision,status}`。固定 agent、slot 与配置快照，见第 6.2 节。 |
| RunMilestoneCheck | `{runId:Id,itemId:Id,command:Text}` | 指派 validator，exact command 与 recipe 完全一致；返回 receipt 或 pending approval 对象，等待批准时 terminate。 |
| SubmitMilestoneValidation | `{runId:Id,expectedScopeHash:Digest,itemResults:StageItemResult[],findings:FindingInput[],summary:Text}` | 指派 validator；返回 `{runStatus,milestoneStatus,findingIds,reportArtifactId,nextAction}`，服务端生成报告，不给 validator 产品写权限。 |
| RequestMilestoneRevalidation | `{requestId:Id,priorRunId:Id,expectedPriorScopeHash:Digest,expectedCurrentScopeHash:Digest,reason:Text}` | orchestrator；同键同 payload 返回同新 round，不同 payload 拒绝。必须通过旧操作结算门。返回 `{runId,round,scopeHash,status,requiresResume}`。 |
| ReviewMilestoneFindings | `{runId:Id,decisions:FindingDisposition[]}` | 原 orchestrator；返回 `{repairDraftIds:Ids,statuses:[{findingId,status}]}`，只关联修复草稿；正式 repair Task 只能由 AcceptPlan 物化，不创建 HandoffItem。 |
| InvalidateTaskAcceptance | `{taskId:Id,expectedTaskRevision:Revision,findingIds:Ids,reason:Text}` | orchestrator；当前 blocking finding，安全停止后按传递依赖闭包失效，返回影响集合与需重验范围。 |
| PrepareEnvironment | `{executionIdentity:ExecutionIdentity,environmentRef:EnvironmentRef}` | 当前 worker run 或 stage validator；Task validator 的准备由 RunValidation intent 内部调用，不要求模型先虚构 validationId。返回 operation 摘要。 |
| ControlService | `{executionIdentity:ExecutionIdentity,environmentRef:EnvironmentRef,serviceName:Id,action:start|stop|healthcheck,instanceId?:Id}` | 对应执行身份的已接受本地服务操作；stop 必须给实例。远端 start 返回 CAPABILITY_UNAVAILABLE。 |

`ToolRef={kind:"builtin",name}` 或 `{kind:"mcp",serverId,toolName,definitionHash}`，仅引用已授予能力。目录与搜索工具默认跳过 .git、node_modules、凭据文件与环境秘密文件；拒绝逃出工作区的 canonical path、符号链接目录、二进制和超限文件。不能借 shell 或外部 rg 传入任意执行参数。

`HandoffDisposition` 为 `{itemId,action:"accept_as_task",taskId,reason}`、`{itemId,action:"accept_as_draft",draftId,draftRevision,reason}` 或 `{itemId,action:"dismiss",reason,evidenceRefs}` 的 oneOf。采纳草稿只说明下一步有责任，最终完成仍要求该草稿已物化并完成，或通过有理由的再次处置关闭；不能用未接受草稿绕过交接遗留。`FindingDisposition` 仅为 `{findingId,action:"plan_repair",draftId,draftRevision,reason}` 或 `{findingId,action:"dismiss",reason,evidenceRefs}`。plan_repair 核对草稿 purpose=repair 和 originFindingIds；不含 accept_as_task，不返回正式 Task。

### 5.2 原工具的兼容与开场白

parity 模式下 CreateTask 始终拒绝，返回 USE_PLAN_DRAFT；正式新任务只由 AcceptPlan 的物化事务创建，包括 repair、candidate、support、integration。classic 保持原 CreateTask 行为。UpdateTask 仅允许已接受范围内的 assignment 和 runtime 状态；acceptance、fulfills、依赖、角色和技能的变更先存草稿，在接受修订时应用。已 accepted 的 Task 仍禁止普通更新，先走现有契约失效或新增有证据的失效操作。

RunValidation的schema扩展为 `{taskId:Id,command:Text,artifactIds:Ids,commandRecipeId?:Id}`；classic可省略新增字段，parity必须选择已接受recipe。manifest、环境和TaskRun绑定从当前正式Task与接受快照导出，模型不能另报。ValidateTask为 `{taskId:Id,receiptId:Id,passed:boolean,evidence:Text,assertionResults?:AssertionResult[]}`；parity有契约时必填完整assertionResults及evidenceRefs。PublishArtifact在parity要求taskId，purpose固定delivery，未知purpose参数拒绝。

RunValidation 与 ValidateTask 保留任务验收主链，增加结构化证据和环境执行身份。Report 对 classic 与普通进度保持兼容；parity worker 完成运行必须 EndTaskRun。Report 不暂停、不结束 TaskRun、不接受 Task。PublishArtifact 的 nextStep 在 parity 分支必须提示“review 后单独 EndTaskRun”，替换 src/control.ts:5424–5427 现有“review 后 Report”的文案；classic 文案保留。

parity opening prompt 替换原先立即建任务/派工指令，只允许 GetMissionState、受限发现读取、草稿规划、提问和 SubmitPlan。规划期间不提示 worker 自测、部署或启动服务。执行后的输入包固定计划 revision、完整断言、TaskRun、角色模型/effort、环境、技能 manifest 与摘要，不依赖最新全局默认。

EndTaskRun、SubmitPlan、Report、RequestUserInput、WaitForMessage 必须单独调用。工具适配器把 EndTaskRun 与 SubmitPlan 加入 terminate 条件，不能只改提示词。SubmitMilestoneValidation 提交结果后 validator 单独 Report 或 WaitForMessage，不混用多工具终止 round。

GetMissionState/detail 增加 workflow、草稿/计划摘要、milestones、activeTaskRuns、budgets、pendingHandoffs、stageRuns、stageCoverage、environmentState、assetIndex、allowedActions。由服务器推导可执行动作与阻断原因，UI 不复制门控。长历史分页，limit<=100。

### 5.3 错误必须到达模型

HTTP 错误体固定 `{error:string,code:ErrorCode,details?:SafeErrorDetails}`，保留旧 error 字段。HttpError 增加受限 code，未分类旧 4xx 映射 OPERATION_REJECTED；未认证响应使用 AUTHENTICATION_FAILED；内部异常用 INTERNAL_ERROR，不能透出 stack、endpoint 或凭据。

ErrorCode 由 `src/workflow-schema.ts` 的中央 TypeBox registry 管理。每个 PR 将自己使用的码与 handler、HTTP/IPC parser 和测试原子提交；PR1 只列基础码，不枚举所有未来码。下列是最终合同所需业务码，不能因尚未合入的码提前注册空 handler。主要业务码包括 PLAN_STALE、PLAN_ACCEPTANCE_REQUIRED、PLAN_NOT_ACCEPTED、USE_PLAN_DRAFT、RUN_BUDGET_EXHAUSTED、RUN_NOT_RUNNING、RUN_BINDING_STALE、TASK_REVIEW_REQUIRED、TASK_CANCEL_NOT_ALLOWED、HANDOFF_INCOMPLETE、STAGE_SCOPE_STALE、STAGE_UNSETTLED、EVIDENCE_REQUIRED、VALIDATION_ENVIRONMENT_UNREADY、CAPABILITY_UNAVAILABLE、STOP_UNPROVEN、PLAN_PENDING_EXISTS、PLAN_SETTLING、PLAN_HISTORY_OMITTED、PLAN_KEY_CONFLICT、RUN_UNSETTLED、RUN_CLOSE_CONFLICT、COMMAND_CONFLICT、DIGEST_MISMATCH。

状态码：400 为 schema/未知字段，403 为主体或归属，404 为授权范围内不存在，409 为 revision、状态或证据冲突。capability 不可用为 409；超出大小为 413。SafeErrorDetails 只允许 `{expectedRevision?,actualRevision?,taskId?,runId?,blockerId?,requiredAction?}`；字符串有长度上限，requiredAction枚举为accept_plan、refresh_state、start_run、request_bonus、resolve_blocker、confirm_stop、resume、revalidate、report，禁止任意对象与原始日志。

本地 IPC 在 src/workers.ts:413 的错误回复扩展为 `{id,error,code?,details?}`，worker.ts:156 的 rpcRequest 解析为受限 RpcOperationError，工具包装把它输出为 `isError:true` 和 JSON 文本 `{error,code,details?}`。不可再用 new Error(error) 丢掉 code。收到旧 `{id,error}` 时兼容映射 OPERATION_REJECTED；认证信息固定脱敏。

远端 mailbox 与 src/server.ts 的错误传输保留 classic 既有行为；MVP 不扩展远端 envelope 或 workflow capability。parity 的能力拒绝发生在控制端，不能经过旧节点执行再报不支持。未来 remote parity 必须另行定义 strict envelope 兼容、持久 reply 与 fence 顺序。

所有本地 parity 出口复用白名单错误构造与既有 secret redaction。真正控制状态的 command ID 不来自错误文本。PR2 测试经 local worker IPC 到 fake provider 的实际工具结果，证明模型可区分 PLAN_STALE、RUN_BUDGET_EXHAUSTED、STOP_UNPROVEN；classic mailbox 回归继续保留，不要求其承载新增 parity 业务。

## 6. 候选、阶段验证、证据与修复

### 6.1 完整候选 manifest 与生成

`CandidatePolicy={includeRoots:Text[],excludeGlobs:Text[],requiredRuntimeInputs:Text[],maxFiles:integer[1,2000],maxTotalBytes:integer[1,104857600]}` 在计划接受时冻结。上限默认 2000 文件、100 MiB；提高已接受计划内的限额须接受新计划，MVP 仍不得超出上述硬上限。排除仅限 .git、依赖安装目录、日志与明确生成输出，不能排除实现、测试、锁文件或验收脚本。存在不支持文件类型、秘密文件或大小超限时阻塞捕获，不能静默遗漏。

`CandidateBase` 为 `{kind:"git",commit}`、`{kind:"snapshot",manifestArtifactId,digest}` 或 `{kind:"empty"}`。`ReviewBase={base:CandidateBase,diffPolicy:"full-change"}`。首次项目基础版本在开始规划时由系统只读捕获并写MissionWorkflow.initialBase及CAS；这只保存授权工作区输入，不执行产品命令。后续候选必须引用前序已核实基础，不能把实现后的版本冒充审查基线。

CandidateManifest 的完整内容为：

```ts
interface CandidateManifest {
	schemaVersion: 1;
	scope: { kind: "task" | "milestone" | "final-delivery"; subjectId: string };
	base: CandidateBase;
	reviewBase: ReviewBase;
	capturePolicyDigest: string;
	files: Array<{
		path: string;
		artifactId: string;
		sha256: string;
		size: number;
		executable: boolean;
	}>;
	deletedPaths: string[];
	excludedPaths: string[];
	sourceTasks: Array<{
		taskId: string;
		taskRevision: number;
		taskAttempt: number;
		runId: string;
		inputDigest: string;
		acceptanceId?: string;
		validationId?: string;
		receiptId?: string;
		workspaceCommit?: string;
	}>;
	diffArtifactId: string;
	diffDigest: string;
	contentDigest: string;
	provenanceDigest: string;
}
```

contentDigest 和 provenanceDigest 的固定投影及编码见第 3.6 节。manifest 和 diff 自身是 purpose=workflow，不放入 Task 的 delivery artifactIds。实际产品文件为 purpose=delivery。PR2 的 initialBase 文件快照仅是 workflow 输入资料，不算交付；PR4 捕获产品时创建绑定 TaskRun 的 delivery artifact。

PublishCandidateManifest 必须由真实捕获器枚举完整允许文件集，验证基线到当前的新增、改动、删除及实际 diff；不接受模型手填 files 作为“完整”证明。路径大小写冲突、嵌套冲突、符号链接逃逸、硬链接异常和同路径不同内容一律拒绝。git 模式枚举固定提交的跟踪文件并核对干净 owner HEAD，普通目录模式枚举已接受 includeRoots 的全部常规文件。

MVP 捕获仅在协调端本地 worktree 的当前 TaskRun 下执行，使用已有文件/CAS 与 Git 冻结原语。远端 capture、inventory、transfer 扩展均不在本期定义或实现；请求返回 CAPABILITY_UNAVAILABLE。classic 的现有远端工件链保持。

`deletedPaths` 完全由系统比较冻结 base manifest 与当前捕获文件集产生，按规范路径排序。模型参数 `expectedDeletedPaths` 只作期待值；给出且与系统集合不一致时返回 409 DIGEST_MISMATCH，不发布 manifest、不静默覆盖。

sourceTasks必须包含当前捕获Task及全部已接受输入的传递依赖闭包，旧输入必有完整validation/receipt/manifest引用，当前尚未验收Task的acceptanceId/validationId/receiptId可缺省；服务器从正式依赖和已接受历史核对，不信任模型删减。manifest.scope由正式Task purpose推导，普通任务为task，candidate为milestone，integration为final-delivery，模型不能指定别的subject。Task进入review前冻结manifest与deliveryBinding。MVP 只从本地 worktree manifest 建完整 detached 输入，不借 worker 的 node_modules；shared 和 remote-snapshot 的 parity 配置拒绝。manifest 是运行输入集合的权威，不能只捕获报告或某个修改文件。

### 6.2 触发、计划与 validator 指派

系统仅在当前计划已接受、前序 milestone passed、所有有效成员 Task accepted、交接已审阅、无活动 run 或 blocker、完整候选就绪时允许 ConfigureMilestoneChecks。worktree 中 candidate 是 purpose=milestone_candidate 的普通支持 Task，fulfills=[]，只依赖该轮成员和前序候选；最终 integration 仍只在最后运行。stage 不进入 Task DAG。

`CommandRecipe={schemaVersion:1,id,kind:"script",interpreter:sh|bash|node,script:Text,args:Text[],resourceRefs:ResourceEntry[],evidenceCapture:EvidenceCapture[],digest:Digest}` 由 PR2 定义并随计划接受冻结，PR4 接入执行。script 必须是 NFC 的 workspace-relative POSIX 路径，不能绝对路径、含 `..` 或指向符号链接；脚本必须是已捕获基础中的受管文件或 resourceRefs 中 hash 固定的资源。args 是逐项传给 argv 的字面字符串，不能经 shell 再展开。计划中的所有验收、init、服务命令均引用此类型，不保留任意 command 自由文本执行分支。

固定解释器 allowlist 为 daemon 配置的 `sh`、`bash`、`node` 三个名字，启动时由受控 PATH 解析并固定可执行文件身份。缺解释器为 CAPABILITY_UNAVAILABLE；模型不能提交路径或改 PATH。执行使用 spawn(interpreterExecutable,[script,...args],{shell:false,cwd:identityDirectory})；sh/bash 只运行固定脚本，不开放 `-c`、`eval` 或解释器 flags。允许脚本内 shell 命令，但整份脚本是接受前可审阅且逐字节冻结的授权内容，argv、环境、资源和准备步骤都纳入 exact execution plan。脚本不能给 validator 增加通用工具权限；validator 的准备后完整性检查仍强制。

`command` 字段在 RunValidation/RunMilestoneCheck/receipt 中是从 recipe 生成的显示文本，不交给 shell 解析。服务器按解释器名和每个 argv 的 JSON 字符串构造显示文本，以空格连接；调用方给出的 command 必须逐字节相同。`CommandRecipeRef={schemaVersion:1,acceptedPlanRevision,recipeId,recipeDigest,environmentRef?}`，从该已接受计划解析完整 recipe，核对 digest，不能查最新环境。命令批准绑定完整 argv 与脚本 hash。

`EvidenceCapture={relativePath,artifactType:log|screenshot|result|document,surface:command|http|cli|browser|storage|manual,maxBytes:integer[1,10485760]}`。执行内核仅捕获已接受 recipe 声明的路径，核对类型和 hash，由服务器写 identity/candidate producer。模型填的 type/surface 必须与捕获元数据相符。CommandRecipe 本体不含父 environmentRef，避免环境 spec digest 自引用；CommandRecipeRef 的 environmentRef 指向外部固定版本，按 recipeId 在该版本解析并核对同一 recipeDigest。没有合适命令时先接受新计划，Configure 不能输入替代命令。

`StageCheck={id,kind:test|typecheck|lint|code-review|user-flow,stageKind:scrutiny|user-testing,commandRef:CommandRecipeRef,command:Text,required:boolean,featureTaskIds:Ids,assertionIds:Ids,inputDependency,expectedObservation:Text}`。inputDependency 为 `{kind:"candidate",digest}` 或 `{kind:"files",files:[{path,sha256}]}`。全量测试、lint、typecheck 默认依赖完整候选。

scopeHash覆盖StageSubject、候选、Task revision/attempt/run、契约/断言 revision、检查计划、环境、技能与角色配置。`StageSubject` 为 `{kind:"milestone",milestoneId}` 或 `{kind:"final-delivery",milestoneId,finalTaskId,finalManifestId}`，后者保留 FK milestone_id 并绑定最终交付。

系统创建两类审计 run 后，对非 skipped run，orchestrator 调 AssignMilestoneValidator 指定真实 Agent ID。agent.kind 必须 validator，role/profile/effort 必须等于该 run 的 slot 快照，且不是任何被审实现、repair 或 candidate 的 owner。返回并保存 `ValidatorBinding={agentId,slot,assignmentRevision,agentEpochAtAssignment,executionConfigDigest,profileRevision,roleRevision}`，run.validatorBinding 使用该类型。agentEpochAtAssignment 仅为审计；真正开始时另存当前已授权 runtime epoch，不能用旧 epoch 授权。

只在未 queued 的 planned run 可重新指派并增加 assignmentRevision；queued 后固定 agent 与配置，改变需要结算并生成新 run。同一 validator 同时最多一个 running stage。系统先 queued scrutiny，passed 或 skipped 后才 queued user-testing。通知同事务进入原 outbox。

### 6.3 执行、环境与同范围重验

RunMilestoneCheck 先写 prepared intent，绑定 exact command、inputDigest、身份和配置；approval 等待为 approval_pending。取 executing claim 并提交事务后才启动命令。环境准备与完整性检查按第 11 节执行，结果与 receipt、intent finished、事件一致持久化。

相同 command ID 与 payload 返回原记录；executing/uncertain 不再启动。崩溃、无法证明退出或来源不明时生成 uncertain receipt 与 blocker。阶段所有命令参加原 validationFlights、process tracking、stop hold 与恢复门。不能给原命令换 ID 再执行。

RequestMilestoneRevalidation 明确带 priorRunId、旧 scope、当前 scope、reason、requestId。旧 intent、进程、approval、mailbox 和 effect 必须终结且已调和；否则 409 STAGE_UNSETTLED。事务把旧非终态 run superseded，再创建 round+1，复用 current scope 时也遵守唯一 open 索引。同 requestId 只生成一轮；reconcile/心跳不得自行增加 round。

环境阻塞解除且输入不变的模型路径为：validator 报 blocked并结束 → 运营者解决环境 blocker → 仍停止时显式 resume → 原 orchestrator 收到 durable continuation → 调 RequestMilestoneRevalidation → 指派或确认同一合法 validator → 执行新轮。运营者也可通过同形 API 在停止时请求新轮，返回 requiresResume=true，不能因此自动执行。MVP 不做后台技术自动重试。

重验从第 6.4 节持久 itemResults 选择 failed、blocked、untested、关联未解决 finding 及输入失效的 item。成功结果只有断言、命令、环境、依赖文件、证据完整且未变时才能 carried，在唯一 itemResults 中记录 sourceRunId、sourceResultRevision、receiptIds、inputDependency、reason。完整候选变化使全量检查失效；未知影响范围重验全部。Task 接受始终需要完整 fulfills，不允许部分结果接受整个 Task。

### 6.4 scrutiny 与 user-testing

scrutiny 的输入是已冻结候选、完整 reviewBase diff、feature 预期行为、断言、handoff 和固定技能。每个测试、typecheck、lint 命令为独立 item；每个 feature 另有 code-review item，需真实读取差异并留下可复现的输入提取 receipt，再提交具体 failure path。命令 exit 0 不替代审查判断。

user-testing 从正式 Task.fulfills 和契约的 verificationMethod/evidenceRequirements/humanStep 推导操作、预期、反例、证据与清理。跨 feature 检查只引用断言，不改变唯一 owner。契约要求重启持久化时必须真实重启并读取。仅 build、健康响应或源码阅读不能替代用户流程。

本期不新增浏览器执行器。需要浏览器而执行器不可用时保持 blocked，不能用 HTTP 替代 UI 断言或默默 passed；执行器选择列为“受控 droid 实跑后再定”。可用的现有项目脚本可以运行，但须明确其证明范围。

命令转录错误、工具缺失且没有实际检查结果时记 blocked，不产生产品缺陷；真实检查失败才记 failed。退出码、snapshotIntegrity、语义结果和证据都需满足。StageItemResult 为 `{itemId,status:passed|failed|untested|blocked,receiptIds:Ids,evidenceRefs:EvidenceRef[],details:Text,resolvesFindingIds:Ids}`，resolvesFindingIds 缺省 []。提交参数 itemResults 必须恰好覆盖 selectedItemIds；服务器与已核实继承项合并后写下述唯一权威结构，不能省略失败 item 或自报继承项。必需项未执行就不能 passed。

逐项结果的唯一权威是 `milestone_validation_runs.data.itemResults:StageResultSet`，由 PR5 同时交付类型、存储、report 生成与恢复测试，不从 command receipt 反推语义判断：

- `StageResultSet={schemaVersion:1,revision:Revision,items:StageResultEntry[]}`，items 按 checkPlan 顺序一一对应全部 item，ID 不重不漏。
- `StageResultEntry={itemId,status:passed|failed|untested|blocked,receiptIds:Ids,evidenceRefs:EvidenceRef[],details:Text,resolvesFindingIds:Ids,inputDependency,origin}`。origin 为 `{kind:"selected"}` 或 `{kind:"carried",sourceRunId,sourceResultRevision,reason:Text}`；carried 只能 passed，必须指源 run 的确切 itemResults revision 和同 itemId 证据。
- 创建 run 时 revision=0，全项 untested、origin=selected、空证据、details="not executed"；显式选中的 item 由 validator 提交，服务器检查 scope、独立身份、receipt/证据、继承条件后在同一 command 事务写 revision+1、finding、状态和报告引用。终态结果不可覆盖；新检查只能新 round。skipped run 也保存全项 untested 与 skip 政策，不计 passed。
- `StageReport={schemaVersion:1,runId,scopeHash,resultRevision,subject,candidateRef,contractRevision,requirementRevisions,validatorBinding:null|ValidatorBinding,policyDigest,runStatus,itemResults:StageResultSet,findingRefs:[{findingId,fingerprint}],summary:Text,createdAt}`。服务器从这次提交后的行生成 canonical JSON 并写 purpose=workflow CAS，data.reportArtifactId/reportDigest 绑定该确切版本。报告是可验证副本；重验选择只读数据库 itemResults，不能把自由文本或报告最新版本当权威。CAS 先写不可变字节，事务失败最多留下未引用对象。
- code-review item 的读取证据为系统生成的 workflow artifact，其 JSON 是 `{schemaVersion:1,kind:"stage-input-read",stageRunId,itemId,scopeHash,validatorId,agentEpoch,files:[{path,sha256,bytesRead}],diffArtifactId,readAt}`；只允许读冻结输入，完整读取所需 diff 和文件后才生成。EvidenceRef 引用该 artifact；仅有 exit 0 或 summary 不足以 passed。PR5 的受控读取工具和 handler 与此 schema 同 PR 交付。

混合 passed/failed/blocked/untested 提交后重启及备份恢复，必须按同一结果 revision 准确选择重验项、保留成功项来源并校验 reportArtifact。缺失被引用报告或证据拒绝恢复；旧 uncertain 操作未结算时仍禁止重验。

### 6.5 Task 接受时强制证据要求

`Requirement.verificationMethod` 为 command、http、cli、browser、storage、manual 的非空集合。`evidenceRequirements` 为 `{kind:validation-command|artifact|operator-observation,minCount:integer[1,100],surface?:command|http|cli|browser|storage|manual,artifactType?:log|screenshot|result|document,description:Text}[]`。新parity契约缺省verificationMethod=[command]，evidenceRequirements=[{kind:validation-command,minCount:1,description:原断言全文}]；这是最低结构化要求，不替代原验收文字的语义。所有新parity契约至少要求当前独立validation-command一份；人工要求另有 operator-observation。humanStep 为 `{instruction,expectedObservation}`，出现时必须配置人工证据要求。旧 classic 缺这些字段保持原义，不进行自动 adopt。

`EvidenceRef` 是以下严格 oneOf：

- `{kind:"validation-command",validationId,receiptId}`，必须指当前 Task validation identity 的 assigned validator、相同 Task/revision/run/manifest、exit 0、完整输入。
- `{kind:"stage-command",stageRunId,itemId,receiptId}`，仅阶段综合可用，不能替代 Task 的必需 validation-command。
- `{kind:"artifact",artifactId,sha256,artifactType,surface}`，必须同 Mission、可读、digest 匹配并绑定当前执行身份与候选。可用服务端捕获的 workflow 证据文件，但不能把它放进交付 artifactIds。
- `{kind:"operator-observation",eventSeq}`，必须解析到匹配的结构化观察事件。
- `{kind:"effect",effectId,receiptHash}`，仅补充来源；worker 自测效果不能替代独立验收证据。

AssertionResult 扩展为 `{assertionId,status:passed|failed|untested,evidence:Text,evidenceRefs:EvidenceRef[]}`。ValidateTask 在原 receipt gate 之外逐条核对 evidenceRequirements、数量、surface、来源角色、当前 revision/identity/候选、人工 decision 和 CAS 完整性。不足返回 409 EVIDENCE_REQUIRED，不写 accepted。即使 exit 0、所有文字自报 passed 且 skipUserTesting=true，也必须拒绝。检查方法与要求是契约语义字段，修改提升断言 revision 并失效相关证据。

人工观察统一由运营者 API 创建：`POST /api/missions/:id/observations`，参数 `{requestId,subject:task-validation|stage 对应的ExecutionIdentity,expectedInputDigest,candidateDigest,itemId?,assertionIds:Ids,decision:confirmed|failed|not_run,observed:Text,artifactIds:Ids}`。subject 只允许 task-validation 或 stage，不接受 task-run。task-validation identity 在 RunValidation intent 建立时已分配，独立于执行后的 Task 决定 ID；观察可在命令完成后补入，但必须仍是当前范围。

服务器验证运营者、当前identity、manifest/断言revision、相关item与证据文件，写operator_observation事件并返回eventSeq。事件payload的完整schema为 `{schemaVersion:1,actor:"operator",executionIdentity,inputDigest,candidateDigest,taskId?,stageRunId?,itemId?,contractRevision,requirementRevisions,assertionIds,decision,observed,artifactIds,createdAt}`，身份与revision由服务器补齐，历史不可编辑。普通 blocker 回答、任意文本事件或别的候选的确认全部拒绝。confirmed 仅是人工观察，failed/not_run 不能通过；独立 validator 仍要执行并提交真实任务验收回执。

### 6.6 finding 与显式修复

FindingInput 为 `{itemId,featureTaskIds,assertionIds,severity:blocking|non_blocking|suggestion,description,location?,failurePath,evidenceRefs,suggestedFix?}`。服务器计算 fingerprint。阶段遗留只存 milestone_findings；ReviewMilestoneFindings 是其唯一处置入口，不创建或借用 handoff_items。

orchestrator 先将修复写入 PlanDraft，MVP 必须接受补修计划才物化 repair Task；autoAcceptRepairs=false。finding 先关联 draft，接受后自动换为正式 repairTaskId，status=repair_planned。repair fulfills=[]，不成为第二断言 owner。独立验收 repair 后状态 awaiting_recheck，新轮 validator 通过 resolvesFindingIds 和真实 receipt 复核，才记 resolved。普通成功声明不能解决 finding。误报 dismiss 必须有独立反证和理由，保留原失败。

若 finding 否定已接受 Task 或需要改变其源码，先停止并调和所有相关操作，再 InvalidateTaskAcceptance。集合为源 Task 与反向依赖传递闭包，包括 candidate/integration。存在 open TaskRun、validation flight、effect、approval 时 409，不能在事务中杀进程。集合内 Task 置 blocked、revision+1、attempt+1、清当前 deliveryBinding，历史工件与 validation 不删。此路径复用现有 updateValidationContract 的失效方式；普通 UpdateTask 禁止修改 accepted。

repair 不依赖失效源 Task，以免互等；仅引用其旧证据。repair accepted 后原 owner 显式合入修复，接受的补修计划给原 Task 增加 repair 依赖，再发布、review、独立验证全部 fulfills。依赖按拓扑重验。已创建正式 Task 必须完成，只有第 9.3 节严格有限取消可排除；不能靠“旧 candidate 已 superseded”绕过 blocked Task。

### 6.7 最终交付与完成门

每个适用阶段必须验证最终交付。若最终 manifest 与该阶段已验证输入的完整 contentDigest 相等，可复用该阶段；只有明确文件依赖的 item 可按未变 digest 继承。内容不等或无法证明范围未受影响时，在最终 integration 的冻结提交上创建 subject=final-delivery 的适用 scrutiny 和 user-testing，保留旧里程碑历史。

历史普通 Task 的证据只核对其冻结 CAS、manifest、提交与授权来源，不与后续 integration 文件的当前字节逐一比较。parity 不进入 shared 当前源文件 hash 门；classic shared 继续原规则。验收必须覆盖 Task A、B 在各自 worktree 顺次修改同一 app.js，最终 integration 包含两份已接受提交并验证最终内容。

最终集成内容要证明包含所有有效普通 Task 的已接受提交，原全契约 RunValidation→ValidateTask 完整重跑依然必需。附加阶段检查不能代替 integration 的全断言结果。final 阶段失败同样回流 finding、失效与补修，不能在最后一轮合并后只复用旧分支的阶段通过。

CompleteMission 事务依次核实：全部有效正式 Task accepted；所有当前断言已唯一归属且 passed；worktree 的唯一 integration、依赖闭包、祖先与干净当前 HEAD；所有任务回执、manifest、delivery 文件当前有效；当前 milestone 和 final-delivery 的适用阶段 passed 或合法 skipped；handoff cursor 连续到最后且没有未物化未关闭遗留；不存在 open、repair_planned 或 awaiting_recheck 的 blocking finding；无开放 blocker/approval/在途操作；本地服务已停止或有合法接管证明。Task/阶段的 artifactIds 和“至少一个产品交付物”只接受 purpose=delivery。

skipScrutiny/skipUserTesting 只写相应附加阶段 skipped，保存范围、政策 revision 和原因，不产生通过 receipt。它们不豁免 Task 证据、契约、integration 或已有未解决 blocking finding；后改 skip 不能抹去旧失败。

## 7. 结构化交接与连续审阅

HandoffPayload 是以下固定字段对象。空数组允许，只有 whatWasLeftUndone 可为空字符串；其他文字用 Text。数组最多 100 项，path 是工作区相对路径。

```ts
interface HandoffPayload {
	salientSummary: string;
	whatWasImplemented: string;
	whatWasLeftUndone: string;
	incompleteItems: Array<{ summary: string; reason: string; evidenceRefs: EvidenceRef[] }>;
	verification: {
		commandsRun: Array<{ command: string; exitCode: number | null; observation: string; evidenceRefs: EvidenceRef[] }>;
		interactiveChecks: Array<{ action: string; expected: string; observed: string; status: "passed" | "failed" | "not_run"; evidenceRefs: EvidenceRef[] }>;
	};
	tests: {
		added: Array<{ path: string; cases: string[]; verifies: string }>;
		updated: Array<{ path: string; cases: string[]; verifies: string }>;
		coverage: string;
	};
	discoveredIssues: Array<{ severity: "blocking" | "non_blocking" | "suggestion"; description: string; suggestedFix?: string; evidenceRefs: EvidenceRef[] }>;
	skillFeedback: {
		followedProcedure: boolean;
		deviations: Array<{ step: string; whatIDidInstead: string; why: string }>;
		suggestedChanges: string[];
	};
	proposedAssets: Array<{ name: string; baseAssetId?: string; baseVersion?: number; bodyArtifactId: string; resourceManifest: ResourceEntry[]; sourceRefs: EvidenceRef[] }>;
	artifactIds: string[];
	nextAction: string;
}
```

命令与退出码是 worker 声明；没有匹配真实 evidenceRef 时标为自报，不能当独立验收。whatWasLeftUndone 非空而 incompleteItems 为空时拒绝。success 必须 review，固定 409 TASK_REVIEW_REQUIRED；partial/failure 也保存已知成果与限制。

EndTaskRun 的一个事务验证身份，关闭 run，分配 Mission 内 sequence，写 handoff/item、Task 状态、agent_report 和 outbox 通知。每 run 只能一份；相同 command 同 payload 返回旧结果，不同 payload 或另一 command 重交同 run 拒绝。成功持久化后单独 terminate。

returnToOrchestrator 显式必填。partial/failure、blocking issue、遗留、技能偏离或资产提案强制 effectiveReturnToOrchestrator=true；无问题成功可合并通知，但不丢交接。返回始终同时有 nextAction 和 effectiveReturnToOrchestrator，不能让 UI 猜其关系。

ReviewHandoff核对task_handoffs.data.reviewRevision。首次expectedStatus=pending，逐项处置后reviewRevision+1并置reviewed。采用草稿后可对尚未物化且已删除/拒绝的草稿条目用expectedStatus=reviewed再次处置，必须匹配revision并给新理由；其他已处置条目不可任意重写，cursor不倒退。ReviewHandoff每item采用已有Task、草稿或有理由驳回。零 item 仍要 decisions=[] 确认已读。采用草稿写item.status=accepted_as_draft；对应计划接受时，在同事务把它改为accepted_as_task并保存materialization引用。最终完成前检查其正式Task已accepted，或经上述再次处置有证据关闭。资产提案发布后用版本与 CAS 证据说明处理。

cursor 只能推进到从 sequence=1 开始连续 reviewed 的最大值，先审后面的不跨过缺口。stage finding 独立处理，不混入这个序列。cursor、逐项决定、actor 和理由在事务中保存，模型和 UI 无设置 cursor 工具。

## 8. TaskRun 尝试预算与 bonus

默认 base_limit=5，适用于 feature、repair、support、candidate、integration；每个正式 Task 在其首次接受计划的事务插入一行 TaskBudget。选中草稿的 attemptLimit 未提供时取完整 policySnapshot.defaultAttemptLimit，接受后冻结。后续改变默认不修改已有预算，只能添加 grant。

`used=COUNT(task_runs)`，`limit=base_limit+SUM(grants.amount)`，remaining=max(0,limit-used)。TaskRun admission 就消耗，失败、partial、无交接、模型错误、取消都不退款。受控恢复同一 suspended run、批准等待、相同 generation 重试和同 run 消息不重复计。validator 重跑不消耗 worker run，但仍受 Mission maxTurns/maxCost。

新running admission前在事务内核对预算与唯一open run，不能先启动超限尝试再阻断。合法准入的最后一次run仍可完成，remaining=0本身不撤销该run；它结束后申请下一次准入才记录额度用尽并阻断。用尽写稳定的 limit blocker，Mission blocked、Task blocked。所有实现副作用入口再次拒绝，不只拒绝下一次 UpdateTask。

运营者 `POST /api/missions/:id/tasks/:taskId/budget-grants` 参数 `{requestId,expectedRevision,amount:integer[1,100],reason}`，expectedRevision 比较 task_budgets.revision。总 limit<=1000；同键同 payload 幂等，不同 payload 409。返回 `{grant,budget:{revision,baseLimit,used,limit,remaining},requiresResume:true}`。模型没有 grant 工具。

grant 只解决该预算 limit blocker，增加预算 revision 并审计；Mission 按既有非 user_input blocker 规则进入等待显式恢复，其他阻断与 stop hold 均保留。之后 resume 仍要确认旧进程退出与效果结算。Stage 不做技术自动重试，需第 6.3 节显式请求。

## 9. 计划草稿、接受结算与有限取消

### 9.1 草稿到正式 Task

planning 不调用 CreateTask；UpsertPlanDraft/DeletePlanDraft 只操作 plan_drafts。SubmitPlan 对选中草稿和已存在正式 Task 保存完整不可变快照，校验断言唯一映射、Task/Milestone DAG、期望 roleId、固定命令/技能/环境、最终 integration 占位与候选政策。草稿依赖通过 TaskRef 解析，不需要未创建的真实 Agent ID。

SubmitPlan先核对并递增workflow.revision，将递增后的值保存submittedWorkflowRevision。AcceptPlan的同一事务核对expectedDigest、当前pending修订、契约与current workflow.revision==submittedWorkflowRevision；政策/角色PATCH不能在pending期间执行，必须先拒绝再改。根据快照建立 draft→Task ID 映射、物化 Milestone 与选中正式 Task、转换依赖和 fulfills、写每个新 TaskBudget、保存完整政策与角色快照、将采纳草稿的handoff/finding引用映射为正式Task并保留原草稿来源、记录accepted decision和materialization、冻结首次 initialFeatureCount。任何失败回滚全部，不能留下半套正式 Task。

未选中、已删或拒绝计划的草稿不物化、不参与完成。已接受快照不随草稿后续编辑变化。targetTaskId草稿只在目标未accepted、无运行中操作且新计划接受后应用，保留原Task ID与budget.base_limit。已有Task的attemptLimit提案若与已冻结base_limit不同则拒绝，不得静默忽略；提高只能grant。已 accepted Task 的变更先显式失效，禁止隐式改写。

初始/current feature 数只计正式 purpose=feature/repair；support、candidate、integration 另列。后续 repair 也必须接受计划。autoAcceptRepairs 在 MVP 固定 false。自动接受非补修计划仅来自SubmitPlan之前运营者已生效的autoAcceptPlan政策，不能读取本次policyProposal打开的值。凡包含新增repair或finding关联修复范围的计划，MVP一律要求operator接受，即使autoAcceptPlan=true也不能自动接受；不准借通用自动接受绕过autoAcceptRepairs=false。trusted不隐含自动接受。

连续 AcceptPlan 使用永久身份映射。PR2 在 plan_drafts 增加索引列 `draft_key TEXT NOT NULL`、`materialized_task_id TEXT REFERENCES tasks(id)` 和 `UNIQUE(mission_id,draft_key)`，在 milestones 增加 `milestone_key TEXT NOT NULL` 和 `UNIQUE(mission_id,milestone_key)`；data.task.key 必须等于 draft_key，Milestone.data 不再重复 key。迁移和同名约束在首次建表时一起提交。ordinal 是显示/推进顺序，不是身份。Milestone.data 由 PR2 保存 `displayRevision:1`；PR5 使用表列 revision 作为验证配置 revision。

首次接受草稿时建立 draft key→Task ID，materialized_task_id 永不清空。以后可引用其 draftId 或正式 taskId，两种方式归一成同一 Task；重复引用同任务只保留一个，冲突内容返回 PLAN_KEY_CONFLICT。同 key 新建另一草稿、未显式 targetTaskId 却用不同 key 冒指已有映射也拒绝；合法 targetTaskId 提案沿用原 Task 并单独保留提案来源。已经物化的草稿不再直接 editable 更新；变更通过带 targetTaskId 的新提案草稿，只对未 accepted 且安全停止的目标应用，不另建 Task 或 budget。原草稿映射和历史 materialization 保留。曾 accepted 的 feature/repair（含后来失效的任务）必须仍在每个后续计划的 existingTaskSnapshots 和有效完成集合，遗漏返回 PLAN_HISTORY_OMITTED；不允许靠重建 key 或省略 Task 静默删除历史工作。

Milestone 按 key upsert 到同一 ID；同 key 的不同 ordinal 仅允许在未执行阶段且不与其他 milestone 冲突时调整，否则 PLAN_KEY_CONFLICT。再次引用相同内容不增加 milestone.revision、不重置 passed、不增加 budget；新计划序号只记入 materialization 历史，不覆写未变 milestone 的授权 planRevision。改变标题/说明仅递增 data.displayRevision；stage-scope 的 milestoneRevision 对应表列 revision，仅当语义验证输入变化时递增。

成员任务及其接受证据、候选内容、断言/契约、checkPlan/recipe、环境/资源/角色、skip 政策、里程碑依赖或 reviewBase 变化时，先安全停止调和相关旧操作，再递增验证配置 revision/generation，将受影响 stage 标 superseded，milestone 转 ready_for_validation 或 rework，并向后续依赖传播。未知影响范围全部重验。纯 summary、展示标题和重复引用不失效旧结果。补修 Task 加入成员/依赖按上述规则失效；不覆盖旧报告。持续保留原有效任务的最终 integration 依赖闭包。

### 9.2 plan-wait 结算与快速接受

Accept/Reject API 为 `POST /api/missions/:id/plans/:revision/accept|reject`，请求 `{requestId,expectedDigest,reason}`。SubmitPlan.expectedRevision 核对 mission_workflows.revision；workflow PATCH 也比较这一列。plan revision 只选定快照，不可混用。

SubmitPlan 增加结算原因 `{kind:"plan-wait",agentId,submitCommandId}`。在 worker RPC 回复前预留与 RequestUserInput 相同的提问者结算窗口：仅该本地 orchestrator 的 Harness 最长保留 5 秒结算当前投递，外部操作和其他 agent 立即停止；turn-end 不算真实 settled。复用 src/workers.ts 的 question settlement、waitForLocalSettlement、queued continuation 与 stop hold，具体失败场景如下，不依赖外部测试代号。

AcceptPlan/RejectPlan 使用专用 command 事务直接保存决定与关闭 plan_acceptance blocker，绝不调用通用 resolveBlocker。立即接受可先物化，但 PlanWait.status=settling 是独立持久恢复门；waitingReason=plan_settling、Mission 仍 blocked。continuation 以原 held 机制保存 message ID 与未入队状态，不产生可派发 outbox。只有收到匹配 askingAgentId/askingEpoch/submissionMessageId 的实际 settled、原 outbox 不再 dispatching/admitted、所有相关旧 handle 已证实退出，才将 PlanWait 置 stopped。无 hold、无其他 blocker、未人工 pause/cancel 且 gate 开启时，专用释放事务使用新 owner epoch 只入队一次并置 released；否则保留 stopped + requiresExplicitResume=true。RejectPlan 同理，只恢复 planning；快速 autoAcceptPlan 走相同顺序。

结算超时、abort 未确认、worker exit 或协调端崩溃保留原 outbox/message 的 uncertain 与停止证据。已接受计划不构成 submission 已结算；旧投递绝不重发来恢复。存在 stop hold 时保留未发 continuation，运营者调和后显式 resume；无法证明旧进程退出时沿现有规则拒绝恢复。cancel 则终止 continuation。

不能把 plan_acceptance 伪装 user_input：通用 resolve 固定 PLAN_ACCEPTANCE_REQUIRED，既不解锁也不排队普通回答。只有 accept/reject 对指定 digest 生成对应 continuation。重复接受命令复用同一决定与消息；不同决定冲突拒绝。

所有恢复入口都检查持久 PlanWait：HTTP missionAction resume、模型/内部 resume、schedule/watchdog 唤醒、worker lifecycle sync、dispatchPending、releaseHeldMessages、重启恢复和新 Task admission。settling 返回 409 PLAN_SETTLING；uncertain 先过调和与 STOP_UNPROVEN/RUN_UNSETTLED 门；无开放 blocker 也不能绕过。通用 resolve 其他 blocker 不得把 settling Mission 改为 paused 或 active。stopped 在无 blocker/hold 且停止证据成立后才可由显式 resume 释放；released 不再派第二份。人工 pause 保留 hold，cancel 写 PlanWait.cancelled 并终止 continuation。

必须按可复现机制测试下列场景：

- SubmitPlan 回复前预留结算；同时到达 turn-end 只加入同一个结算 flight，不提前 fence；快速 Accept/Reject 决定已保存，settled 前 resume 和派发都拒绝。
- Harness 发出 settled 且对应 outbox 已真实结算后，停止旧 handle，再给新 epoch 释放一次；重复决定、重复 settled 和重开协调端不重复消息。
- 5 秒结算超时、只收到 turn-end、worker 在 settled 前退出、abort 未确认或实际进程退出未证实，分别保留 uncertain/stop hold 并拒绝恢复；不能将 abort ack 当进程退出。
- 停止一个 peer 失败时继续停止其他 peer，保留失败 handle 与 blocker；外部命令停止失败不因主 Harness 已 settled 而放行。
- 结算中协调端崩溃、决定已保存但 continuation 尚未入队、人工 pause/cancel 与接受并发，重启从 PlanWait 和原 outbox 还原。uncertain 投递永不重发，stop hold 只在运营者调和且明确 resume 后释放新的 continuation。

### 9.3 运营者有限取消

新增 `POST /api/missions/:id/tasks/:taskId/cancel-out-of-scope`，参数 `{requestId,expectedTaskRevision,removedByAcceptedPlanRevision,reason}`。只允许运营者，非终态 Mission，当前已接受后续计划明确移出该 Task，且 Task.purpose 为 support 或 milestone_candidate、fulfills=[]、历史上从未 accepted、无活动 run/未结算操作、没有有效任务依赖它。integration、业务 feature、repair、曾 accepted 后失效的 Task、仍在当前计划的 Task 一律 409 TASK_CANCEL_NOT_ALLOWED。

合法取消原子写 Task cancelled 与 cancellation 审计，并关闭尚未开始的派工。cancelled 支持任务不进入完成任务集合和 integration 依赖闭包，工件、run、失败与预算历史仍保留。新计划不能偷偷移出不可取消业务任务；这类范围变化需保留并完成原 Task，或取消整个 Mission。计划移出与取消是两步显式操作，未取消前仍受原完成门约束。

必须覆盖“拒绝计划 → 删除草稿 → 重提 → 接受 → 只有选中任务被创建 → 最终完成”，以及“接受新计划移出未 accepted 支持任务 → 运营者取消 → 完成”；任何取消边界不符都拒绝。

## 10. 五角色模型与 reasoning effort

slot 为 orchestrator、worker、task-validator、scrutiny、user-testing。前三种权限 kind 仍是 orchestrator/worker/validator，后两个 slot 必须 kind=validator。不同 slot 可同 profile，但独立验收仍需不同 Agent。

RoleProfile.reasoningEffort 可省略，表示采用模型支持的角色默认。解析顺序为运营者 Mission binding 请求 → RoleProfile 默认 → SDK 支持的默认；接受时把 requested 与完整 resolved 配置、profile/role revision、adapterVersion 写进计划。MVP 枚举为 off|minimal|low|medium|high|xhigh|max；reasoning=false 只允许 off/省略。不支持的值拒绝，不静默降档或换模型。

ModelProfile 新增 supportedReasoningEfforts? 与 thinkingLevelMap?，都是 profile revision 的一部分。旧 profile 不声明能力时按原默认，UI 显示“默认，能力未声明”；不能声称某等级已经生效。旧计划始终用完整 snapshot，未来改角色只影响新接受的计划，不改运行中 Agent。

`src/reasoning.ts` 统一解析与 provider 映射。当前 pi-durable AgentState.thinkingLevel 在 `node_modules/@earendil-works/pi-durable/dist/harness/types.d.ts:250`；worker.ts 的 root.configure 接收 effective thinkingLevel，createRuntimeProvider 传 thinkingLevelMap。MVP 不改远端 descriptor，classic 继续原配置合同。

运行中不换模型；idle/offline 修改也须符合当前已接受 binding。需要换配置时先停止、接受新计划并核实旧进程退出，新 run 才采用。MVP 不新增临时模型路由优先级。

fake provider 测试本地真实序列化、持久 root 重开、off、不支持值、缺省与旧计划快照；不能只测提示词含 high。

## 11. 候选环境、Task 验收身份与本地服务

### 11.1 资源与固定 init

环境规格由运营者 `PUT /api/missions/:id/environment` 写 `{requestId,expectedRevision,spec,reason}`，在 stopped、无在途环境操作时产生新不可变版本。计划必须引用其 revision 与 digest；改变命令、资源或权限要重新接受计划。

补充 `PutWorkflowResources` 工具供 orchestrator 保存有限资料，参数 `{resources:[{relativePath,encoding:"utf8",content:Text,sha256:Digest,executable:boolean}],reason:Text}`，返回 ResourceEntry[]。单请求不超过 256 KiB，实际 hash 由服务器重算，资源仅进 purpose=workflow CAS，不写产品工作区。运营者同形 API 为 `POST /api/missions/:id/workflow-resources`。PublishWorkflowAsset 的 bodyArtifactId/resourceManifest 与 init 资源均引用这些已保存对象；不要求模型借产品 PublishArtifact 冒充资源上传。

`EnvironmentSpec={initByContext:{worker?:InitSpec,taskValidation?:InitSpec,stage?:InitSpec},commands:CommandRecipe[],services:ServiceSpec[],machineBindings:[{workspaceId,machineId}]}`。`InitSpec={commandRecipeId,resourceRefs:ResourceEntry[],timeoutMs:integer[1,300000],idempotency:"workspace-version"}`。init 只引用已接受的 commandRecipe，不提供 interpreter/path 参数。只执行第 6.2 节 interpreter allowlist + 相对 script + 字面 args 的 recipe，脚本资源 digest 一并冻结；没有自由文本 shell 或任意解释器路径分支。

环境资源物化在执行身份目录下的受管子目录，校验入口与全部资源 hash。init key 包含机器、workspace identity、执行身份、环境 revision、脚本/recipe digest。同一身份已成功结果可复用，失败/uncertain 不自动重跑。本地 worker、Task 验收和 stage 各自准备。远端 parity init 固定 CAPABILITY_UNAVAILABLE。

`EnvironmentOperation.result:EnvironmentResult` 由 PR4 定义完整 oneOf，所有分支有 schemaVersion:1：

- `{kind:"pending"}` 对 prepared/approval_pending。
- `{kind:"running",processIdentity:ProcessIdentity,startedAt}` 对 running。
- `{kind:"finished",outcome:succeeded|failed,exitCode:integer,stdoutArtifactId,stderrArtifactId,snapshotIntegrity:boolean,processIdentity,startedAt,endedAt,evidenceRefs:EvidenceRef[]}`。PR4 只允许本 PR 已实现的证据分支，阶段证据由 PR5 加入。stdout/stderr 即使为空也保存 CAS；succeeded 需 exitCode=0、完整性和所需健康条件成立。
- `{kind:"uncertain",reason:Text,processIdentity?:ProcessIdentity,lastKnownPhase:Text,stopEvidenceRefs:Ids,observedAt}` 对 uncertain，不捏造 exitCode。
- `{kind:"cancelled",reason:Text,stopEvidenceRefs:Ids,endedAt}` 对 cancelled，仅未启动或退出已确认。

operation_key 为 H(environment-operation,{executionIdentity,environmentRef,workspaceIdentity,kind,serviceInstanceId:null|Id,commandRecipeRef})；同键不重复启动。result、operation 状态、事件和 receiptHash 在同一事务写入；receiptHash=H(environment-result,result)。result 不能由模型自由提交。

### 11.2 本地服务 supervisor

`ServiceSpec={name,startRecipeId,stopRecipeId?:Id,healthcheckRecipeId,port:integer[1,65535],dependsOn:Ids,workspaceId,allowValidator:boolean,timeoutMs:integer[1,300000],cleanupPolicy:"stop-on-pause"}`。默认 allowValidator=false；stage/Task 验收需要服务时必须在已接受计划设 true 并使用隔离目录。服务 DAG 拒绝环、未知依赖与未授权工作区。

MVP 只在协调端本地 supervisor 托管进程。start intent 先持久化、端口检查后启动并保留 handle，写 ProcessIdentity 与 receipt，再独立 healthcheck。端口被其他进程占用就阻塞，不杀占用者；healthcheck 必须匹配本实例身份。服务健康不等于产品流程通过。

按依赖拓扑启动、逆序停止。stop 使用原 start 授权包含的精确 cleanup，只处理已核实 instance/handle/process group；自定义 stop 也须固定 recipe，最后确认实际退出。归属不明、不确认退出或所有权丢失记 uncertain + blocker。不能 killall 或只按端口杀进程。

pause、cancel、scope 失效、协调端正常退出都停止本期托管服务。崩溃后不自动 restart，保留不确定证据并调和。CompleteMission 只检查停止或合法运营接管结果，不能在数据库完成事务里执行外部命令。

远端 ControlService start 固定 409 CAPABILITY_UNAVAILABLE，不能退成后台 bash 托管、不广告 managedServices、不建立远端服务表。classic 远端 ordinary bash 保持原行为；parity 不得借它运行远端 task、init 或后台服务。

### 11.3 Task 独立验收的完整准备顺序

RunValidation 在建立 intent 前校验独立主体、current Task review、deliveryBinding、交付文件 purpose、manifest、接受计划与 exact command。随后分配稳定 `validationId`，创建 task-validation identity 并提交持久 intent。验证环境无需模型预先猜 identity。

PR4 迁移给既有 validation_intents 增加 data 列。旧行默认读取 kind=legacy，classic仍走原流程：

```sql
ALTER TABLE validation_intents ADD COLUMN data TEXT NOT NULL
  DEFAULT '{"schemaVersion":1,"kind":"legacy"}';
```

新 parity data 为 `{schemaVersion:1,kind:"task-validation",validationId,taskId,taskRevision,taskAttempt,taskRunId,inputDigest,candidateManifestId,environmentRef?,phase,exactCommand,commandRecipeRef,environmentOperationIds:[],approvalId?,executionClaim?,createdAt,updatedAt}`。phase 为 allocated、directory_ready、preparing_environment、environment_ready、checking_inputs、executing、finished、uncertain；原 intent status pending/terminal/aborted 继续适用，无法确认结果写 uncertain。迁移 helper 在缺列时加列，不在重开时重复 ALTER。

执行顺序固定为：

1. 提交 intent 与完整 execution plan，包含准备 recipe、资源、最终命令、工作区和候选 digest。approve autonomy 对这份 exact plan 批准，消费前再核对全部绑定；不只批准主命令后暗换 init。
2. 创建 detached worktree 或完整 manifest 冻结目录，验证全部产品输入和删除语义，不复用 worker node_modules。
3. 物化已接受环境资源，在该 task-validation identity 下执行 taskValidation init、必要本地服务和依赖安装，逐个保存 EnvironmentOperation。validator 仍无通用写文件工具。
4. 核对准备后 tracked/manifest 产品输入未变；允许的 node_modules、临时输出必须在固定非产品目录，改变源码、测试或锁文件就 snapshotIntegrity=false 并停止。
5. 执行原 exact acceptance command，再次检查完整性，保存真实 stdout/stderr/exitCode、环境 operation ID、execution identity、artifact capture 与 receipt。ValidateTask 之后才决定接受。

准备失败记 VALIDATION_ENVIRONMENT_UNREADY，Task 留 review，不能当产品失败增加 attempt。准备的副作用不确定则按原 effect/validation 恢复阻断，不自动再次安装或启动。环境调和后新的显式 RunValidation 可以建立新 identity；旧不确定操作未结算前拒绝。

必须测试“本地 worker worktree 已装依赖且自测通过，独立冻结验收目录没有依赖”：独立验收先真实准备再运行；准备不可用则明确 blocked，而不是拿 worker 自测 receipt 接受。

Stage 的 environment identity 为 stageRunId，采用同一准备/完整性内核。worker、task-validation、stage 三类操作不互相借成功 receipt。EnvironmentOperation.executionIdentity 与 Artifact.producer 的执行绑定必须一致。

### 11.4 skill 发布与输入冻结

skill 的 entrypoint 固定 SKILL.md，resourceManifest 包含正文与所有相对资源，requiredTools、compatibleRoleKinds与发布工具参数逐字段对应，compatibleRoleKinds必须非空且只含三类既有权限kind。发布前验证资源可读、hash、类型、路径、总大小，scope 与当前权限兼容；不能靠 skill 给自己增加 MCP 或 shell 权限。

TaskDraft.skillRef 在接受计划时冻结 assetId/version/digest，运行输入包包含正文或可读固定引用及 manifest。每个 run 保存第 3.7 节 RunInputSnapshot v1 与 inputDigest，不对整个可变 Task 对象取 hash。发布新版本只供未来接受的计划使用，不替换当前 run。worker 通过交接 proposedAssets 提案，orchestrator 审阅后发布。

MVP guidance 同样固定版本只读。knowledge 自动写入、索引、过期推断延期；历史操作授权始终以控制记录为准，资料中的“已授权”不能赋权。

## 12. 远端协议与延期的协议 4

### 12.1 MVP 职责

全部 parity 控制与执行在协调端本地；创建、配置、指派、start/resume、Task admission、validator admission 和环境入口都复查 local + worktree。shared、远端 workspace/task/validator/service、远端 capture/inventory 或协议扩展统一 409 CAPABILITY_UNAVAILABLE。跨六个 PR 不存在要求实现 remote parity 的验收条款。

classic 的协议 3 workspace-effects、mailbox、permit、冻结上传与 remote-snapshot 验收继续使用原合同。MVP 不增加 workflowContractVersion、managedServices、新 effect 方法或节点 schema 版本。不支持的 parity 配置不能偷偷降级或走普通 bash。已有未结算的 classic effect/permit/投递仍按原门控调和，不能因新增 parity 分支而重绑。

未来 remote parity 需先补齐 NodeJournal 版本化迁移、完整 descriptor/permit/receipt、inventory/capture schema 与真实停止/恢复验收，再单独进入实现。

### 12.2 协议 4 的前置兼容审计

协议 4、managedServices、远端服务租约与 supervisor 清理全部延期，不在 MVP 注册方法、广告 capability 或预建表。后续需要集中新 schema 与完整升级/降级策略，先审计以下硬编码点：

| 现有位置 | 后续版本的兼容前置条件 |
| --- | --- |
| `src/machines.ts:8`、`:136` | NODE_WORKSPACE_EFFECTS_PROTOCOL_VERSION=3 与严格 capability 解析不能只改常量就接受所有新版本；明确同时支持的版本/能力组合。 |
| `src/control.ts:905` | remote artifact 授权硬检查 protocol!==3；未来按已协商的 artifact 能力与受支持协议集判定，同时保留旧协议3绑定验证。 |
| `src/control.ts:3576` | PublishArtifact 派发硬检查 protocol!==3；与 transfer、TaskRun、approval、receipt parser 同步，不把新协议自动当旧协议。 |
| `src/node.ts:548` | capabilities 根据 executionMode 输出协议号；旧模式继续输出3，只有真实实现4能力才输出4。 |
| `src/node-worker-spec.ts`、`src/remote-rpc-methods.ts`、`src/node-effects.ts`、`src/node-effect-executor.ts` | 版本集、strict keys、method allowlist、descriptor hash 与 exact permit 分别审计；不把service操作归类普通不授权RPC。 |
| 对应 machines/node-runtime-protocol/remote-effects/remote-artifacts tests | 保留旧协议3回归，并加3↔4拒绝/协商、旧capability省略、停止与重连矩阵；搜索 `rg -n 'protocol|NODE_WORKSPACE_EFFECTS_PROTOCOL_VERSION' src test acceptance/remote-linux` 重新清点全部字面比较。 |

MVP 无远端托管服务，因此不承诺远端服务崩溃清理或租约续租。现有 runtime 的 controlled stop、mailbox 与 effect 停止证明仍完整保留。

## 13. 最小中文 UI 与 API

UI 继续 `public/app.js:1020` 的 3 秒轮询，后台刷新保留输入与展开状态；SSE 不在 MVP。服务器返回 allowedActions 和具体错误，前端不复制计划、预算或完成规则。

| 区域 | 必须呈现与操作 |
| --- | --- |
| Mission 顶部/创建 | feature gate 未开不展示 parity 创建；开后 UI 默认 parity，API缺省classic。显示 planning、等待接受、预算阻断、停止未确认的具体原因。 |
| 计划 | 草稿编辑/删除、不可变快照、断言映射、精确命令、资源、五角色effort、预算、skip、接受/拒绝及digest冲突。拒绝不留下正式Task。 |
| 任务与预算 | 正式Task与草稿分开；Task验收轮次和TaskRun准入次数分别显示；grant与有限取消只给合格运营者操作。 |
| 交接 | 已完成/遗留、证据、技能反馈、逐项采纳/驳回、cursor缺口、未物化遗留。 |
| 验证 | 两类阶段、validator绑定、round、候选/最终subject、item receipt、继承来源、finding、显式重验与人工观察。 |
| 环境与交付 | 本地服务实例、准备记录、停止证明、候选完整manifest、最终contentDigest；远端服务明确不可用。 |

所有 mutation 继续使用现有认证、同源 Origin 与 X-Requested-With，错误409保留用户输入并加载新revision，不自动重试。按钮有标签、焦点恢复、键盘可用，failed/blocked/skipped 不只靠颜色区分。

新增读接口为 `/api/missions/:id/workflow`、`.../plans`、`.../drafts`、`.../handoffs`、`.../validation-runs`、`.../environment`，列表 after/limit<=100。详情返回第3节对应记录和权威 revision。模型与运营者写接口复用同一领域函数；运营者 actor 独立审计，不能冒充模型。

workflow PATCH `{requestId,expectedRevision,changes,reason}` 只在 stopped 且无待结算操作允许；expectedRevision 比 workflow revision。changes 只允许完整 WorkflowPolicy、roleBindings提案和environmentRef，MVP延期字段的非默认值拒绝。计划接受前这些是运营者配置，已有接受快照不回写。

草稿 HTTP 与工具同形；accept/reject、grant、有限取消、观察按专节接口。stage assignment、finding review、retry 分别使用 `.../validation-runs/:runId/assign|findings/review|retry`，参数遵循第5节；HTTP另带requestId。handoff review 为 `.../handoffs/:handoffId/review`。stopped状态能记录运营者决定，但不因此派工。

## 14. 最小审计、导出与统计延期

沿用 events.seq、commands、outbox、generationAdmissions/Denials 和现有 usage。新增类型化事件包括 plan_draft_changed、plan_submitted/accepted/rejected、task_materialized/cancelled、task_run_admitted/ended、task_budget_exhausted/granted、handoff_submitted/reviewed、stage_assigned/finished/retry_requested、finding_disposed/resolved、task_acceptance_invalidated、candidate_published、environment_operation_finished、service_state_changed、operator_observation、workflow_asset_published。

事件 data 只含当前动作需要的 actor、原因、相关 plan/task/run/receipt、inputDigest 与 revision。不另建日志权威或 usage sample 表。当前 agent_usage 是每 Agent 的累计费用，不能逐条相加；未知价格保持 unknown。缺 token、精确provider调用时长或无法归属run的数据写“不可用”，不从压缩转录猜数。

私有完整 export 增加 MVP关系和 schema版本信息，仍是审计材料。公开脱敏导出、运行统计新表和对照实验统计工具延期；MVP不提供一个以正则扫描为充分脱敏证明的发布按钮。仓库内只放合成fixture，不提交原始转录、运行中数据库、凭据或用户业务记录。

## 15. 行为测试与验收入口

### 15.1 测试层与必测场景

沿用 node:test、test/*.test.mjs、从 dist 导入；执行 `npm test`，另跑 `npm run typecheck` 和 `npm run lint`。只改文档的本次修订不声称已运行新增功能。每个实现PR新增可观察行为断言，保留classic P0回归。

| 类别 | 必须证明的行为 |
| --- | --- |
| 迁移/恢复 | 控制库按第19节逐PR原子升级、未来版本拒绝、重复启动、不隐式建表；各PR的实际授权在全局配置变化、重启及备份恢复后精确还原；classic无workflow引用恢复成功；本期不改节点版本。 |
| 计划 | 拒绝→删草稿→重提→接受→最终完成；只有选中草稿物化；pending不产生Task；有限取消的每条边界；计划blocker resolve固定409且不排回答。 |
| 结算 | SubmitPlan回复未settled时立即接受；正常settled后新epoch只续一次；结算中崩溃保留uncertain；stop hold、manual pause、快速拒绝；超时、提前退出、abort未确认、peer停止失败，按第9.2节具体场景；不得重发旧投递恢复。 |
| 准入/预算 | 首次admission前、handoff后、额度用尽后的本地write/bash/MCP/approval全部拒绝；parity remote dispatch一律能力拒绝；同命令不双扣；grant只解limit，停止未确认仍409。 |
| 模型/错误 | 五slot固定配置、effort可省略、本地真实序列化、旧计划快照；local IPC到模型的错误code/details完整且脱敏；classic远端传输回归保持。 |
| 交接/skill | 单独terminate、success非review固定码、幂等、游标缺口、草稿采纳未物化阻止完成、版本manifest与所需工具不赋额外权限、受限发现工具输出上限。 |
| 候选/环境 | 完整文件集合、基线、删除、diff、大小写冲突、缺文件拒绝；workflow产物不能交付；Task环境先建目录再准备和完整性检查；worker依赖不能借给协调端验收。 |
| 阶段/修复 | 指派真实独立validator，固定slot/config；同scope环境阻塞解除后模型显式retry；旧操作未结算拒绝；新round幂等；finding不进handoff；失效闭包与重验。 |
| 证据/完成 | 普通回答/文字自报/缺指定证据即使exit0和skipUserTesting仍拒绝Task；人工观察绑定当前Task validation；最终合并内容改变必须补适用阶段，且保留全契约独立验收。 |
| 本地服务/UI | 端口占用不误停、handle身份、清理阻塞完成、远端start明确不可用；3秒刷新保留表单、状态转义、键盘操作和409反馈。 |

### 15.2 复用现有 Linux runner

在 `acceptance/remote-linux/run.mjs` 增加 parity mock 场景，复用另一并行工作提供的 `--backend local-process`。不新建第二套 acceptance/mission-parity runner，不复制内存控制面。scenario planner 放 `acceptance/remote-linux/scenarios/mission-parity.mjs`，沿用 mock.mjs 的真实 transcript、工具结果和动态 ID。

新增场景至少包括 parity-plan-reject、parity-budget、parity-handoff、parity-environment、parity-revalidation、parity-final-binding、parity-evidence、parity-plan-settlement。每个 parity 场景走真实 HTTP、SQLite、本地 worker IPC、CAS、本地进程和 worktree，只替换模型为 fake provider；不创建远端 parity node。classic 的 node/mailbox 场景单独保留。角色识别用显式role slot，不再仅以是否有bash判断validator。

后端与相应scenario合入后，Linux直接运行以下命令形状；在handler未合入前不宣称这些命令当前可用：

```sh
npm test
npm run typecheck
npm run lint
node acceptance/remote-linux/run.mjs --backend local-process --scenario parity-plan-reject --keep
node acceptance/remote-linux/run.mjs --backend local-process --scenario parity-revalidation --keep
node acceptance/remote-linux/run.mjs --backend local-process --scenario parity-final-binding --keep
```

local-process证明协议、进程、独立目录和冻结副本，不证明容器隔离。平台权限、进程清理与已有故障场景差异见代码地图第5、6节。缺本地进程控制能力就明确失败/不支持，不能换成只调用ControlPlane。

### 15.3 本地真实验收与延期实验

云端先取得build、普通测试、Linux mock与服务清理证据。编排者本地另用Apple Container和真实模型验收实际规划、交接、scrutiny、可执行user-testing、修复与最终交付；静态检查或mock通过不能写成真实模型通过。需要浏览器但无执行器时结果blocked。

droid对照实验延期，需另行授权与预算；未来同合成题目、基线、模型、工具与独立隐藏验收比较完成、通过、轮数、耗时、费用、人工介入和交付质量，不使用用户既有记录。

## 16. 受控 droid 实跑后再定的问题

| 未确认问题 | MVP固定规则与可调整位置 |
| --- | --- |
| 默认两类验证的具体顺序与内部计划 | MC采用scrutiny后user-testing；检查计划和kind版本化，不能宣称已还原厂商内部协议。 |
| 真实尝试扣减、恢复旧session、bonus含义 | MC按准入计5次，受控恢复不双扣；countingPolicy留版本，不回写旧账。 |
| EndFeatureRun与审阅游标的崩溃语义 | MC一run一交接、连续cursor、SQLite事务与原outbox恢复。 |
| 浏览器QA的执行器与工具契约 | 本期不新增；缺执行器blocked，受控droid实跑后再定，不成为MVP完成的隐含依赖。 |
| init/services是否框架托管、技能资料如何更新 | MC明确固定recipe、固定版本、仅本地supervisor；远端服务与knowledge自动化延期。 |
| 自动接受补修、并行度、范围增长政策 | MVP autoAcceptRepairs=false、maxParallelTasks=1；以后经集中政策与迁移审查开放。 |

未知答案不降低P0，也不阻塞已经明确的MVP规则。延期项需要新设计与验收，不能在功能PR顺手开启。

## 17. 风险、回退与 README 影响

风险集中于草稿误入正式集合、审批后的 scope 漂移、计划回复结算丢失、阶段与最终内容不一致、验收环境借用、人工证据泛化和有限取消被扩大。第3–12节分别给出强制边界和行为测试。

上线失败时关闭 gate，停止新建和新 admission。安全停止与调和后保留当前主线 schema，用支持该版本且关闭 gate 的构建回退。schema10 程序不能打开升级库。需要旧构建时用独立 home 的完整升级前备份，不拼接数据库、不重放消息。MVP 不升级节点库。

实现PR需要改README的具体句子与内容：

- “Each started mission creates one orchestrator”之后区分classic立即执行与parity仅规划，说明草稿在接受事务才成为Task。
- “After self-checks and PublishArtifact ... before Report”保留classic，parity改为review后单独EndTaskRun；工具单独调用名单加SubmitPlan与EndTaskRun。
- “Resolve a blocker through POST .../resolve”补plan_acceptance例外、409 PLAN_ACCEPTANCE_REQUIRED和专用accept/reject，不排普通回答。
- “Missions with resolved blockers remain paused until explicitly resumed”保留通用语义，解释计划快决定的held continuation与stop hold；TaskRun grant只解limit后显式resume。
- “Turn and cost limits block the mission”之后补TaskRun预算也blocked；不把新增额度写成自动恢复，不混用Task.attempt与TaskRun。
- 验收段补manifest完整输入、Task验证环境准备、结构化evidenceRequirements/人工identity、purpose=delivery和最终阶段绑定；两个skip不豁免这些门。
- 模型段补五slot、可省略requested effort与已冻结resolved配置；环境段明确仅本地supervisor、远端服务与浏览器执行器未提供。
- 升级段按第 19 节写控制库逐 PR 版本与锁内迁移，节点版本化延期；补 MC_ENABLE_MISSION_PARITY=1 与关闭后已有 parity 的读状态/恢复保护。UI 说明 3 秒轮询，统计新表与公开脱敏导出延期。

## 18. MVP 模块与串行 PR 合同

### 18.1 模块边界

| 模块 | 唯一职责与最小公共钩子 |
| --- | --- |
| src/workflow-schema.ts | TypeBox registry、MVP DDL、数据库解析与错误envelope；无网络/shell。 |
| src/mission-plans.ts | 草稿、不可变计划、接受物化、有限取消、policy/revision与admitWorkflowWork。 |
| src/task-runs.ts | run准入、budget/grant、当前绑定和实现副作用gate，不计generation费用。 |
| src/handoffs.ts | EndTaskRun、item、连续cursor，不处理stage finding。 |
| src/workflow-assets.ts | skill/guidance、资源CAS、固定输入包；无knowledge自动化。 |
| src/reasoning.ts | 五 slot 解析、effort 能力与本地 provider 映射、完整快照；远端 parity 延期。 |
| src/mission-environment.ts | 固定init、本地supervisor、environment identity、精确清理。 |
| src/validation-execution.ts | 复用原验证intent/process tracking的目录、准备、完整性与命令执行，不判断产品通过。 |
| src/milestones.ts | 候选manifest策略、stage计划/指派/重验、finding、最终绑定与完成投影。 |
| src/workflow-observability.ts | 最小detail/export与事件投影，不加统计表，不做公开脱敏导出。 |
| src/control.ts | 唯一授权、事务、command/outbox、原Task/契约/approval/恢复边界与短handler接线。 |
| src/worker.ts、src/prompts.ts、src/workers.ts | 同一schema工具、终止、模型输入、结构化IPC错误、plan-wait结算与handle。 |
| 节点与 mailbox/effect 模块 | MVP 只做 classic 回归，不新增 parity handler、descriptor、协议或节点迁移。 |
| src/server.ts、public/app.js | 薄API、静态白名单和最小中文UI，消费allowedActions。 |

领域模块不各自创建outbox、BEGIN或绕开授权；ControlPlane统筹一个command事务。阶段与修复需要的纯策略放领域模块，外部命令只由执行内核启动。公共接口由负责该行为的 PR 与 handler、迁移和测试一起交付；未实现 handler 不注册工具。

### 18.2 PR1：可独立验证的基础合同

目标是为后续 PR 提供最小可读写、可升级、可恢复的基础；[PR1 实施 brief](pr1-foundation.md)是本节的操作展开，业务以本文为准。

- 包含控制库 10→11、mission_workflows 基础 data v1、Id/Revision/Digest、WorkflowPolicy 的请求/存储边界、五 slot 的 RoleBinding/EffectiveExecutionConfig 快照解析、canonical JSON/H、中央基础错误 envelope、daemon 环境 gate 和基础 backup/export 支持。
- 不包含其他 workflow 表、Task/TaskRun/计划/阶段 handler 或完整未来请求类型，不新增节点版本、远端协议和 UI；不注册无 handler 的工具。gate 开启也不得访问尚未实现的能力。
- 文件责任为 workflow-schema.ts、contracts.ts 的最小公开读类型、control.ts 的锁内迁移和启动 gate、backup.ts 的实际基础记录解析、workflow-observability.ts 的最小私有导出字段，以及迁移/备份测试。gate 的薄读状态可接 server.ts；不改变 classic 调度。
- 前置为主线 control schema10；仅本 PR 分配 11。fixture 是基础 workflow 行的完整政策和五角色快照，不伪造 MissionPlan。修改当前默认后重开/备份恢复，原 policy/role/config 字节与 digest 不变；无 workflow 引用的 classic 旧备份成功。
- 验收为 0/10→11 原子升级、失败回滚、未来版本与锁冲突拒绝、重开不重复迁移、canonical 字节向量与域分离、非法政策统一 409、默认关闭、既有 parity 行 gate 关闭仍可读且不可执行。
- 运行迁移、基础 schema/digest、backup/owner、gate 行为测试；实现 PR 执行 npm test、npm run typecheck、npm run lint。README 写当前只交付基础、功能未开放、控制库升级与回退，不宣布全部 MVP 完成。

### 18.3 PR2：计划、准入与安全恢复

目标是接受计划后才物化，准入和恢复都受持久证据约束。

- 包含 initialBase 的系统只读捕获、草稿/计划/连续接受、milestone 稳定身份、有限取消、budget/grant、TaskRun 与 close、RunInputSnapshot v1、CommandRecipe/CandidatePolicy 的接受授权、五 slot effort、结构化本地错误、plan-wait 与全 resume 门。
- 存储所有权为 plan_drafts、mission_plans（含 one_pending 索引）、milestones 基础 data v1、task_budgets/task_runs/task_budget_grants；MissionWorkflow data v1→v2。milestone data v1 仅有 title、description、dependsOn、memberTaskIds、planRevision、policySnapshot、displayRevision、createdAt、updatedAt；不预建阶段表或空 stage handler。Task cancelled/workflow 语义字段和关闭记录也由本 PR 定义。
- initialBase 在 start 启动 orchestrator 前捕获：只读枚举干净本地仓库固定 HEAD 的产品文件，写 `{schemaVersion:1,commit,files:ResourceEntry[]}` 的 workflow CAS base manifest，服务器核对每个 blob；initialBase={kind:"git",commit}，initialBaseManifestId 指向它。失败不启动规划。完整候选捕获仍归 PR4。
- 文件为 mission-plans、task-runs、reasoning、workflow-schema/control/worker/workers/prompts/server；接入 CreateTask 拒绝、UpdateTask running、本地 write/bash/MCP/approval、missionAction 与 dispatchPending。不改 remote permit 或 mailbox。
- 前置 PR1 已合入 schema11，由主线分配下一控制版本，包含本 PR 全部迁移。往返 fixture 为接受计划、稳定草稿/里程碑映射、预算、run snapshot、PlanWait 和 close 审计；更改当前默认后精确恢复旧授权与 inputDigest。
- 验收覆盖拒绝删稿重提、只有选中草稿物化；第二次引用不重复 Task/budget、不重置 passed、历史 feature/repair 不可遗漏；pending 竞争仅一个成功；purpose/integration 一致；正常 review revision 不改 inputDigest；语义变更拒绝旧准入；close 仅释放槽位且旧 uncertain 证据不变。
- 按第 9.2 节的具体结算场景测试：回复前预留、快速决定、turn-end 不算 settled、超时、worker 提前退出、abort/exit 未确认、peer 停止失败、崩溃和人工 pause/cancel。所有 resume/派发入口守 PlanWait，绝不重发旧 uncertain 投递。
- 本地 fake provider 必须实际收到 PLAN_STALE、RUN_BUDGET_EXHAUSTED、STOP_UNPROVEN。保留 classic outbox/owner/limit/remote 回归。README 更新规划、gate/能力边界、blocked/resolve 例外、grant/close 与显式恢复、次数口径和 effort；parity 仍仅合成测试使用。

### 18.4 PR3：交接、资源与输入包

目标是交接可审阅，资料可固定，输入包忠实展示 PR2 快照。

- 包含 EndTaskRun、handoff/item/cursor、PutWorkflowResources、Publish/GetWorkflowAsset、skill/guidance manifest、ListWorkspaceFiles/SearchWorkspaceText 与 RunInputSnapshot 的模型输入包。finding review 留给 PR5。
- 存储所有权为 task_handoffs、handoff_items、workflow_assets；新增完整 HandoffPayload/Disposition、资源/资产工具及返回类型，扩展实际 CAS 引用备份遍历。不得重定义 PR2 snapshot digest 或把资产变成工具授权。
- 文件为 handoffs、workflow-assets、workflow-schema、worker/prompts/control 的 Report/terminate/detail/CAS 钩子；前置 PR2 的实际主线版本，再分配下一版本，禁止预占数字。
- 往返 fixture 为乱序已审阅交接、未物化草稿遗留、旧 skill 版本及完整资源；恢复后 cursor 缺口和旧正文/所需工具不变。测试 success 非 review 固定码、一个 run 一份、nextAction 与 effectiveReturnToOrchestrator 同时返回、采纳草稿不能绕完成门、路径与限额拒绝、资源自报 hash 不符拒绝。
- 不含 knowledge 自动化、阶段 finding、环境执行或浏览器。README 更新 EndTaskRun、审阅与固定输入说明，classic Report 保留。

### 18.5 PR4：本地候选、环境与独立 Task 验收

目标是冻结完整产品，在独立目录准备并真实验收。

- 包含 CandidateManifest/CandidateRef、基线/diff/系统 deletedPaths、detached 输入、本地 init/supervisor、EnvironmentResult、Task validation identity/intent.data、receipt 与 deliveryBinding、purpose=delivery。
- 存储所有权为 environment_specs/operations/service_instances、validation_intents.data 迁移、Task/Artifact/ValidationReceipt 输出字段；Milestone data v1→v2 添加 candidateManifestId?/candidateDigest?。候选/日志/result JSON 全部类型与 CAS 校验在本 PR 完整定义，不放任意 result 对象。
- 文件为 milestones 的捕获部分、mission-environment、validation-execution、control.runValidation/publish、workflow-schema/backup；前置 PR3 实际主线版本，再分配下一版本。MVP 不改 NodeJournal/remote capture，不为阶段空建表。
- 往返 fixture 为含新增/删除/执行位的完整候选、exact recipe、环境成功/失败/uncertain 结果与 validation intent；恢复后能还原候选与审批 exact plan，在途操作隔离且不自动执行。
- 测试错误基线/缺文件/路径冲突/expectedDeletedPaths 不符拒绝、任意解释器路径或 -c 绕过拒绝、shell:false argv、准备后产品完整性、本地 worker 已有依赖而独立目录需重新准备、准备失败不判产品失败、服务端口归属/停止证据、workflow artifact 不交付。shared/remote parity 均 CAPABILITY_UNAVAILABLE，classic snapshot/worktree/backup 保留。
- README 更新本地 worktree 边界、冻结输入、验收环境、本地服务和 recipe 授权。

### 18.6 PR5：阶段结果、finding 与最终交付

目标是两类阶段和修复闭环能在重启后准确继续。

- 包含 MilestoneValidationRun/CheckIntent/Receipt/Finding、StageResultSet/StageReport、stage 输入读取回执、指派、scopeHash、显式重验、证据/人工观察、失效传播与最终完成门。
- 存储所有权为 milestone_validation_runs/check_intents/check_receipts/findings，Milestone data v2→v3 添加 checkPlan 和 validationGeneration；Requirement/AssertionResult 的证据语义与相关旧数据默认兼容在同 PR 交付。前置 PR4 实际主线版本，再分配下一版本。
- 文件为 milestones、validation-execution、workflow-schema、control.validateTask/completeMission 与观察/读取 API；finding review 只关联 repair draft，AcceptPlan 才物化正式 Task。不实现自动接受补修、后台重试、远端或浏览器执行器。
- 往返 fixture 为同一 run 的混合逐项结果、reportArtifact、carried 来源和 unresolved finding；提交后重启及备份恢复，准确选择失败/阻断/未执行项，保留未失效成功项，CAS 缺失拒绝。报告不能替代唯一数据库结果。
- 测试旧操作未结算拒绝重验、同 scope 显式 retry 幂等、独立 validator 与固定角色、skip 创建审计 run 直接 skipped、不计 passed；finding 不建正式 Task/handoff；证据不足即使 exit0+skip 仍拒绝；连续计划改变语义输入精确失效。
- 最终 A/B 同文件变更与 integration 内容变化必须补适用阶段，始终保留 purpose/integration 双字段和全契约 RunValidation→ValidateTask、祖先闭包与当前输出 revision。README 更新阶段、证据、finding/修复、重验与最终完成门。

### 18.7 PR6：中文 UI 与真实本地链路 mock

目标是运营者走完最小中文流程后再允许启用 gate。

- 包含计划/预算/交接/阶段/观察/本地环境 UI、allowedActions、3 秒刷新保留输入，复用 acceptance/remote-linux/run.mjs 的 local-process 后端新增 parity 场景；parity 场景必须运行 coordinator-local worker + worktree，不能创建远端 node 来执行 parity。
- 不新增业务表或持久类型；读写前五个 PR 的合同。前置 PR5 实际主线版本，无 schema 变化就不增 user_version；若发现必须迁移，先修订本文并由主线分配版本，不偷加 JSON 字段。
- 文件为 public/app.js、server 静态白名单/API、runner/mock/scenarios；前端拆文件同步 copy-public 与白名单。不复制第二套 runner，不做 SSE、统计仪表盘、公开脱敏导出或真实模型效果承诺。
- fixture 是前五个 PR 数据在同一真实本地流程的组合；测试 HTTP/worker IPC/SQLite/CAS/本地进程与独立冻结 validator，只替换模型。classic 的既有 node/mailbox 场景单独回归。验证拒绝重提、连续接受、预算/close、held 决定、资源、环境、逐项重验和最终交付，清理仅限本轮进程端口。
- UI 实操证明接受/拒绝、grant/resume、finding 与交接分别处理、409 保留输入、键盘操作；源码字符串测试不替代界面。README 给实际命令、MC_ENABLE_MISSION_PARITY=1 的开启/关闭保护和证据缺口。

六个 PR 串行依赖 1→2→3→4→5→6，每个 PR 自带所需类型、迁移、往返 fixture、行为测试和 classic P0 回归；没有“以后只填 handler”的限制。Linux local-process 后端与云环境准备可独立先行，但不改变本地 parity 边界或占用业务 schema 版本。

## 19. 迁移所有权与交付门

| PR | 升级前置 | 本 PR 唯一存储/类型责任 | 往返 fixture 核心断言 |
| --- | --- | --- | --- |
| 1 | control schema10 | mission_workflows data v1、policy/roles、canonical/H、基础 registry/gate；升 11 | 原政策和五角色快照重开/恢复不变；classic 无引用恢复成功 |
| 2 | PR1 主线版本 | plan/draft/milestone v1、run/budget、inputSnapshot、PlanWait、稳定映射/close | 连续接受无重复对象/预算；旧授权/digest/held 决定可还原 |
| 3 | PR2 主线版本 | handoff/item/asset、资源引用、输入包 | cursor、旧资料版本、未物化遗留不丢失 |
| 4 | PR3 主线版本 | environment/service、manifest/ref、intent.data/receipt/delivery、milestone v2 | 冻结文件/删除、准备结果和原 exact 授权不变 |
| 5 | PR4 主线版本 | stage/check/finding/result/report/evidence、milestone v3 | 混合结果重启/恢复准确选重验项，报告与证据完整 |
| 6 | PR5 主线版本 | 无新增存储，组合 UI/runner | 同一用户流程读写前五个 PR 的实际持久记录 |

PR2–PR5 的控制版本在各 PR 基于已合入主线时顺序分配，不在本文硬编码未来数字。升级必须从所有已支持旧版本累计执行缺失步骤；失败回滚整个事务，重开幂等，未来版本拒绝。不能因 PR1 抢建空表而跳过后续迁移。每个 data 版本有显式解析/升级路径，备份恢复先按实际版本验证，不在离线恢复时擅自升级控制库；下一次受锁保护的启动才迁移。

每个 PR 原子增加所用中央 ErrorCode、TypeBox schema、handler 和传输测试；未实现能力返回 CAPABILITY_UNAVAILABLE，不注册空工具。延期功能必须另立设计/迁移/验收。节点库与远端协议不在六个 PR 的实现范围。

交付时分别报告源码/build、普通测试、Linux mock、UI 实操、真实模型与容器的实际证据和缺口。文档检查、fixture、listener 或 mock 成功都不能升级为全部用户验收完成。
