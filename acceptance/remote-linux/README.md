# 远端 Linux 冻结成果验收

默认运行确定性 mock 回归；`--real <config.json>` 运行真实模型验收。mock 通过不等于真实模型通过。下面先说明 mock 模式。它使用脚本化 OpenAI Chat Completions SSE 服务，费用为零；真实执行产品的模型工具循环、Linux 节点文件和 bash 操作、远端冻结上传、协调端 CAS、独立验收及 Mission 完成流程。它通过管理 API 创建 Mission，不覆盖浏览器 UI。

## 前置条件和运行

需要 macOS、Node >= 22.19、运行中的 Apple Container 1.0.0，以及本机已缓存的 `node:22-bookworm-slim` Linux arm64 镜像。宿主必须能监听 `192.168.64.1`，容器能访问此地址。缺少镜像时脚本直接失败，不执行拉取。依赖目录必须已有，无须运行 npm install。

```sh
npm run build
node acceptance/remote-linux/run.mjs
node acceptance/remote-linux/run.mjs --keep --out /指定的/新证据目录 --timeout-ms 180000
```

`--out` 必须指定尚不存在的目录，父目录必须存在。默认位置是 `$TMPDIR/mc-acceptance-<时间戳>-<随机后缀>`。成功默认删除目录，`--keep` 保留；失败、超时、SIGINT 或 SIGTERM 保留目录并输出路径。退出码非零表示验收或清理失败。不能用 SIGKILL 中断并期待 finally 清理。

容器名仅使用 `mc-acc-` 前缀（可用环境变量 `MC_ACCEPTANCE_CONTAINER_PREFIX` 改成其他 `mc-acc-` 开头的前缀，以便多个检出并行运行），运行带 `--rm`。只停止、删除当前运行创建的精确容器名；若启动前发现已有此前缀容器，拒绝运行并由其所有者处理。退出前以 `container list --all --quiet` 核对此前缀无残留，并打印 `cleanup verified`。正常成功还会关闭协调端、mock、TCP 中继并删除证据目录。只读挂载本 checkout 的 dist、package.json、解析软链接后的 node_modules 及节点启动脚本；默认场景的节点工作目录与状态位于容器中，随容器销毁；`node-power-loss` 将节点状态持久化到证据目录。

宿主中继只将 `192.168.64.1:<随机端口>` 接到协调端 `127.0.0.1:<nodePort>`。容器内中继将 `127.0.0.1:14311` 接到宿主中继，节点使用字面量回环 HTTP 地址。admin/UI 端口不转发。mock 有独立的宿主中继。node bearer token 和假模型凭据通过 `container run -i` 的 stdin 传入 shell，再导出给 `--token-env`、`--credential-ref`；值不进入 argv 或证据。admin token 由脚本读入内存，协调端退出后删除产品生成的 admin.token。保留证据前扫描全部文件，检查这三个凭据值没有泄漏。

## 验收内容和证据

orchestrator 从 GetMissionState 读取真实角色、任务、workspace、agent ID，生成远端 worker 和本地 validator，并分配一个有独立 validator 的任务。worker 写入 linux-delivery.json，在 Linux bash 中执行 `command -v node` 和实际内容自查，PublishArtifact 后修改节点原文件，再 UpdateTask review 和 Report。orchestrator 收到交付报告后派 validator。validator 用 RunValidation 执行仅协调端存在的只读 node:test 文件，检查冻结内容、独立快照目录、宿主测试文件的只读权限和发布版本，再 ValidateTask、Report。orchestrator 调用 CompleteMission。任何错误都终止验收，不掩盖命令失败。

保留目录包含：

- `summary.json`：状态、耗时、Linux Node/PATH、artifact 远端来源、回执 exitCode/snapshotIntegrity、下载 Content-Disposition、blocker 和清理结果。
- `mission.json`：任务、事件、artifact、真实验收回执和独立验收决定。
- `runtimes.json`：远端 worker 的停止回报；成功前等待物理停止确认为 closed，并再次检查 blocker。
- `mock-tools.json`：模型返回的工具调用，以及从对话中收到的真实工具 JSON 结果；不记录请求头或凭据。
- `host-acceptance.test.mjs`：协调端生成的四个只读验收测试，不挂载到 worker 容器。
- `independent-review.json`、`independent-inputs/`、`host-runtime.json`：协调端退出后独立容器的 TAP、退出码、原始测试及 CAS 字节副本、回执一致性和宿主 Node 运行前后的 SHA-256。
- `coordinator.log`、`container.log`、`home/`：日志和协调端持久状态。凭据值不保留。

summary 必须同时满足 Mission completed、任务 accepted、验收 exitCode 0、snapshotIntegrity true、remote-snapshot、Linux machine provenance、正确下载文件名、成功 Linux PATH 自查、发布后原文件变化、没有 blocker、validator 未调用 RequestUserInput，才算通过。修改原文件后仍通过冻结内容测试证明读取的是发布快照。两种模式都在协调端退出后新建一个 `node:22-bookworm-slim` Apple Container，带 `--rm`，只读挂载脚本内存保留的原始测试和宿主 CAS 字节副本。宿主及容器内分别核对测试 SHA-256 和 artifact SHA-256，再由容器内 Node 运行四个测试，要求 4/4 通过并与产品 validator 回执一致；不一致或宿主 Node 二进制前后 hash 改变都失败并保留证据。此复核容器不挂载 checkout、角色凭据或会话库。

### 完成后协调端重启

`--scenario restart-after-complete` 先执行 default 的完整冻结交付流程，等待 Mission completed、任务 accepted 和远端 runtime closed。随后对协调端依次发送 SIGTERM、SIGKILL，每次确认进程退出后用同一个 home 重启。节点容器保持运行；脚本更新宿主中继的目标端口，admin 端口仍只供宿主使用。SIGKILL 模拟 launchd 崩溃后的重启，不调用或验收 launchd。

```sh
mkdir -p .acceptance-proof
TMPDIR="$PWD/.acceptance-proof" node acceptance/remote-linux/run.mjs --scenario restart-after-complete --keep --out "$PWD/.acceptance-proof/restart-complete-1"
```

每次重启后核对 Mission 与 orchestrator ID、completed 状态、accepted 任务、验收回执的完整 JSON、artifact 下载 SHA-256 与 Content-Disposition、零开放 blocker、closed runtime 及停止来源。runtime 数量和 binding 保持原样，没有分配或重分配事件，mock 模型请求计数不增加。旧 mailbox 可以保留重启前已经存在的 uncertain 状态；全部字段及 transport 必须保持原样，binding 不能重新变成 open。

产品节点 CLI 遇到暂时连接中断会按带抖动的指数退避自动重连，等待上限从 1 秒翻倍至 30 秒。此场景不重启节点 CLI，要求协调端重启前后节点 PID 相同、进程仍存活，并取得 session ID 不同、epoch 递增的新 session。`coordinator-restart.json` 记录 `nodeReconnect.explicit: false`、节点 PID 和新旧 session。强杀（SIGKILL）后旧 runtime 以 unexpected 停止，历史不确定性保留；正常停止时旧 runtime 已在协调端退出前以 requested 受控停止。已记录的首次停止原因保持不变。每次协调端重启的信号、PID、daemon ID、端口、退出结果和耗时都单独保存。

### 运行中协调端重启

`--scenario coordinator-restart` 在远端 worker 第一次 Linux 自查成功后、发布之前暂停 mock 的后续发布决策，等待实际 WaitForMessage 上传结清，再对协调端发送 SIGTERM。`--scenario coordinator-restart-kill` 在同一个位置使用 SIGKILL。两个场景各运行一次独立 Mission，均使用原协调端 home 重启，并等待原容器中的节点自动重连，全程不重启节点 CLI。

