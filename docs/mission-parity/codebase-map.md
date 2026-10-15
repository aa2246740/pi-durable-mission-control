# Mission Control 现有代码地图与验证入口

新增行为只以[design.md](design.md)为准。本文保留现有代码位置、P0门控、存储与锁、协议兼容点、静态文件规则、Linux平台事实和验证命令，不再定义候选表、预算键、工具选型或另一套PR顺序。

## 1. 范围与证据口径

代码位置对应源代码基线，行号只帮助首次定位，实施时以函数名重新核实。当前仓库要求Node>=22.19.0，TypeScript输出dist，node:test从dist导入；证据为package.json、tsconfig.json和相邻测试。

本文不含私有Mission内容、配置或测量。历史记录为“本机套件通过；云端首次运行重新记录版本与耗时”。本次文档修订没有重跑产品套件，不能将旧本机结果当作Linux通过。

## 2. 领域模型、持久化与版本边界

### 2.1 协调端模型

协调端业务数据库为 `<home>/control.sqlite`；构造器先取得独占所有者锁，再检查 schema，设置 WAL/FULL，并在事务内迁移和恢复。大部分业务表将完整对象存入 `data` JSON，另有索引列。增加 JSON 字段也要定义旧数据的读取默认值。证据：`src/control.ts:348`、`src/control.ts:359`、`src/control.ts:364`、`src/control.ts:406`。

| 领域 | 类型与主要行为位置 | 持久化位置及注意事项 |
| --- | --- | --- |
| Mission | `src/contracts.ts:39`；创建 `src/control.ts:1629`；生命周期 `src/control.ts:1697`；完成门槛 `src/control.ts:3893` | `missions`，`src/control.ts:430`。状态、全局 turns/cost、contractRevision、workspaceStrategy 均在 Mission 中。 |
| Task / feature 的现有载体 | `src/contracts.ts:63`；创建 `src/control.ts:4441`；更新 `src/control.ts:4467` | `tasks`，`src/control.ts:437`。已有 dependencies、ownerId、validatorId、attempt、revision、fulfills、integration；当前没有独立 feature 表。 |
| 断言 / 验收契约 | `Requirement`、`ValidationContract`、`AssertionResult`、`RequirementCoverage`，`src/contracts.ts:48`；读取 `src/control.ts:641`；修订 `src/control.ts:679`；覆盖计算 `src/control.ts:2098` | `validation_contracts` 按 mission/revision 保存完整快照，`src/control.ts:431`。断言属于契约 JSON，没有单独 assertions 表。 |
| Agent / Role / ModelProfile | `src/contracts.ts:6`、`src/contracts.ts:13`、`src/contracts.ts:58`；更新 profile/role `src/control.ts:1485`、`src/control.ts:1507`；建 Agent `src/control.ts:1867` | `agents`、`profiles`、`roles`、`profile_revisions`、`role_revisions`，`src/control.ts:416`、`src/control.ts:426`、`src/control.ts:435`。运行中禁止修改所用配置；RoleProfile 本身没有 revision 字段，修订号单独持久化。 |
| 验收执行 / 验收决定 | `ValidationReceipt`、`Validation`，`src/contracts.ts:106`、`src/contracts.ts:115`；执行 `src/control.ts:4559`；决定 `src/control.ts:4877` | `validation_receipts`、`validations`、`validation_intents`，`src/control.ts:442`。Receipt 绑定 attempt、taskRevision、artifact digest、契约与断言修订；有执行回执还需 ValidateTask 才能接受任务。 |
| Blocker | `src/contracts.ts:128`；创建/解决 `src/control.ts:3407`、`src/control.ts:3422` | `blockers`，`src/control.ts:449`。kind 目前为 user_input、unsafe_execution、delivery、limit、approval；增加 kind 会影响 UI、恢复和预算判断。 |
| 消息 / durable outbox | `Message`，`src/contracts.ts:68`；发送 `src/control.ts:2185`；派发 `src/control.ts:3050`；确认 `src/control.ts:3160` | `messages`、`outbox`，`src/control.ts:441`、`src/control.ts:452`。Message.attempt 是投递尝试，与 Task.attempt 不同；排队、接收、完成分别有状态。 |
| 命令幂等 | `src/control.ts:776`、`src/control.ts:792` | `commands(scope, command_id, payload_hash, response, created_at)`，`src/control.ts:458`。相同命令与相同参数返回旧结果，换参数返回冲突；业务写入和命令结果在一个同步事务内。 |
| 事件 / 对话 | `MissionEvent`、`TranscriptEntry`，`src/contracts.ts:72`、`src/contracts.ts:143`；写入 `src/control.ts:630`、`src/control.ts:5485` | `events`、`transcript`，`src/control.ts:450`、`src/control.ts:463`。事件有全局递增 seq；并非所有内部表都自动出现在事件中。 |
| 轮次 / 费用 | `Mission.turns/cost/costKnown`，`src/contracts.ts:42`；准入 `src/control.ts:3316`；观察与累计 `src/control.ts:3344`、`src/control.ts:3360` | `agent_usage`、`accounted_turns`、`generation_admissions`、`generation_denials`，`src/control.ts:467`。generation 准入发生在请求发出前；Usage 是每 Agent 的累计费用覆盖值，不可逐条相加。 |
| 定时任务 / watchdog | `src/contracts.ts:132`、`src/contracts.ts:145`；schedule CRUD/tick `src/control.ts:2285`、`src/control.ts:2657`；watchdog tick `src/control.ts:3018` | `mission_schedules`、`schedule_occurrences`、`watchdog_state`、`watchdog_wakes`，`src/control.ts:483`。预算或计划门槛必须覆盖自动唤醒路径。 |
| 交付物 | `Artifact`，`src/contracts.ts:97`；发布 `src/control.ts:5431`；交接提示 `src/control.ts:5420` | `artifacts`，`src/control.ts:440`；字节保存在 `<home>/artifacts/<sha256>`。远端上传另有 `remote_artifact_transfers/chunks`，`src/remote-artifacts.ts:76`。 |
| Workspace / Git worktree | `src/contracts.ts:14`、`src/contracts.ts:154`；准备 `src/control.ts:1975`；Git 操作 `src/worktrees.ts:24` | `workspaces`、`worktrees`，`src/control.ts:429`、`src/control.ts:506`。工作树记录与数据库中的绝对路径绑定，不是 OS 沙箱。 |
| MCP 接入 | `src/mcp-config.ts:1`；配置 `src/control.ts:1553`；发现 `src/control.ts:1572`；授权调用 `src/control.ts:5073` | `mcp_servers`、`mcp_server_revisions`、`mcp_call_commands`，`src/control.ts:417`。模型内建工具与外部 MCP 工具是两条接入路径，环境 skills 不应自动变成 MCP 授权。 |

### 2.2 远端模型与第二套本地存储

| 领域 | 定义和表 | 版本 / 所有权边界 |
| --- | --- | --- |
| 远端机器、注册、probe 命令 | `src/machines.ts:17`、`src/machines.ts:32`、`src/machines.ts:49`；`remote_machines`、`node_commands`、`node_registrations`，`src/machines.ts:247` | 机器 token、sessionId/sessionEpoch、租约共同决定权限；公开视图另在 `src/contracts.ts:18`，改字段时要核对两处。 |
| 协调端 remote runtime | `RemoteRuntimeRow`，`src/remote-runtimes.ts:17`；`remote_worker_runtimes`、`remote_worker_runtime_reports`，`src/remote-runtimes.ts:38` | 分配与恢复门槛在 `src/control.ts:1075`、`src/control.ts:1171`；停止来源不能被新的恢复路径覆盖。 |
| 双向 mailbox | `WorkerBinding`、`WorkerRpcPayload`、`WorkerEnvelope`，`src/worker-mailbox.ts:14`、`src/worker-mailbox.ts:23`、`src/worker-mailbox.ts:56` | `worker_mailbox_meta/bindings/outbox/inbox`，`src/worker-mailbox.ts:480`、`src/worker-mailbox.ts:521`。同一实现分别服务 coordinator 与 node，有自己的迁移入口；binding 包含 runtime、machine、session、agent 及两种 epoch。 |
| 节点 supervisor | `NodeWorkerSnapshot`、`NodeWorkerSupervisor`，`src/node-workers.ts:26`、`src/node-workers.ts:197` | 节点的 `node_worker_runtimes`、`node_effect_approvals`、`node_effect_approval_replies`，`src/node-workers.ts:258`；独占锁 `src/node-workers.ts:246`。不能只给 control.sqlite 加列就声称节点迁移完成。 |
| 节点 effect journal | `NodeEffectSpec`、`NodeEffectReceipt`，`src/node-effects.ts:5`、`src/node-effects.ts:14` | `node_effects`、`node_effect_upload_acks`，`src/node-effects.ts:152`。shell / 文件写入的 uncertain 状态不允许按新命令重做。 |
| worker 对话数据库 | 本地 runtime 打开存储 `src/worker.ts:331`；远端会话证据 `acceptance/remote-linux/session-evidence.mjs:3`、`acceptance/remote-linux/session-evidence.mjs:6` | pi-durable 管理的 SQLite，和协调端 schema 独立。不能从未停止的会话库拼接结果冒充已完成验收；运行统计延期，缺token等指标标不可用。 |

### 2.3 schema、备份、恢复和导出