```sh
TMPDIR="$PWD/.acceptance-proof" node acceptance/remote-linux/run.mjs --scenario coordinator-restart --keep --out "$PWD/.acceptance-proof/restart-running-term-1"
TMPDIR="$PWD/.acceptance-proof" node acceptance/remote-linux/run.mjs --scenario coordinator-restart-kill --keep --out "$PWD/.acceptance-proof/restart-running-kill-1"
MC_ACCEPTANCE_CONTAINER_PREFIX=mc-acc-restart- TMPDIR="$PWD/.acceptance-proof" node --test acceptance/remote-linux/coordinator-restart-container.test.mjs
```

容器自测顺序运行这三个场景各两次，最后再运行 default、pause-resume、worker-crash 各一次；即使前一次失败也保存结果并继续。任一次场景或清理失败，整个自测非零退出。该自测不进入 `npm test`，要求设置一个 `mc-acc-` 开头、以 `-` 结尾的专属容器前缀。

运行中场景按产品实际状态检查安全边界，再模拟运营者执行 README 的正规流程。脚本先 GET 导出，检查 Linux 文件仍为原始 version 1，核对成功的写入与自查回执、runtime、mailbox 和投递，再逐个 POST resolve 开放 blocker，最后 POST resume。每一步保存请求方法、路径、正文、HTTP 状态和响应。脚本只读取状态库，不修改任务、旧 runtime、mailbox、投递或 effect，也不直接发送新的工作指令。

正常停止会暂停有运行中远端 runtime 的 Mission，持久化受控停止请求并标记中断投递；节点接口在确认期间继续开放。所有 runtime 共用默认 5 秒的等待上限，可用 `MC_REMOTE_SHUTDOWN_TIMEOUT_MS` 设置为 1 至 10000 毫秒。关闭期间管理员写请求返回 503。换新 runtime 时会原子地创建一条新的系统恢复通知，让 worker 读取持久化历史并继续待办工作；旧投递不重放。只有退出前取得完整的 closed/controlled 证据，重启后才保留恢复资格；超时后到达的报告不能恢复资格。没有运行中远端 runtime 的 Mission 保持原有关闭行为。

结局写入 summary 的 `outcome`。`coordinator-restart` 必须为 `recovered`，`coordinator-restart-kill` 必须为 `irrecoverable`。`recovered` 要求恰好一次重分配、同 worker 与同节点、epoch 严格递增、发布在新 runtime 上，并通过 pause-resume 共用的不重放断言。`irrecoverable` 要求 Mission failed、恰好一个 worker_start_failed，且带 `recoverable: false`、机器可读 reason 和非空 diagnostic。此时旧 binding、mailbox、effect、投递和消息必须保持运营者操作前的状态，worker 工具调用不能增加。effect 或投递重放、无证据的新 runtime、active 且没有 blocker 或诊断、重复生成 blocker、resume 后没有终局诊断的停滞都会使场景非零退出并保留证据。

`coordinator-restart.json` 保存重启前后与每步运营者操作的只读快照，包括 mission detail、runtimes、blockers、mock 请求计数、工具记录、完整 mailbox binding 和 transport。还保留 `mission-export.json`、每次协调端日志及含节点重连状态的 container.log。`summary.json` 只摘录结局与 HTTP 结果，完整 GET 响应留在场景证据中。

2026-10-15 在 `orch/s1-gpt`、基线 `2dbe991` 上，运行中 SIGTERM 与 SIGKILL 重启均实测为 `irrecoverable`：重启后 Mission blocked，旧 runtime closed，stopProvenance uncertain，mailbox uncertain。唯一开放 blocker 的文本为 `Remote runtime ownership became uncertain after coordinator restart. Reconcile ownership and in-flight work before resuming.`。GET 导出与 resolve 返回 200，resolve 后 Mission paused；resume 返回 409 `Prior remote runtime <id>: uncertain runtime report; trusted reconciliation is required`，随后 Mission failed，worker_start_failed 带 `recoverable: false`、`reason: remote_runtime_uncertain` 和同一 diagnostic。没有新 runtime、发布或重放，mock 请求计数保持 19。

以上和下表是 G1 修改前的历史结果。该基线明确拒绝恢复。`src/control.ts:303` 在启动时封锁尚未终结的 runtime，`src/control.ts:1073` 拒绝 uncertain 停止来源，`src/workers.ts:132` 将该拒绝保存为不可恢复的启动失败，`src/control.ts:4111` 输出不支持 trusted reconciliation 的诊断。场景按这个边界判断通过，不能把它报告成运行中任务恢复完成。

逐次运行结果如下，耗时包括清理。首轮六个新场景均因验收钩子缺少可选调用而在重启前失败；第二轮完成后场景的两次失败来自脚本误要求旧 mailbox 必须 closed，实际重启前后都保持 uncertain。已修正为完整 binding 不变且没有重开。第二轮运行中四次均通过。最终轮七次全部通过，所有轮次的清理验证均通过。

| 场景 | 首轮开发验证 | 第二轮断言核对 | 最终验证 |
| --- | --- | --- | --- |
| restart-after-complete | 失败 15.056s、失败 15.879s | 失败 21.508s、失败 23.466s | 通过 25.490s、通过 25.566s |
| coordinator-restart | 失败 14.592s、失败 14.275s | 通过 16.921s、通过 16.849s | 通过 17.341s、通过 16.428s |
| coordinator-restart-kill | 失败 14.404s、失败 14.418s | 通过 28.183s、通过 33.978s | 通过 16.944s、通过 24.717s |
| default | 通过 17.936s | 通过 18.286s | 通过 17.849s |

上述旧基线在已完成 Mission 重启后仍新增通用的 `remote_runtime_uncertain` 事件，这是 `src/control.ts:499` 对远端 agent 的启动记录。实测 runtime 与停止来源仍为 closed/controlled，未生成开放 blocker，不能用这个通用事件推断 runtime 已重新运行。

最终完成后场景的 mock 请求数始终为 31，runtime closed/controlled，开放 blocker 为 0，回执与下载不变；运行中四次均为 closed/uncertain 和不可恢复结局，mock 请求数始终为 19，写入、自查各一次，发布为 0，旧 mailbox、effect、投递与消息在恢复操作后完整不变。default 为 completed/accepted。这里只验证此 mock 时序与同 home 重启，没有真实模型、浏览器或 launchd 验收。

结果索引：`.acceptance-proof/coordinator-restart-results-1792006113253.json`、`.acceptance-proof/coordinator-restart-results-1792006293188.json`、`.acceptance-proof/coordinator-restart-results-1792006541916.json`.


G1 在基线 `18a3cbb` 上完成以下 mock 容器验证。首轮正常重启已成功分配新 runtime，但缺少恢复输入，resume 后停在 active。补上与重分配原子提交的单次系统恢复通知后，最终轮 8 次全部通过。所有轮次均验证本次容器已清理。耗时包含清理。

| 场景 | G1 开发轮 | G1 最终轮 |
| --- | --- | --- |
| restart-after-complete | 通过 28.677s、通过 29.002s | 通过 25.486s、通过 26.466s |
| coordinator-restart | 失败 32.492s、失败 25.360s | 通过 27.194s、通过 26.276s |
| coordinator-restart-kill | 通过 19.317s、通过 17.770s | 通过 16.678s、通过 17.276s |
| default | 通过 17.407s | 通过 17.526s |
| pause-resume | 通过 24.055s | 通过 23.293s |

最终轮正常重启两次均为 `recovered`，单次换新 runtime、epoch 递增、新 runtime 发布且无重放；SIGKILL 两次均为 `irrecoverable`。完成后重启的回执、下载与 runtime 保持不变，default 和 pause-resume 均完成。节点仍按本节描述显式重连，本次没有修改节点连接代码，也没有真实模型或浏览器验收。