1. `CONTROL_SCHEMA_VERSION = 10`，版本取自 `PRAGMA user_version`。更高版本直接拒绝，不能自动降级。`migrate()` 在版本相等时直接返回，低版本通过建表、调用子模块迁移和补 outbox 列后设置版本；这不是逐版本 migration 文件目录。新增 schema 的 PR 必须统一分配下一个版本。证据：`src/control.ts:67`、`src/control.ts:395`、`src/control.ts:406`、`src/control.ts:511`、`src/control.ts:521`。
2. 迁移在 `BEGIN IMMEDIATE` 事务内，所有者锁先于迁移取得。`RemoteArtifactStore.migrate()` 在 control 迁移之后另行调用，不能假定所有附属表都由版本早退覆盖。证据：`src/control.ts:351`、`src/control.ts:364`、`src/control.ts:367`、`src/control.ts:524`。
3. `backupHome()` 要求协调端离线，并持有协调端与 Agent 存储锁；收集 control.sqlite、admin.token、协调端 Agent 库和 CAS 文件，生成带哈希、数据库版本、worktree 元数据的 manifest。它不收集远端节点 home 或工作区。新表在 control.sqlite 内会随数据库快照备份；当前静态备份文件白名单限制新增文件；MVP资料统一引用现有CAS，详见设计第3节。证据：`src/backup.ts:463`、`src/backup.ts:494`、`src/backup.ts:517`、`src/backup.ts:531`。
4. `restoreHome()` 先核对 manifest、文件集合、哈希与数据库版本；恢复到新目录或空目录。恢复本身保留原 schema，下一次 ControlPlane 打开才升级。带 worktree 的备份只允许回到原 home。恢复会撤销远端授权、增加 session epoch，并隔离不确定命令和投递。新计划、init、服务启动状态必须参加恢复隔离，不能因备份里曾经 accepted/ready 就重放。证据：`src/backup.ts:883`、`src/backup.ts:898`、`src/backup.ts:915`、`src/backup.ts:933`。
5. `exportMission()` 输出 `mission-control-replay-v1`，组合 detail、transcripts、commands、outbox、generation admissions/denials 与契约历史；目前没有 controlSchemaVersion，也没有完整 remote runtime/mailbox/effect 表。这是审计导出，不能替代完整备份或当作可恢复快照。设计第14节区分 MVP 私有 export 的关系/schema 版本扩展，与延期的统计新表及公开脱敏导出。detail()在`src/control.ts:5494`，exportMission()在`src/control.ts:5534`；路由在`src/server.ts:600`。
6. 新增行为以设计第3、19节为准；现有迁移回归覆盖旧库升级、重开、更高版本拒绝、所有者锁、历史回执和备份/恢复。已有起点：`test/migrations.test.mjs:23`、`test/migrations.test.mjs:40`、`test/backup.test.mjs:565`、`test/backup.test.mjs:579`。

### 2.4 节点独立库、协议 3 与静态文件事实

`src/node.ts:237` 的 NodeJournal取得node.ownership.sqlite独占锁后打开 `<node-home>/node.sqlite`，当前以未版本化DDL维护node_owner、node_operations、node_runtime_reports与node_identity。`src/node-workers.ts:246` 另取node-workers.ownership.sqlite锁，再开node-workers.sqlite，保存runtime、approval、mailbox与effect等节点执行证据。两库不属于control.sqlite，也没有跨库事务；pi-durable agent库还有独立store lease，位置为 `src/worker.ts:121`。

NodeJournal 的版本化迁移移出 MVP，作为未来 remote parity 前置，见设计第3.4节；本期不改节点库，不建远端 service 表。backupHome只收协调端home，不把这些节点库自动带走。

| 协议硬编码点 | 当前事实与修改时的兼容影响 |
| --- | --- |
| `src/machines.ts:8`、`:136` | workspace-effects版本常量为3，capability解析按等值和严格字段组合接受。 |
| `src/control.ts:905` | remote artifact transfer授权显式拒绝非3协议。 |
| `src/control.ts:3576` | PublishArtifact派发再检查protocol为3。 |
| `src/node.ts:548` | executionMode决定上报协议号，workspace-effects上报3。 |
| `src/node-worker-spec.ts:33`、`src/node-effects.ts`、`src/remote-rpc-methods.ts` | descriptor与effect/reply是严格字段及方法白名单，未来 remote parity 才需要另立协商与兼容合同。设计第12节明确 MVP 不扩展节点协议，不广告 managedServices。 |

`src/server.ts:713` 只直接服务app.js/style.css；index由专门入口读取。前端拆文件必须同步静态白名单与copy-public.mjs，不能只在public增加文件。`public/app.js:1020` 是3000ms轮询，已有 `/api/events` SSE路由不代表UI接入SSE。

## 3. 新增模型工具的完整接入路径

以现有 `Report(summary, evidence)` 为例。这里的模型工具在 worker 的 extension 注册；无需给每个工具新增 HTTP 路由。

| 顺序 | 触点 | 实际行为 / 新工具需要处理的内容 |
| --- | --- | --- |
| 1 | `src/worker.ts:171`、`src/worker.ts:186`、`src/worker.ts:226` | `tools()` 用 Type.Object 定义模型参数，拒绝额外字段；统一包装声明 `replay: unsafe`。新增工具在这里定义 schema、描述和返回语义。 |
| 2 | `src/worker.ts:203`、`src/worker.ts:236` | Report 返回 `control.terminate` 结束本轮。角色工具列表在 selected 中筛选；可见性不能替代服务端权限判断。 |
| 3 | `src/worker.ts:138`、`src/worker.ts:144` | `rpcRequest()` 发送含 token、agentId、epoch、method、args 的 IPC 消息。随机 id 用于匹配回复；`taskId = agentId + durable tool taskId` 才是业务幂等键，不是领域 Task.id。 |
| 4 | `src/workers.ts:312`、`src/workers.ts:390` | 本地父进程接收 IPC，校验 token/agent/epoch，调用 `control.workerCommand()`；回复后同步生命周期并派发消息。新增终止工具要检查这里的停机白名单和回复时序。 |
| 5 | `src/control.ts:3513`、`src/control.ts:3555`、`src/control.ts:4419` | 调度前检查远端方法白名单、epoch、Mission 状态、角色。Report/Transcript 对旧 epoch 有专门迟到证据路径，`src/control.ts:3530`；它不等同于普通成功业务调用。 |
| 6 | `src/control.ts:3782`、`src/control.ts:3880` | Report 参数被转交 `report()`，以 reports scope 和 durable taskId 调用幂等事务，写 `agent_report`，向 orchestrator 排入 followUp。Report 没有任务接受操作。 |
| 7 | `src/control.ts:776`、`src/control.ts:630`、`src/control.ts:3866` | 业务记录、事件、消息与 command response 应在一致事务中。重复请求不应产生第二份交接或通知。EndTaskRun的结构化数据与可读通知合同见设计第7节。 |
| 8 | `src/remote-rpc-methods.ts:1`、`src/worker.ts:244` | 远端 runtime 再过滤工具。Report/UpdateTask 在普通 RPC 白名单中；文件操作在 EFFECT 白名单。不要把写业务状态的方法加入 NONAUTHORIZING 集合，`src/remote-rpc-methods.ts:9` 明确它会改变恢复时忽略不确定回复的条件。 |
| 9 | `src/node-workers.ts:743`、`src/node-workers.ts:756`、`src/node-workers.ts:779` | 远端父进程校验完整 IPC 形状与绑定，构造 uplink，脱敏后持久入 mailbox。普通 RPC 不需要为每个 method 改 transport，但新参数必须满足 JSON 和大小限制。 |
| 10 | `src/worker-mailbox.ts:6`、`src/worker-mailbox.ts:323`、`src/node.ts:630` | RPC envelope 有固定顶层键和 512 KiB 上限；node 通过 mailbox upload/poll/ack HTTP 交换。新增业务字段放 args 内；修改 envelope 顶层则需要协议兼容设计。 |
| 11 | `src/server.ts:326`、`src/control.ts:1372`、`src/server.ts:133` | node HTTP 路由先校验机器 token、session、租约与 binding，再交给 dispatcher。dispatcher 复用 `control.workerCommand()`，不用本地 worker token 替代 node 授权。 |
| 12 | `src/worker-mailbox-dispatcher.ts:107`、`src/server.ts:160`、`src/node-workers.ts:969` | 协调端先持久化 reply 再执行 afterRpc；节点收到 reply 再回 IPC。若新工具引起 pause/blocked/stop，必须保留这个顺序，避免先 fence 再丢回复。 |
| 13 | `src/prompts.ts:7`、`src/prompts.ts:16`、`src/prompts.ts:46`、`src/worker.ts:339` | 提示词说明何时调用、谁能调用、运行终止规则和远端限制。模型 schema 与提示词使用同一术语；只改提示词无法新增后端能力。 |
| 14 | `src/control.ts:5494`、`src/server.ts:600`、`public/app.js:352`、`public/app.js:645`、`public/app.js:1020` | UI 通过 detail 中事件/消息展示 Report；当前每 3 秒 load 数据，并非消费 SSE 更新。新增结构化 UI 要扩充 detail 和渲染函数；`/api/events` SSE 虽然存在，不能当作现 UI 已接入，见 `src/server.ts:675`。 |

`UpdateTask` 的区别在于 `src/worker.ts:225` 定义参数，`src/control.ts:3750` 解析，`src/control.ts:4467` 检查任务所有者和角色，`src/control.ts:4514` 写任务并发 `task_updated`，UI 由 `public/app.js:406` 展示。只有验收成功能写 accepted；worker 不能靠 UpdateTask 接受自己，见 `src/control.ts:4483`、`src/control.ts:4987`。