G1 结果索引：`.acceptance-proof/coordinator-restart-results-1792009157566.json`、`.acceptance-proof/coordinator-restart-results-1792009453934.json`。

### 中途暂停、回答与恢复

mock 模式可用 `--scenario pause-resume`；省略时仍走原来的正常完成场景，真实模型模式不接受此场景。

```sh
MC_ACCEPTANCE_CONTAINER_PREFIX=mc-acc-i1-gpt- node acceptance/remote-linux/run.mjs --scenario pause-resume --keep --out "$PWD/.acceptance-proof/pause-1"
```

证据父目录须事先创建。worker 第一次 Linux bash 自查成功后调用 Report，然后 WaitForMessage。orchestrator 收到报告后调用 RequestUserInput，Mission 进入 blocked，产品请求停止远端 runtime。脚本只等待物理停止回报，不等待 mailbox 全部结清，也不修改 transport 状态。随后脚本作为人通过 `/api/blockers/<id>/resolve` 回答该 user_input blocker；只有产品仍为 paused 且无开放 blocker 时才显式 resume。这是此场景唯一的人工干预，路径、回答、时间和可选 resume 均写入 `pause-resume.json`。

成功要求恰好一个 remote_runtime_reassigned 事件、新 runtimeId、epoch 严格递增、原节点与原 worker、发布在新 runtime 上完成，以及原有冻结快照验收通过。四个 effect permit/receipt 必须各出现一次，worker 写入、自查、发布、修改各执行一次，投递同一 attempt 的状态回执不能重复，历史 mailbox/effect 记录不得改变。`pause-resume.json` 保存回答前后只读查询的 mailbox、投递和 effect 证据；`mission-export.json` 保存完整导出。回答后严格门槛拒绝恢复、worker_start_failed、其他 blocker 或超时都以非零退出，保留事件诊断、blocker、runtime 与 transport 原因，不解除其他 blocker。

此场景故意在 worker 刚完成 RPC 后停止，失败也是需要保留的产品回归证据。连续 5 次统计可运行独立容器自测，证据保留在当前 worktree 的 `.acceptance-proof/`：

```sh
MC_ACCEPTANCE_CONTAINER_PREFIX=mc-acc-i1-gpt- node --test acceptance/remote-linux/pause-resume-container.test.mjs
```

2026-10-14 在 `orch/i1-gpt`、基线 `4dc93bd` 上实测：默认场景 1/1 通过，17.420 秒；修正后的 pause-resume 连续 5/5 通过，耗时分别为 22.670, 22.572, 21.990, 22.123, 22.083 秒（包含每次运行及清理）。5 次均由产品自动恢复，无须显式 resume；epoch 均从 2 增到 4，同节点分配新 runtime，4 个 effect permit/receipt 各执行一次，10 个 durable delivery attempt 均为 1，清理均通过，严格恢复门槛拒绝 0/5。此前一轮 5 次 Mission 均 completed，但脚本错误要求 epoch 恰好加 1，导致验收断言失败；现已按任务要求改为严格递增，并由单元测试固定覆盖 2 到 4。以上只验证此 mock 时序，不能排除其他时序的恢复拒绝。

### 远端 worker 意外死亡

mock 模式可用 `--scenario worker-crash`。默认场景和 `pause-resume` 不变，真实模型模式不接受此场景。

```sh
node acceptance/remote-linux/run.mjs --scenario worker-crash --keep --out "$PWD/.acceptance-proof/worker-crash-1"
```

证据父目录须事先创建。worker 第一次 Linux bash 自查成功后只调用 WaitForMessage，不发布。脚本看到 `LINUX-SELF-CHECK-OK` 回执、worker 已回到 WaitForMessage、且尚无 artifact 后，再等几个轮询让节点 supervisor 离开当次 mailbox，然后用 `container exec` 在容器内读取 `/proc`：只选择命令行以 `/worker.js` 结尾、且父进程是唯一的 `cli.js node` supervisor 的那个进程，对它 `kill -9`。不杀 supervisor、bootstrap 或当前 exec。定位依据、PID、命令行、supervisor PID 和信号结果写入 `worker-crash.json`。

随后脚本等待该 runtime 的停止来源落成 `unexpected`、`uncertain` 或 `unproven`，且不是 `controlled`。Mission 必须被阻塞，并存在 id 为 `remote-runtime:<runtimeId>` 的 blocker。脚本逐个 resolve 开放 blocker，再调用 resume；每一次的路径、正文、时间和 HTTP 结果都写入 `worker-crash.json`。resume 若因意外停止被拒绝，产品会先把 Mission 标为 failed 再返回 409；脚本把该 409 当作 fail-closed 结果继续读取 Mission，不把它当成需要重试的恢复。

成功要求：停止来源不是 controlled；恰好一条 `worker_start_failed`，其 `data.diagnostic` 说明意外停止、停止无法证明或 runtime 报告不确定；Mission 为 failed；全程没有 `remote_runtime_reassigned`；没有发布（artifacts 为 0）；worker 的 write_file 与自查 bash 各一次，没有第二次，也没有 PublishArtifact；effect permit、回执、durable delivery 和 message attempt 在 resume 前后不变，没有 `delivery_resumed`。任一偏差都以非零退出保留证据。若节点 supervisor 自己在终止回报落成之前退出，runtime 会停在 `stopping` / `unproven`，脚本立即失败并保留容器输出，不把这种情况当成通过。

连续 3 次可运行独立容器自测，证据留在当前 worktree 的 `.acceptance-proof/`。它不进入 `npm test`：

```sh
node --test acceptance/remote-linux/worker-crash-container.test.mjs
```

2026-10-14 在 `orch/l2-grok`、基线 `b9e4d4c` 上实测：worker-crash 连续 3/3 通过，耗时 18.606、15.789、14.898 秒（含清理）。3 次停止来源都是 unexpected，runtime 为 closed，Mission failed，artifacts 为 0，effect receipt 为 2，resume 返回 409，diagnostic 说明 unexpected stop，没有 `remote_runtime_reassigned`，清理均通过，无残留容器。同前缀接着跑的 default 1/1 通过，18.351 秒，Mission completed。此前一轮连续运行的第 3 次在杀掉 worker 后，节点 supervisor 打印 `Node connection failed` 并退出，runtime 留在 stopping/unproven，Mission 仅 blocked，没有进入 resume；脚本现已把这种情况立即判失败。上面的 3/3 不包含那一次。这只验证此 mock 时序。

### 整个远端节点断电后用同一 home 重启

mock 模式新增 `--scenario node-power-loss`，不接受真实模型配置。运行命令：

```sh
mkdir -p .acceptance-proof
MC_ACCEPTANCE_CONTAINER_PREFIX=mc-acc-s2-astra- node acceptance/remote-linux/run.mjs --scenario node-power-loss --keep --out "$PWD/.acceptance-proof/node-power-loss-1"
MC_ACCEPTANCE_CONTAINER_PREFIX=mc-acc-s2-astra- node --test acceptance/remote-linux/node-power-loss-container.test.mjs
```

只有此场景把宿主 `<proof>/node-home` bind mount 到 `/node-home`，实际节点 home 为其中的 `state/` 子目录。子目录避开 Apple Container 对挂载根目录执行 `chmod` 的 `EPERM`，不改产品代码。worker 完成第一次 Linux 自查、所有成员空闲且尚未发布后，脚本执行 `container kill --signal KILL <本次容器名>`，确认整个容器退出并被 `--rm` 清理。产品租约固定为 20 秒，没有覆盖参数；脚本使用默认 180 秒总超时，记录发出 SIGKILL 到协调端可观察到 offline、blocked 及所有权不确定的实际耗时。