parity 新工具验收穿过真实 local worker IPC；classic 的 node mailbox 继续回归。不能只直接调用 ControlPlane。可沿用 `test/backend.test.mjs`、`test/worker-completion.test.mjs`、`test/remote-worker-http.test.mjs`、`test/worker-mailbox-http.test.mjs` 的现有结构；传输与生命周期入口分别见 `src/workers.ts:390`、`src/server.ts:133`、`src/node.ts:630`。分别覆盖未授权、旧 epoch、同命令重试、参数变化冲突及 reply 先落库再停止；远端工具可见性仅按 classic 原合同回归。

本地错误当前在src/workers.ts:413变成字符串，worker.ts:156用new Error丢失结构；远端src/server.ts:155把多数4xx归为泛化文本。新增code/details与模型可见envelope只以设计第5.3节为准，parity 本期只扩展本地 IPC，远端 envelope 保持 classic；未来 remote parity 另立合同。SubmitPlan新增plan-wait结算必须接入onRpc在回复前预留quiescence的入口，而非只在workerCommand置blocked。

## 4. 功能接入点与串行接线位置

### 4.1 对应设计模块

| 设计模块 | 必须读的现有入口 | 兼容影响与合同位置 |
| --- | --- | --- |
| src/workflow-schema.ts | control.ts:406、contracts.ts、worker.ts:171、backup.ts:883 | 原迁移事务、TypeBox 工具风格、旧 JSON；各 PR 自带存储和类型迁移，责任看设计第3、18、19节及 PR1 brief。 |
| src/mission-plans.ts | control.ts:1629、:1697、:3407、:3422、:4441；workers.ts:390、:490、:594 | 当前CreateTask立即进入正式集合，原完成门要求所有Task accepted；草稿、物化、有限取消和plan-wait见设计第4、9节。 |
| src/task-runs.ts | control.ts:747、:4506、:4987、:3316、:3050；approval执行和remote dispatch | Task.attempt在契约失效/首次running/验收失败处变化，不能当TaskRun；预算与副作用绑定见设计第4、8节。 |
| src/handoffs.ts | worker.ts:226；control.ts:3530、:3782、:3880、:5424；prompts.ts:20 | Report仍是现有简单报告；已决定新增EndTaskRun，不保留待定选型。见设计第5、7节。 |
| src/reasoning.ts | contracts.ts:6、:13；control.ts:1507；worker.ts:336；node-worker-spec.ts:38、:135 | profile.reasoning只是能力布尔值。AgentState.thinkingLevel在pi-durable的types.d.ts:250；快照与默认见设计第10节。 |
| src/workflow-assets.ts | prompts.ts:46、worker.ts:339、control.ts的CAS发布与backup文件白名单 | skills不赋工具权限；正文/资源/固定版本与受限发现见设计第5、11节。 |
| src/mission-environment.ts | control.ts:1975、:4559；workers.ts:234、:490；node-effect-executor.ts:233 | 原Task验收无专门准备阶段，协调端不共享远端依赖；仅本地supervisor见设计第11节。 |
| src/validation-execution.ts | control.ts:4559、:4690附近、:4753；validationFlights与stopMissionProcesses | 原intent、detached目录、snapshotIntegrity与进程跟踪是复用基础；task-validation身份见设计第11.3节。 |
| src/milestones.ts | control.ts:679、:3893、:4559、:4877；worktrees.ts | 原完成门、唯一integration与祖先证明保留；manifest、stage、finding和最终绑定见设计第6节。 |
| src/workflow-observability.ts | control.ts:2055、:5494(detail)、:5534(exportMission)；server.ts:600 | 最小MVP投影，不建统计表，缺token不可用；设计第14节。 |
| server.ts / public/app.js | server.ts:479、:600、:713；app.js:406、:594、:645、:943、:1020 | 只服务白名单脚本，3秒轮询；设计第13节规定最小UI。 |

### 4.2 共享热点

control/contracts/worker/prompts/server是多个功能共同触点。保留唯一授权分派、command事务与outbox写者，新增域逻辑放上表模块，不在异步事件监听器中驱动必要业务转换。已有command已开同步事务，域模块不能另开BEGIN或反向调用整套ControlPlane。

PR顺序只引用设计第18节的六个串行依赖：基础合同→计划执行→交接输入→候选环境→阶段修复→UI验收。每个PR的包含范围、测试和README变更均在设计中，本文不再列另一套候选表或并行领域拆分。Linux local-process 后端和云环境准备可以先独立交付。parity MVP 仅 coordinator-local + worktree，classic 远端链独立保留；基础 PR 的可执行范围见 [PR1 brief](pr1-foundation.md)。

## 5. 测试基础设施与Linux事实

### 5.1 仓库命令

```sh
npm test
npm run typecheck
npm run lint
```

npm test先build，再执行test/*.test.mjs；build编译src并复制public到dist/public。lint单独执行，test不自动lint。node:sqlite是Node内置模块，系统sqlite3 CLI只用于人工核验。历史本机套件通过；云端首次运行重新记录版本、OS/架构、实际耗时与结果。本次只修文档。

### 5.2 平台依赖逐项判定

下表均为源码判断，不能代替Linux实测。Linux 目标按普通非 root Ubuntu 用户、可创建回环监听、可 fork/发送信号、可写 POSIX 文件系统来评估。

| 测试 / 入口 | Linux 结果 | 依据 |
| --- | --- | --- |
| `test/service.test.mjs:103` plist 转义与环境白名单 | 能跑；只生成字符串，不执行 launchctl | 生成器调用和字面路径均在 `test/service.test.mjs:104`。字符串中的 macOS 示例目录不需要存在。 |
| `test/service.test.mjs:132` 安装/崩溃重启/停止/卸载 | 自动 skip | `skip: process.platform !== "darwin"`；真实启动调用 `test/service.test.mjs:135`。 |
| `test/service.test.mjs:186` 未确认存活 daemon | 自动 skip | 同一平台条件；launchctl 检查在 `test/service.test.mjs:203`。 |
| `test/service.test.mjs:211` 无关 PID 的旧记录 | 自动 skip | 测试声明包含 darwin 条件。 |
| `test/service.test.mjs:241` 占用 home | 自动 skip | 测试声明包含 darwin 条件。 |
| `test/service.test.mjs:263` 日志符号链接 | 自动 skip | 测试声明包含 darwin 条件。 |
| `test/service.test.mjs:283` 服务生命周期锁 | 自动 skip | 测试声明包含 darwin 条件。 |
| `test/service.test.mjs:303` 冲突 plist | 自动 skip | 测试声明包含 darwin 条件。Linux 不验证 LaunchAgent 生命周期。 |
| `test/cli.test.mjs`、`test/cli-stop.test.mjs` | 能跑；不是 launchd 测试 | 用 process.execPath 启动 CLI / 子进程，`test/cli.test.mjs:18`、`test/cli-stop.test.mjs:17`。若云端禁用监听、detached 进程或信号则失败，不会自动 skip。 |
| `test/control-owner.test.mjs`、`test/node-owner.test.mjs` | 能跑，需要 SQLite 锁、fork、符号链接、SIGTERM/SIGKILL | `test/control-owner.test.mjs:28`、`:91`、`:122`；`test/node-owner.test.mjs:31`、`:118`、`:137`。不依赖 PID 文件单独证明所有权。 |
| `test/worktrees.test.mjs` | 能跑，需要 git 可执行程序及本地仓库 | `test/worktrees.test.mjs:28`；实现 `src/worktrees.ts:24`。不需要访问远端 Git 或登录。 |
| `test/backup.test.mjs`、`test/migrations.test.mjs` | 能跑，需要本地 SQLite/POSIX 文件操作 | `test/backup.test.mjs:38`、`:271`；`test/migrations.test.mjs:5`、`:23`。系统 sqlite3 CLI 不是运行依赖。 |
| `test/node-effect-executor.test.mjs:85`、`:157` | 能跑，需要 mkfifo | Homebrew PATH 是污染输入，测试检查它不被继承，见 `test/node-effect-executor.test.mjs:114`。FIFO 在 `:161` 调用 PATH 中的 mkfifo，缺程序会失败。 |
| `test/remote-linux-real.test.mjs:72`、`:114`、`:139` | 能跑，需要 `/usr/bin/mkfifo` 和 `/bin/sh` | `:88` 硬编码 mkfifo 位置，Ubuntu coreutils 满足；`:118` 用临时假 node 运行凭证输入壳；`:154` 在本机启动真实 Node 测试，不起容器。 |
| `test/remote-linux-real.test.mjs:474` | 能跑，验证独立 review 编排而非真实容器 | `execute` 被注入，`:486` 检查构造参数，`:500` 本机 Node 跑冻结副本。出现 container 字样不代表依赖容器运行时。 |
| `test/remote-linux-real.test.mjs:576` 及命令等价性样本 | 能跑 | PATH/HOME 白名单测试允许 Darwin 特有变量，`:585`；macOS 绝对路径样本用于字符串解析，见 `:761`。文档无需复制这些历史样本文本。 |
| `test/remote-linux-preflight.test.mjs:337`、`:446`、`:481` | 能跑，container runner 被替换为注入实现 | `:352` 注入 containerRun，`:358` 启动本机 `--container-probe`；本地假 HTTP 服务测试 provider 协议。无真实 key 或外部 API 要求。 |
| `test/remote-linux-mock.test.mjs`、`test/remote-linux-turn-limit.test.mjs` | 能跑，需要 `/bin/sh` | `test/remote-linux-mock.test.mjs:111`、`test/remote-linux-turn-limit.test.mjs:228`。 |
| `test/remote-linux-coordinator-restart.test.mjs`、`test/remote-linux-node-power-loss.test.mjs`、`test/remote-linux-rehearsal.test.mjs` | 可在普通测试套件中跑；场景逻辑/fixture 覆盖不等于真实故障注入 | fixture/场景辅助函数导入见 `test/remote-linux-coordinator-restart.test.mjs:3`、`test/remote-linux-node-power-loss.test.mjs:1`、`test/remote-linux-rehearsal.test.mjs:1`；真实运行由下表显式入口负责。 |
| 其余 `test/*.test.mjs` | 扫描未发现 macOS 专属可执行入口；Linux 待实测 | 核心 HTTP/worker 测试使用 Node 子进程与回环服务，例如 `test/node.test.mjs:41`、`test/remote-worker-http.test.mjs:136`；shell 实现用 `/bin/sh`，`src/control.ts:4064`、`src/node-effect-executor.ts:233`。 |

### 5.3 显式容器验收入口

以下全部位于 `acceptance/remote-linux/`，不在普通 test glob 中，也没有通用的 Linux skip。Linux 无 Apple Container 时会因前置条件或启动失败退出；不能把它们配置成云端常规必过命令。

| 文件 | 专属依赖 / 失败位置 |
| --- | --- |
| `container.test.mjs` | `:15` 启动 run.mjs，后者 `:20` 硬编码 Apple Container 路径，`:306` 首次查询。 |
| `pause-resume-container.test.mjs` | `:8` 连续完整场景，依赖同一 runner。 |
| `worker-crash-container.test.mjs` | `:8` 连续完整故障场景，依赖同一 runner。 |
| `turn-limit-container.test.mjs` | `:9` 还强制历史专用 prefix，未改造时即使提供别的后端也会失败；应改为本轮唯一前缀校验。 |
| `coordinator-restart-container.test.mjs` | `:9` 完整重启矩阵，`:10` 要求调用方设置合法专用 prefix。 |
| `node-power-loss-container.test.mjs` | `:8` 杀整台容器并保留节点 home；不能用只杀 supervisor 代替。 |
| `rehearsal-container.test.mjs` | `:10` 验证 prefix；`:50` 直接调用 Apple Container 检查残留。 |
| `regression-container.test.mjs` | `:9` 固定 CLI 路径，`:13` 要求 prefix；`:45` 独立新容器复核。 |
| `integrity-container.test.mjs` | `:13` 固定 CLI，`:14` 要求 prefix；`:52` 包含容器 preflight 中断/超时。 |
| `session-container.test.mjs` | `:16` Linux Node 读取真实停止后的会话库，`:19` 固定 CLI。 |
| `owner-lock-container.test.mjs` | `:14` 从 PATH 执行 container；`:18` 在文件顶层查询镜像，没有 skip。 |
| `lifecycle.test.mjs` | 名字虽不含 container，`:13` 仍启动 Apple Container runner；`:1` 明示不在普通测试范围。 |

### 5.4 已知时序风险与耗时口径

- 历史彩排记录描述过 CompleteMission 回复后立刻停止 worker，导致 submission 尚未结算而留下 uncertain 的竞态。该记录对应旧基线，不能据此宣称当前仍有同一故障。证据：`acceptance/remote-linux/REHEARSAL_FINDINGS.md:21`。当前停止/结算逻辑在 `src/workers.ts:490`、`src/workers.ts:594`，回归覆盖在 `test/terminal-handoff.test.mjs:14`、`:110`。
- 历史 worker-crash 曾出现节点退出、runtime 卡在 stopping/unproven；场景现在会将其判失败，见 `acceptance/remote-linux/README.md:144`。Linux runner 要保留这个失败判断，不能只看 kill 命令成功。
- 生命周期失败先保留首次证据，再用仓库构建后的 `node --test --test-concurrency=1 test/terminal-handoff.test.mjs` 等实际失败文件复核。串行通过只说明与并发有关，不能抹掉首轮失败。
- 云端首次记录 build 时间、测试总 duration、wall time、Node/OS/架构、文件并发度和 CPU 配额。不要将各文件耗时相加当全量耗时；普通 test 使用 Node 默认文件并发，见 `package.json:21`。macOS专属项按源码条件skip，实际通过/失败/skip总数由云端首次运行记录。

## 6. 现有Linux验收链与后端接入位置

local-process后端由独立任务实现，parity复用它，不新建runner。当前分支是否已有该参数需在合入后检查run.mjs参数解析；不能把拟议命令当当前版本支持。业务范围只见设计第15、18节。

| 当前代码位置 | 现有职责与Linux兼容影响 |
| --- | --- |
| acceptance/remote-linux/run.mjs:20、:25、:306、:375 | 当前Apple Container路径、参数、镜像与节点启动；Linux后端应替换执行环境，保留真实产品协议链。 |
| bootstrap.mjs:5、:18；run.mjs:347、:369、:391 | enroll/session/probe与节点bootstrap，固定工作目录和stdin凭据需要后端显式提供，不在宿主根目录造固定路径。 |
| mock.mjs:14；fake-provider.mjs:19；real.mjs:377、:427 | 真实工具transcript计划器与fake provider，不是内存ControlPlane替身；parity场景扩展入口。 |
| scenarios/worker-crash.mjs:145；node-power-loss.mjs:123 | 当前依赖容器进程范围；Linux共享宿主必须证明PID/启动身份与完整后代归属，不能广泛杀进程。 |
| real.mjs:508；run.mjs:744 | 冻结副本独立复核；本机模式仅新进程与独立目录，不证明容器/内核隔离。 |
| session-evidence.mjs:65；run.mjs:767 | 确认停止后只读会话证据，不能读取运行中库推断完成。 |
| run.mjs:815、:836；real.mjs:74 | 项目作用域清理与最终证据检查，失败/超时同样保留结果。 |

现有 classic 本机进程模式仍需真实 HTTP、node mailbox、SQLite、effect、CAS、独立 validator 与停止门；mock 只替代模型。设计第15节的 parity 场景另要求 coordinator-local worker + worktree，不扩展 node 协议。node-power-loss在本机最多证明整组进程故障与持久库重开，不能称硬件断电。缺cgroup或可证明完整后代控制时该场景应不支持，不能给containerRemoved填true。

后端与相应场景合入后的仓库命令形状为：

```sh
node acceptance/remote-linux/run.mjs --backend local-process --scenario default --keep
node acceptance/remote-linux/run.mjs --backend local-process --scenario pause-resume --keep
node acceptance/remote-linux/run.mjs --backend local-process --scenario coordinator-restart --keep
node acceptance/remote-linux/run.mjs --backend local-process --scenario parity-plan-reject --keep
```

前三项核对已有故障与恢复链；parity场景清单和验收标准以设计第15节为准。真实provider/模型、浏览器实操、容器隔离与离线包另列证据，不从本机mock成功推导。

## 7. 云环境准备的仓库事实

项目需要Node>=22.19.0、npm锁文件、git、/bin/sh、coreutils的mkfifo与sha256sum、POSIX权限、回环HTTP、fork、信号和SQLite锁。证据见package.json、worktrees.ts、node-effect-executor.ts、test/remote-linux-real.test.mjs:88及第5节平台表。

.cursor/environment.json与安装/检查脚本由独立环境任务交付，本文不保留另一份配置脚本或供应商设置合同。云端首次运行需记录实际Node/OS/架构、锁文件安装、SQLite/WAL/锁、/proc、进程组与监听权限。安装成功不证明后续agent shell用的是同一Node。

云端新clone可按锁文件执行npm ci；本机共享node_modules不能据此重装。UI端口转发仍需核对server.ts的Host/Origin/认证与127.0.0.1监听，字符串测试不能替代实际页面操作。缺平台能力时报告具体缺口，不自动换容器引擎或弱化测试。

## 8. 阅读顺序与已裁决事项

### 8.1 最短代码阅读路径

先读contracts与目标ControlPlane方法，再读worker参数、workers/server传输、相关行为测试。改终止工具重点读workers.ts:390/490/594与terminal-handoff；改远端绑定还须读worker-mailbox、node-workers、node-worker-spec与node.ts；只读几个主文件不足以安全修改节点协议。

detail()在control.ts:5494，exportMission()在:5534。acquireStoreLease在worker.ts:121。已安装pi-durable的AgentState.thinkingLevel在harness/types.d.ts:250。这些定位需要随实现PR重新核对，不把旧行号当稳定API。

### 8.2 交付证据

每PR分别报告build、普通测试、Linux mock、UI实操、真实模型与容器。保留首次失败，针对同一失败文件串行复核；通过源码字符串测试不等于真实UI，通过fake provider不等于真实模型效果。运行证据不提交私有数据、真实凭据或运行中数据库。

### 8.3 已裁决规则与剩余环境问题

| 事项 | 唯一权威位置 |
| --- | --- |
| 草稿/正式Task、接受、blocked、有限取消与plan-wait | 设计第4、9节 |
| TaskRun计数、bonus、副作用准入 | 设计第4、8节 |
| EndTaskRun与审阅游标 | 设计第5、7节 |
| 五角色effort、缺省与配置冻结 | 设计第3、10节 |
| init、本地服务、验收环境、远端服务延期 | 设计第11、12节 |
| 阶段修复、重验、最终内容绑定、证据 | 设计第6节 |
| MVP/延期和六个串行PR | 设计第1、18、19节 |

剩余待云端首次运行确认的只有真实平台条件：Node下限与依赖是否可用、完整进程控制、SQLite锁/POSIX行为、预览Host/Origin兼容、local-process后端清理与证据。上述已裁决业务规则不再作为“待设计”问题。