断电后必须有 `remote-runtime:<runtimeId>` blocker，旧 binding 不变、停止来源为 uncertain 或 unproven、artifacts 为 0，无重新分配和重放。脚本随后用同一个 home、machine 身份和 node token 创建新容器；token 再次经 stdin 传入。重连必须取得新的 sessionId、更大的 sessionEpoch，并再收到一次心跳。只读检查节点 journal 要求旧 runtime 为 uncertain、没有伪造 confirmed stop；检查 `/proc` 要求 supervisor 存活且没有 worker。之后逐个 resolve 开放 blocker，并显式 resume；路径、请求正文、时间和 HTTP 响应分别记录。最终必须出现一次 `worker_start_failed`，含 `recoverable: false` 和机器可读 `reason`，Mission 为 failed。effect permit/receipt、节点 effect journal、worker 工具调用、durable delivery attempt 不得重放，resume 前后投递状态不得改变。

`node-power-loss.json` 包含断电前、租约丢失、重连和最终快照、SIGKILL 记录、节点 journal、进程列表、耗时和运营者操作；失败时仍保存 Mission 导出、runtime、transport、节点退出日志和可读取的持久 journal。任一断言失败或重启退出均返回非零，不修改 journal 来绕过故障。持久 home 跟随整个证据目录：成功默认删除，`--keep` 或失败保留。独立容器自测连续运行新场景 3 次，再各运行一次 default 和 worker-crash；第三次新场景设为成功时删除证据，并检查 home 同步删除，失败则保留。此自测不进入 `npm test`。

2026-10-15 在 `orch/s2-astra`、基线 `8a5f3c3` 上修复节点所有者锁后，node-power-loss 连续 **3/3 通过**，总耗时依次为 41.514、41.325、41.383 秒；从 SIGKILL 请求到观察到租约丢失依次为 21.331、22.188、22.065 秒。3 次均用同一 home、machine 和 token 重连，取得新 session 并收到后续心跳；旧 binding 未被认领，旧 worker 未重启，节点 journal 和协调端 runtime 均为 uncertain。运营者 resolve 后显式 resume，得到不可恢复的 Mission failed、`worker_start_failed.recoverable: false`、`reason: remote_runtime_uncertain`，artifacts 为 0，无 effect、投递或 worker 工具调用重放。保留的两次证据中，重启前后节点 PID 均为 9，resume 均返回 HTTP 409。

随后 default 通过，17.656 秒、Mission completed；worker-crash 通过，14.901 秒、Mission failed。5 次均 cleanupVerified=true，`mc-acc-s2-astra-` 前缀无残留。第三次新场景没有 keep，已验证成功后证据目录及持久 node home 一并删除；其余四次保留证据。结果汇总为 `.acceptance-proof/node-power-loss-results-1792006901622.json`。额外的 `test/node-owner.test.mjs` 在 macOS 和 Linux 均为 6/6 通过；Linux 容器整体耗时 48.007 秒，覆盖陈旧 PID、活所有者互斥、SIGKILL、正常退出及启动失败后的接管，结束后同样无残留。

修复使用 `node.ownership.sqlite` 的生命周期独占锁。进程退出、SIGKILL 或重启后由操作系统释放，不再以旧 PID 是否存活判断所有权。`node_owner` 表保留兼容记录；取得锁后仍按原有规则将旧 runtime 恢复为 uncertain，不生成 controlled/stopped 证明，不重放旧工作。新版本之间的同进程重复打开和不同进程并发打开都会拒绝；升级前须停止不参与新锁协议的旧节点程序。修复前的 0/3 失败记录仍保留在 `.acceptance-proof/node-power-loss-results-1792006210613.json`，供比较。

### 远端 worker 的轮次上限与恢复

mock 模式新增 `--scenario turn-limit`，真实模型模式拒绝该场景。`maxTurns` 固定计算为 16：orchestrator 设置任务和成员、发送消息与等待共 11 轮，validator 初次读取状态与等待共 2 轮，worker 读取状态、写文件与选择 Linux 自查共 3 轮。场景将 worker 的首次状态读取等到任务分配完成；orchestrator 的发送消息响应则等到 Linux bash 已完成内容自查。bash 在退出前通过随机 mock 路径同步，等最后一次本地模型准入占满预算。该本地响应暂不返回，避免本地 turn_end 提前触发停止；bash 退出并落库自查回执后，下一次远端 worker AdmitTurn RPC 必须触顶。同步只用于脚本化 mock，不修改产品状态库或产品代码。

```sh
mkdir -p .acceptance-proof
TMPDIR="$PWD/.acceptance-proof" node acceptance/remote-linux/run.mjs --scenario turn-limit --keep --out "$PWD/.acceptance-proof/turn-limit-1"
TMPDIR="$PWD/.acceptance-proof" node --test acceptance/remote-linux/turn-limit-container.test.mjs
```

容器自测顺序运行 turn-limit 三次、default 一次、pause-resume 一次；逐次保存结果、完整耗时、清理结果和证据路径，即使前一次失败也继续其余场景，最后有任一次失败便非零退出。它不属于 `npm test`。

`turn-limit.json` 保存同步点、blocked 快照、物理停止回报、只读读取 control.sqlite 的 transport、触顶 RPC 与拒绝回复、Linux 自查回执及每次运营者动作。触顶事件必须匹配旧 runtime binding 的 agentId、epoch、generationId，协调端 inbox 必须为 applied，并有唯一落库拒绝回复；旧 runtime 必须 closed 且 stopProvenance 为 controlled。脚本通过 PATCH 将 maxTurns 从 16 提到 96，再逐个解决开放的 blocker，然后按需 resume。对 delivery blocker，先核对其精确 outbox attempt、对应 uncertain 消息、受控停止回报、写入与 Linux 自查成功回执及尚未发布的状态，将真实核对结论写入 resolution 和证据；limit blocker 则记录调高后的预算。无法核对的 blocker 使场景非零退出。每次动作记录方法、路径、正文、时间、响应或完整错误，人工动作不改变任务状态，也不直接给 worker 发指令。

恢复后团队没有待处理输入、没有忙碌 agent，且事件序列连续 2 秒不变时，脚本最多给 orchestrator 发一条普通 followUp 消息，请其读取状态并继续；方法、路径、消息和响应写入 humanActions。消息发出后再次持续空闲 10 秒便记录完整停滞快照和只读 transport，并非零退出。

成功要求出现恰好一个 remote_runtime_reassigned，同节点、同 worker、epoch 递增，最终 completed，并通过 pause-resume 共用的 effect、投递、工具调用和历史 mailbox 不重放检查。额外逐条比对已对账投递的完整 outbox 与消息，要求保持原来的 uncertain 状态和 attempt，不发生重放。恢复拒绝、worker_start_failed、Mission failed、剩余 blocker 或停滞均使脚本非零退出，保留 mission-export.json、runtimes.json 和全部拒绝证据。产品是否生成 limit blocker 如实记录。

2026-10-14 在 `orch/l1-gpt`、基线 `b9e4d4c` 上连续运行：turn-limit 三次均非零退出，完整耗时为 16.469、16.449、16.279 秒；default 通过，23.054 秒；pause-resume 通过，23.647 秒。五次清理均通过。三次 turn-limit 都有 Linux 自查回执 seq 72，随后远端 worker 拒绝事件 seq 74，触顶 RPC 的协调端 inbox 为 applied，旧 runtime 为 closed/controlled。PATCH 将 maxTurns 提到 96 成功，resume 返回 HTTP 409 `Resolve mission blockers before resuming`，Mission 保持 blocked，没有新 runtime。

此基线的 `admitTurn` 在触顶时只保存 generation denial、设置 blocked 并记录事件，没有插入 limit blocker；停止过程则将仍在执行的投递记为 uncertain 并生成三个 delivery blocker，其中一个属于场景故意保留的本地模型请求。脚本保存全部原因，并按授权范围保留这些 blocker。第一轮因此只完成 RPC 回复落库验收；恢复、epoch 递增、最终 completed 和恢复后不重放当时尚未通过。第二轮合并 `orch/int@90ea9a6` 的 M1 修复后，按上述运营者对账流程重新验收；场景实现未编辑 src/。

2026-10-15 第二轮在合并 `orch/int@90ea9a6` 后实测：turn-limit 连续 3/3 通过，完整耗时为 24.101、22.837、22.927 秒；default 通过，17.546 秒；pause-resume 通过，23.291 秒。五次清理均通过。三次 turn-limit 都由远端 worker 的 AdmitTurn 在自查后触顶，inbox 为 applied，旧 runtime 为 closed/controlled；运营者执行 PATCH、逐个对账解决三个 delivery blocker、resume，共五次动作，无须额外消息。恢复后同节点、同 worker 的新 runtime epoch 均从 2 提到 4，Mission completed，四个 effect permit/receipt 各出现一次，write_file 一次、bash 两次、PublishArtifact 一次，七个 durable delivery attempt 都为 1。三个已对账投递的完整 outbox 和消息在结束时与恢复前完全相同，仍为 uncertain；历史 mailbox/effect 未改变，独立冻结快照复核通过。证据索引为当前 worktree 的 `.acceptance-proof/turn-limit-results-1791997222290.json`。

开发阶段首轮恢复已成功，但旧 mock 在任务进入 review 后再次读取状态时错误要求 running，导致脚本失败；现已修正为等待，并补充单测。该开发运行耗时 21.370 秒，修正后开发复核通过，29.045 秒。上述容器运行均在旧 runtime 停止确认后 resume；未用此场景覆盖停止报告尚未返回时的等待分支，也未实际触发可选的 orchestrator 普通消息分支，该分支由单测覆盖。

普通 `npm test` 包含 mock 协议与决策单元测试，不启动 Apple Container。容器验收测试单独运行：

```sh
node --test acceptance/remote-linux/container.test.mjs
```

脚本自身的测试（依赖 Apple Container，不属于 `npm test`）在 `npm run build` 之后运行：

```sh
node --test acceptance/remote-linux/container.test.mjs
MC_ACCEPTANCE_TEST_KEEP=1 node --test acceptance/remote-linux/container.test.mjs
node --test acceptance/remote-linux/lifecycle.test.mjs
MC_ACCEPTANCE_CONTAINER_PREFIX=mc-acc-g-gpt- node --test acceptance/remote-linux/session-container.test.mjs
```

容器测试默认检查成功后目录已删除；环境变量 `MC_ACCEPTANCE_TEST_KEEP=1` 检查 `--keep --out` 保留的 summary，再删除该次测试证据。生命周期测试分别验证真实运行中的 SIGINT 和超时，先检查失败证据保留与清理结果，再删除该次测试证据。`session-container.test.mjs` 使用本地 faux provider 生成实际会话库，停止 Harness 后在缓存的 Linux Node 22 中以只读挂载查询，并故意输出 stderr，验证 stdout JSON、token 和原库 hash。上述命令应依次执行，避免同一容器名前缀的验收互相影响。

## 真实模型模式

此模式由真实模型自行选择工具，不启动脚本化 mock。配置文件为 JSON，顶层固定包含 `orchestrator`、`worker`、`validator` 三个产品 profile，字段为 `name`、`api`、`modelId`、`baseUrl`、`credentialEnv`、`contextWindow`、`maxTokens`、`reasoning`、`toolCalling`、`vision`，可选完整的 `cost`。不支持把密钥写入配置。未知价格必须省略 `cost`，产品会保留 `costKnown: false`；不能把未知价格填成 0。示例的 token 上限沿用产品 preset，可按服务实际限制调整，不代表已验证服务能力。

- `real-minimax.json`：本地 orchestrator/validator 用 MiniMax-M2.5，Anthropic Messages API，`https://api.minimaxi.com/anthropic`；远端 worker 用 MiniMax-M2.7，OpenAI Completions API，`https://api.minimaxi.com/v1`。凭据引用均为 `MINIMAX_CN`。
- `real-glm.json`：三个角色均配置 glm-5.3（产品内置 GLM 预设是 glm-5.3-flash；2026-10-15 用 glm-5.3-flash 跑两次真实验收均未完成，三个角色都用它时编排能力不足），OpenAI Completions API，`https://open.bigmodel.cn/api/coding/paas/v4`，凭据引用为 `ZHIPU_API_KEY`。Coding Plan 会映射旧模型名（2026-10-15 预检观察到 glm-4.7 被映射为 glm-5.3-flash，glm-5.3 返回 glm-5.3），实际响应名从会话库的 `responseModel` 读取；与配置不同会在 summary 的 `modelMismatches` 中标注，配置名不作为实际模型的证明。

智谱 Coding Plan 的专用端点为 `https://open.bigmodel.cn/api/coding/paas/v4`，通用按量 API 端点为 `https://open.bigmodel.cn/api/paas/v4`。Coding Plan key 须有可用的编程套餐权限，通用 API key 须有开放平台资源包或充值余额；运行者须核对 key 的发行渠道与权限，不能假定可互换。同名 `ZHIPU_API_KEY` 仅是引用名称。示例保留 Coding Plan 端点，脚本不替换端点、不试探 key。两种端点及 key 要求见[智谱官方端点说明](https://zcode.z.ai/cn/docs/qa)；通用 API 使用平台余额或资源包，Coding Plan 使用套餐权益。

运行者自行准备 secrets 文件。它必须是当前用户拥有的普通文件，权限恰好为 0600；软链接、目录、FIFO、其他用户的文件和其他权限一律拒绝。以下只有占位符，运行时在文件里填写自己的值，不要把真实值放进命令行或提交仓库：

```text
MINIMAX_CN=<运行者自行填写>
ZHIPU_API_KEY=<运行者自行填写>
```

格式为逐行 `KEY=VALUE`。等号后的内容保持原样，不解释引号、空格、美元符号或 shell 表达式；空值、控制字符、引用名称缺失或重复均拒绝。只取配置引用的名称，其他行忽略；不从当前 shell 环境补取密钥。

```sh
chmod 600 /私有目录/models.env
npm run build
node acceptance/remote-linux/run.mjs --real acceptance/remote-linux/real-minimax.json --secrets-file /私有目录/models.env
node acceptance/remote-linux/run.mjs --real acceptance/remote-linux/real-glm.json --secrets-file /私有目录/models.env --out /指定的/新证据目录 --timeout-ms 1800000
```

### 本地彩排

`--real <config> --rehearsal` 使用指定配置的 API、modelId 和 credentialEnv，只将 baseUrl 改为本地假模型服务。支持 Anthropic Messages 与 OpenAI Completions SSE。假服务逐请求核对配置模型名和 API 对应的凭据请求头，不记录凭据值，返回工具调用及 token usage。远端 worker 沿用宿主中继。此开关与 `--secrets-file` 互斥，不读取用户 secrets 或 shell 中的模型凭据。

脚本在证据目录生成随机值的 0600 `rehearsal.env`，通过真实模式的 `readSecrets` 读取，结束时删除原文件，再对全部证据扫描这些假凭据。题面、冻结验收、发布后故障注入、成功门槛、只读会话取证、oracle 审计、独立容器复核和清理均复用真实模式代码。summary 保留 `mode: "real"` 并添加 `rehearsal: true`、`modelRequests`、`modelRequestTools`。orchestrator 会先用 shasum -a 256 读取冻结入口脚本，成功彩排的 oracleReads 保留这次读取。彩排证明脚本流程；实际服务能力与真实模型表现仍需真实运行验证。

```sh
node acceptance/remote-linux/run.mjs --real acceptance/remote-linux/real-minimax.json --rehearsal --out .acceptance-proof/minimax-rehearsal
node acceptance/remote-linux/run.mjs --real acceptance/remote-linux/real-glm.json --rehearsal --out .acceptance-proof/glm-rehearsal
MC_ACCEPTANCE_CONTAINER_PREFIX=mc-acc-rehearsal- node --test acceptance/remote-linux/rehearsal-container.test.mjs
```

容器自测依次跑两个配置的正向彩排和错误实现负向彩排。负向 worker 省略字段和安全整数检查，自查普通订单通过，冻结业务测试必须拒绝并由 validator 记录失败决定；orchestrator 请求修正并产生 blocker，运行进程必须以冻结验收失败原因非零退出。负向选项仅供程序化自测，不暴露 CLI。每次保留结果、耗时、模型请求数、工具序列及清理证据，最后核对独占前缀无残留。测试在 `acceptance/`，不进 `npm test`。逐次运行记录及已复现的产品结束竞态见 [REHEARSAL_FINDINGS.md](REHEARSAL_FINDINGS.md)。

协调端只通过 env 接收本地角色所需的凭据。Linux 节点只通过 `container run -i` 的 stdin 接收 worker 所需的凭据和 node token，再用 `--credential-ref` 显式放行名称。值不进入 argv、挂载文件或证据；输出按全部已读凭据脱敏，在 summary、日志和其他证据全部写完后，递归扫描证据文件，包括 SQLite 与二进制文件，发现任一凭据原值即失败。

真实模式默认超时 30 分钟，`--timeout-ms` 可修改。三个角色共用最多 60 轮，包含辅助模型请求，可能发生真实计费。示例未声明价格，`maxCost: 0` 表示没有金额上限；不能用未知价格计算金额或声称免费。轮数在模型请求准入时递增；达到 60 轮后，脚本继续等待已准入的请求结束。Mission completed 可以通过，failed/blocked 或团队空闲时的预算拒绝证据会判失败并保留证据。总超时不变。成功默认也保留；只有成功时 `--discard` 才删除，不能与 `--keep` 同用。

Mission 使用 shared workspace，`remoteWorkspaceIds` 只有本次 Linux workspace。产品默认 `approve` 会等待人工批准文件写入、shell 和验收命令；此无人值守复现明确选择 `trusted`，以便脚本全程不发送人工消息、不解除 blocker、不调用 resume、不通过 API 修改任务状态。模型仍需自己创建任务、交付、验收和完成 Mission。

宿主生成 `totals.acceptance.test.mjs` 和 `run-frozen-acceptance.mjs`，两份文件权限均为 0400，分别记录 SHA-256，且不挂载给 Linux worker。macOS 分别尝试 `chflags uchg`，记录成功或失败，结束时解除以便清理；chflags 子进程只接收 PATH。验收命令为单层路径引用 `'<node>' '<入口脚本>'`，不再包含内联 JavaScript 或 `&&`；路径本身含单引号时改用双引号并转义 shell 展开字符。入口脚本先按写死的 SHA-256 校验测试文件，再用 `process.execPath --test --test-reporter=tap <测试文件>` 运行 node:test，继承 cwd 与 stdio，转发退出码或终止信号；回执命令须逐字节相同，或在严格的 POSIX shell 字面词法子集中等价：去掉引号后的词及 `&&` 序列完全相同。支持单引号、不含展开的双引号、引号外反斜杠转义、空格和制表符；出现展开、未加引号的通配符、其他控制运算符、重定向、换行、注释或不支持的语法时，仅接受逐字节相同。发布时、新回执被轮询发现时、结束时分别核对两份文件的 hash 与权限，`checks[].files` 保留逐文件结果。导出中的所有本地 agent 的 `shell_evidence` 和 tool transcript 都会接受检查；与冻结命令逐字节相同或满足上述词法等价的本地执行、能明确解析为只读的测试文件或入口脚本命令（如 cat、sha256sum、简单读取管道、sed 打印和 node --test）以及 read_file 会记入 oracleReads，不导致失败。修改、写入重定向、可写解释器、命令替换和无法确认只读的引用记入 oracleTouches 并使验收失败；对证据目录的既有检测保持不变。测试进程不导入被测 `totals.mjs`。每次调用在独立 Node 子进程中导入交付模块，只传入固定输入，再从独立管道读取结构化的返回值或抛错结果，由父测试进程断言。`node:v8` 二进制序列化保留 NaN、Infinity 和 undefined；交付模块的 stdout 与结果分开。父进程每次生成随机 nonce，与输入经 stdin 发送；runner 在加载交付模块之前读完输入，保存传输函数的普通常量引用。结果采用四字节长度头加带 nonce 的二进制载荷，父进程要求恰好一帧、无尾随字节且 nonce 匹配，防止交付模块插入伪造结果或通过同步内置模块导出替换传输函数。子进程只继承 PATH，单次调用限时 5 秒后发送 SIGKILL、输出限 64 KiB；非零退出、超时或损坏的结果均使测试失败。宿主验收和新容器复核使用同一份原始测试源码，均采用此隔离方式。此协议不构成操作系统沙箱；被测代码若另起子进程并继承管道，五秒终止只覆盖直接子进程，管道关闭仍可能受后代进程影响，需由外层验收进程组停止和容器清理兜底。四个用例验证导出的 `totalCents(lines)`：空订单为 0、多行合计、整数分乘法与零值、拒绝负数/非整数/非数字/缺字段及超出安全整数的金额。每行字段是 `quantity` 与 `unitPriceCents`，完整规则同时写入 goal、acceptance 和 assertion，模型无须读取宿主测试源码。

Mission 题面只提供业务规则、`/work/totals.mjs` 交付位置和独立验收命令；角色说明仅声明角色名称，任务推进由产品提示和模型自行完成。worker 在 `/work/totals.mjs` 交付冻结 artifact。首次发布路径不符合 `/work/totals.mjs` 时，脚本记录 `rejected-publications.json` 并继续等待正确发布，不修改 Mission 题面。脚本观察到正确的 worker `artifact_published` 事件后，用 `container exec <本次容器名> node -e ...` 把源文件改成 `throw new Error("mutated after publish")`，记录改写前后 hash，并检查协调端 CAS hash 不变。脚本只等待结果；模型不能通过修复或再次发布绕开本次故障。独立本地 validator 必须用 Mission 中逐字节相同或满足上述 shell 词法等价的命令和 artifactIds 调用 RunValidation，成功回执需为 remote-snapshot、snapshotIntegrity true，四个用例全过。验收通过依据 CAS hash、remote-snapshot、snapshotIntegrity 和回执 artifact digest；注入与回执的时间戳只作为记录。完成时再检查宿主测试与入口脚本的 hash、权限和 CAS hash，Mission completed、恰好一条任务 accepted、无 blocker 才通过。该任务的最终成功 validator 决定必须引用覆盖 totals.mjs 冻结快照的匹配回执；其他任务仅允许 cancelled 或 attempt 为 0 且从未进入 running/review。真实模式在 Mission 结束后先确认已观察到远端 Linux worker 发布；缺失时直接报告目标 machineId 和各 worker 的 machineId/workspaceId，跳过无输入的独立容器复核。summary 的 agentLocations 保留全部 agent 的位置摘要。随后按 artifact 的 remoteProvenance 核对交付 worker 的 runtimeId、agentId 和 machineId，并等待本 Mission 的全部 runtime 进入 closed；其他 worker 的 runtime 不导致数量断言失败。mock 的固定 runtime 数量、唯一任务及唯一 artifact 断言保持不变。

真实模式额外证据：

- `real-config.json`、`frozen-acceptance.json`、`totals.acceptance.test.mjs`、`run-frozen-acceptance.mjs`：实际 profile 配置、两份冻结文件的 SHA-256、权限和三个阶段的逐文件检查，以及四个业务测试和验收入口。
- `mission-export.json`：产品导出，包括事件、generationAdmissions、transcript、验收回执和 blockers。
- `session-evidence.json`、`node-evidence-stop.json`：协调端退出及远端节点、worker 停止后，只读查询 pi-durable 会话库的结果和节点停止记录。协调端库在 `home/agents/<agentId>.sqlite`；远端库在容器 `/node-home/worker-runtime/agents/<agentId 的 SHA-256>.sqlite`，清理容器前使用 `container exec` 的 `node:sqlite` 查询，只解析 stdout。节点停止后只保留容器和 bootstrap 等待进程，读库结束即清理。
- `real-evidence.json`：最终状态、轮数/60、每个 agent 及角色的模型计数、累计 token、工具调用名称序列、artifact/CAS hash、故障注入和回执。每条回执的 `commandMatch` 为 `exact`、`shell-equivalent` 或 null；summary 的 `acceptanceReceipt` 记录独立复核选中回执的 ID 和匹配方式。`modelCalls` 计数会话库中已提交的 assistant 响应，包含错误与重试响应；`admittedModelCalls` 另记产品准入数，包含辅助请求，不能把准入数称为已完成的提供商调用。usage 汇总各会话最新 `pi.usage` 文档的 models 桶，包含辅助调用，排除 tools 桶。工具名取 assistant 的 toolCall，按每个 agent 的 commit_seq、entry ID 和响应内位置排序，不记录参数或隐藏推理，也不依靠跨进程时钟排序。响应模型证据保留配置名、API `responseModel` 名、各名称的调用数及不一致标记；没有 `responseModel` 的调用记为未报告，不推断实际名。库读取失败显示 `complete: false`、错误类别和安全的 `error.code`，该 agent/角色的计数与 usage 为 null，整体标记 `evidenceComplete: false`，不单独使业务验收失败。未知金额为 null。`oracleReads` 记录本地工具对冻结测试、入口脚本的只读引用和匹配冻结命令的执行，`oracleTouches` 记录修改或无法确认只读的引用；两者保留 agentId、来源、事件 seq 或 transcript entryId 及命令。summary 同样保留这两组记录。
- `fault-injection.json`：触发事件序号、artifact ID、源文件改写前后 SHA-256、CAS 改写前后 SHA-256 和注入结束时间。
- `independent-review.json`、`independent-inputs/`、`host-runtime.json`、`rejected-publications.json`：独立容器复核结果及输入、Node hash 和不符合交付路径的发布记录。原始测试在脚本内存中保留，复核不从可能被修改的宿主测试文件读取。
- `summary.json`：验收及清理结果；成功时有模型计数、usage、`modelMismatches` 和最终 CAS hash。失败时保留已取得的 Mission/export/evidence，即使超时也尝试只读导出。最终凭据扫描覆盖 summary 及所有晚写文件，扫描失败会非零退出。收尾期间收到 SIGINT/SIGTERM 时继续清理，最终 summary 标为失败、非零退出并保留证据，`--discard` 不删除中断证据。

普通测试中的 `test/remote-linux-real.test.mjs` 只用假凭据和本地进程，覆盖配置、文件权限、脱敏、stdin 传递、故障注入、四个业务测试、固定 hash 命令、预言触碰检测、stdout/stderr 分离、最终扫描顺序、实际 pi-durable 库的只读查询、响应模型名、错误类别、额外任务、纠正发布、独立复核分歧、宿主 Node hash、最后一轮准入等待、多 worker 停止检查及被测模块修改内置模块后的进程隔离，不调用任何外部模型。真实 MiniMax/GLM 运行须由持有凭据的运行者执行，单元测试和 mock 容器通过都不能代替这一结果。

## 预检

正式验收最多 60 轮，可能产生真实费用。先跑预检，确认每个不同的 `(api, baseUrl, modelId, credentialEnv)` 组合都能完成一次最小工具调用。每个组合只发一次请求，客户端重试次数为 0。只有响应正常结束且包含 ping 工具调用才通过；provider 报错、取消、超时、缺少结束标记或输出额度截断均失败，即使 HTTP 为 200 且已经出现工具名。预检使用产品同一套 pi-ai provider，提供一个名为 `ping` 的工具，并在提示中要求调用它；与正式运行一样不强制 `tool_choice`（部分兼容端点只支持 `auto`）。请求关闭 reasoning 参数，`maxTokens` 为 1024，避免默认开启思考的模型在调用工具前耗尽输出额度。默认单次请求超时 60 秒，可用 `--timeout-ms` 修改。

```sh
npm run build
node acceptance/remote-linux/preflight.mjs --real acceptance/remote-linux/real-minimax.json --secrets-file /私有目录/models.env
node acceptance/remote-linux/preflight.mjs --real acceptance/remote-linux/real-glm.json --secrets-file /私有目录/models.env --from-container
```

`--from-container` 把远端 worker 那一个组合改到临时 Apple Container 里请求，用来确认容器网络能够到达 endpoint。同一组合不会在宿主上再请求一次。容器镜像必须是本机已缓存的 `node:22-bookworm-slim` arm64；缺失时直接失败，不拉取。容器名默认使用 `mc-acc-` 前缀，可用 `MC_ACCEPTANCE_CONTAINER_PREFIX` 覆盖，覆盖值仍须以 `mc-acc-` 开头。运行带 `--rm`。预检保存本次容器名，正常结束、超时、异常和 SIGINT/SIGTERM 后均按精确名字停止并删除，再核对此前缀无残留；清理失败会使预检失败，结果记录 `containerName` 和 `cleanupVerified`。中断后不再探测其余模型组合。只读挂载 `dist`、`node_modules` 和预检脚本。密钥只经 stdin 传入容器，不进入 argv、环境变量或挂载文件。若启动前已有同前缀容器，预检拒绝运行，由该容器的所有者处理。

标准输出是一行 JSON。`pass` 是总体结论。`checks` 的每一项对应一个组合，包含角色、`transport`（`host` 或 `container`）、HTTP 是否成功、状态码、延迟、是否返回名为 `ping` 的工具调用、token usage、`responseModel`，以及 `errorCategory`。`responseModel` 来自 pi-ai 读到的提供商流事件里的 `model` 字段；流里没有该字段，或请求在返回模型名之前失败时为 null，并由 `responseModelReason` 说明原因。部分兼容端点会把配置里的 `modelId` 映射成另一个模型。映射结果与 `modelId` 不同时，该项 `modelMismatch` 为 true，顶层 `modelMismatches` 列出这些组合，并带有 `notice`。这个标记不改变 `pass`；工具调用和容器清理均成功时退出码才为零。错误类别包括 `auth`、`timeout`、`http`、`network`、`no-tool-call`、`provider`、`container`。配置或 secrets 文件不合法时 `checks` 为空，并给出不含密钥的 `error`。任何输出都会脱敏。退出码非零表示先不要进入上面的正式验收。预检通过后再运行 `run.mjs --real`。

### 四场景与隔离回归

构建后运行下列测试。它依次运行 default、pause-resume、worker-crash 和 turn-limit 各一次，再用新 Linux 容器核对隔离的四个 totals 用例。正确实现须通过；修改 node:assert 的错误实现须失败，且独立复核须指出它与假定成功回执的分歧。该测试只使用确定性 mock 和固定交付模块，无外部模型请求。结果、耗时与复核 TAP 保存在当前 worktree 的 `.acceptance-proof/regression-<时间戳>/`。须用 `MC_ACCEPTANCE_CONTAINER_PREFIX` 指定本次独占的前缀，形如 `mc-acc-<名称>-`；默认的 `mc-acc-` 会被拒绝。测试最后核对该前缀无残留容器。

```sh
MC_ACCEPTANCE_CONTAINER_PREFIX=mc-acc-regression- node --test acceptance/remote-linux/regression-container.test.mjs
```

### 结果通道与预检清理回归

构建后运行以下专用容器测试。它只用本机缓存镜像和监听 `192.168.64.1` 的本地假模型服务：正确 totals 实现须 4/4 通过，向结果管道注入伪造结果的错误实现须失败；无响应服务的预检超时和 SIGINT 中断均须非零退出、清理本次容器且前缀无残留。证据目录写入 TMPDIR 并打印路径，不调用真实模型。

```sh
MC_ACCEPTANCE_CONTAINER_PREFIX=mc-acc-rv7-a-astra- node --test acceptance/remote-linux/integrity-container.test.mjs
```

H5 的命令变更依据 MiniMax 运行 `/Users/wu/.mc-orch/real/minimax-20261015-085308/`。该次 `mission-export.json` 的首条回执把内联脚本中的 `'\''` 引号转义抄成连续单引号，stderr 报 `SyntaxError: missing ) after argument list`，测试尚未运行。新命令只含 Node 与入口脚本的路径引用，此次路径均不含单引号，因此没有该段嵌套引号可供误抄；这说明该特定语法错误的来源已移除，实际模型是否正确执行仍需新一轮真实验收。该次 `summary.json` 的 orchestrator 在 shell_evidence seq 207 及 tool transcript 中原样执行了当时的冻结命令。按 H5 的匹配规则，这两条执行在提供当时冻结命令作为比较基准时均归为 `oracleReads`；新运行使用新入口命令作为比较基准，旧内联命令不会获得新命令的只读豁免。

## local-process 后端（Linux / macOS，无需容器）

`--backend local-process` 使用本机 Node CLI 子进程作为远端节点。默认仍为 `--backend container`，容器路径、镜像要求和隔离断言保持原有行为。前提为 Node >= 22.19、已构建的 `dist/`、已有依赖、POSIX `/bin/sh` 与 `ps`，以及创建回环监听、detached 进程和发送 SIGSTOP/SIGKILL 的权限。彩排还需要 `shasum`。Linux 云环境先完成仓库环境准备，不需要 Apple Container。

```sh
npm run build
node acceptance/remote-linux/run.mjs --backend local-process --scenario default --keep
node acceptance/remote-linux/run.mjs --backend local-process --scenario node-power-loss --keep
node acceptance/remote-linux/run.mjs --backend local-process --real acceptance/remote-linux/real-minimax.json --rehearsal --discard
# 串行运行下面全部场景及 minimax/glm 正反彩排，不进入 npm test
node --test acceptance/remote-linux/local-process.test.mjs
```

runner 默认在 TMPDIR 下创建权限 0700 的独占 proof，拒绝复用已有目录。可用 `--out` 指定不存在的 proof 路径。节点持久化 home 和工作区位于 proof 的 `local-runtime/`，与协调端 home 分离，全部网络监听绑定 `127.0.0.1`。稳定 HTTP relay 在协调端重启时切换目标，节点 CLI 保持原进程。节点 token 与模型凭据经 stdin 传入 bootstrap，再通过最小环境交给 CLI，日志与 argv 不含凭据值。worker 的 shell 继续验证不继承模型凭据。macOS 使用节点实际 `darwin` 能力，Linux 使用 `linux`，不伪造平台值；交付 JSON 中历史 `platform: linux` 是固定业务 fixture。

| 场景 | local-process 支持与通过条件 |
| --- | --- |
| default | 完成、任务 accepted、冻结快照 hash、下载内容和独立复核通过 |
| pause-resume | 受控停止后更高 epoch 的新 runtime 恢复，旧 mailbox/effect 不变 |
| turn-limit | 准入拒绝后扩额恢复，保留原恢复断言 |
| worker-crash | 只杀本轮 supervisor 的 worker，核对身份、supervisor 存活及恢复永久拒绝 |
| restart-after-complete | SIGTERM、SIGKILL 重启协调端，已完成记录不重放 |
| coordinator-restart | SIGTERM 后原节点 CLI 以新 session/更高 epoch 重连 |
| coordinator-restart-kill | SIGKILL 后保留不确定工作，解除 blocker 仍不能绕过停止来源检查 |
| node-power-loss | 冻结并杀完整节点进程集合，等待真实租约失效，同 home/token 重启；journal 不重放 |
| `--real … --rehearsal` | 本地假模型覆盖真实 provider 协议；正确 totals 通过、错误 totals 被独立业务测试拒绝 |

上述场景均可在两个平台运行；`--real` 仍只接受 default。真正模型调用需要另外提供凭据和授权，彩排不验证模型能力、真实计费和生产网络。

本机 graceful restart 会等全部 agent 空闲、mailbox 静止，再把 SIGTERM 对齐到下一次真实 runtime poll 到达 relay 的时刻。relay 暂存该请求，等待协调端实际持久化 `coordinator_stopping`，随后转发原请求取得停止指令；不生成停止回报或修改持久化状态。`node-relay.json` 只记录请求路径、状态码和时刻。这个同步针对本次发现的产品时序问题：关闭时 mailbox poll 返回 503，可让节点进入重试并错过默认 5 秒停止期限。任意时刻 SIGTERM 的恢复能力仍需产品另行修复与验收；本场景证明上述受控边界。本机恢复完成等待为 30 秒，容器仍为 10 秒；最终恢复、epoch 和禁止重放断言不变。容器场景不使用该同步。

故障控制通过 `ps` 递归跟踪本轮进程身份与进程组，Linux 额外核对 `/proc/<pid>/stat` 的启动 tick；macOS 使用 `ps` 的启动时间、命令与进程组。整节点故障先暂停 supervisor/祖先进程，再反复发现并暂停后代，直到连续核对全部为停止态，随后重读身份并分别 SIGKILL，包括自行 detached 的 worker、shell 和后代。进程组中存在非本轮进程、身份变化或无法封闭后代集合都会失败。这里只控制正常产品进程的派生关系，不提供针对恶意双重 fork/逃逸程序的安全沙箱。

summary 增加 `backend`、实际 `nodePlatform`、`nodeArchitecture`、`localEnvironment`（可用 CPU 数、宿主内存与 Linux cgroup 配额原值，缺失记 unavailable）、`uncovered` 和 `localCleanup`。本机模式明确记录以下四项未覆盖：

- 容器只读挂载、独立文件系统、宿主路径不可见。同 UID 可以访问彼此文件；mock 明确验证宿主测试路径可见。
- 独立内核、硬件断电与磁盘缓存耐久性。node-power-loss 只证明完整进程崩溃、租约失效和持久库重开；证据使用 `processesExited` / `closedDescendantSet`，不伪造 `containerRemoved`。
- 容器 CPU/内存上限、网络隔离、跨架构与跨机网络。
- 独立新容器复核降为新进程冻结副本复核。它仍使用内存中的原始 oracle、CAS hash、独立 cwd、最小环境和实际 TAP/退出码，并在复核后检查 oracle、snapshot 和 CAS hash；同 UID 的运行时与 oracle 防篡改隔离未覆盖。

正常、超时、中断均停止本轮协调端与节点后代，再只读查询会话库，执行最终凭据扫描。收尾删除 `local-runtime/`，确认进程无残留并记录临时目录移除；`--keep` 或失败保留的 proof 证据不算运行目录。专用自测将每次保留的 proof 移至 `.acceptance-proof/local-process-<时间戳>/`，同时保存各场景状态与耗时，TMPDIR 下不保留这些 proof。Linux 首次验收需确认 ps 格式、信号权限、回环端口、SQLite 锁与 Node 版本，并记录实际 OS/架构、CPU 配额及耗时；macOS 通过不能代替 Linux 实机验证。
