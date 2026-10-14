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

容器名仅使用 `mc-acc-` 前缀（可用环境变量 `MC_ACCEPTANCE_CONTAINER_PREFIX` 改成其他 `mc-acc-` 开头的前缀，以便多个检出并行运行），运行带 `--rm`。只停止、删除当前运行创建的精确容器名；若启动前发现已有此前缀容器，拒绝运行并由其所有者处理。退出前以 `container list --all --quiet` 核对此前缀无残留，并打印 `cleanup verified`。正常成功还会关闭协调端、mock、TCP 中继并删除证据目录。只读挂载本 checkout 的 dist、package.json、解析软链接后的 node_modules 及节点启动脚本；节点工作目录与状态位于容器中，随容器销毁。

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
- `real-glm.json`：三个角色均配置 glm-4.7，OpenAI Completions API，`https://open.bigmodel.cn/api/coding/paas/v4`，凭据引用为 `ZHIPU_API_KEY`。Coding Plan 可能映射旧模型名，实际响应名从会话库的 `responseModel` 读取；与配置不同会在 summary 的 `modelMismatches` 中标注，配置名不作为实际模型的证明。

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

协调端只通过 env 接收本地角色所需的凭据。Linux 节点只通过 `container run -i` 的 stdin 接收 worker 所需的凭据和 node token，再用 `--credential-ref` 显式放行名称。值不进入 argv、挂载文件或证据；输出按全部已读凭据脱敏，在 summary、日志和其他证据全部写完后，递归扫描证据文件，包括 SQLite 与二进制文件，发现任一凭据原值即失败。

真实模式默认超时 30 分钟，`--timeout-ms` 可修改。三个角色共用最多 60 轮，包含辅助模型请求，可能发生真实计费。示例未声明价格，`maxCost: 0` 表示没有金额上限；不能用未知价格计算金额或声称免费。预算耗尽、Mission failed/blocked 或超时都会失败并保留证据。成功默认也保留；只有成功时 `--discard` 才删除，不能与 `--keep` 同用。

Mission 使用 shared workspace，`remoteWorkspaceIds` 只有本次 Linux workspace。产品默认 `approve` 会等待人工批准文件写入、shell 和验收命令；此无人值守复现明确选择 `trusted`，以便脚本全程不发送人工消息、不解除 blocker、不调用 resume、不通过 API 修改任务状态。模型仍需自己创建任务、交付、验收和完成 Mission。

宿主生成 `totals.acceptance.test.mjs`，权限 0400，记录 SHA-256，且不挂载给 Linux worker。macOS 额外尝试 `chflags uchg`，记录成功或失败，结束时解除以便清理；两次 chflags 子进程只接收 PATH。验收命令先按命令内写死的 SHA-256 校验此文件，再运行 node:test；回执必须原样记录这条命令。发布时、新回执被轮询发现时、结束时分别核对 hash 与权限。导出中的所有本地 agent 的 `shell_evidence` 和 tool transcript 都会接受检查；引用测试文件或对证据目录执行权限修改、写入的 shell 命令会使验收失败。四个用例验证导出的 `totalCents(lines)`：空订单为 0、多行合计、整数分乘法与零值、拒绝负数/非整数/非数字/缺字段及超出安全整数的金额。每行字段是 `quantity` 与 `unitPriceCents`，完整规则同时写入 goal、acceptance 和 assertion，模型无须读取宿主测试源码。

Mission 题面只提供业务规则、`/work/totals.mjs` 交付位置和独立验收命令；角色说明仅声明角色名称，任务推进由产品提示和模型自行完成。worker 在 `/work/totals.mjs` 交付冻结 artifact。首次发布路径不符合 `/work/totals.mjs` 时，脚本记录 `rejected-publications.json` 并继续等待正确发布，不修改 Mission 题面。脚本观察到正确的 worker `artifact_published` 事件后，用 `container exec <本次容器名> node -e ...` 把源文件改成 `throw new Error("mutated after publish")`，记录改写前后 hash，并检查协调端 CAS hash 不变。脚本只等待结果；模型不能通过修复或再次发布绕开本次故障。独立本地 validator 必须用 Mission 中的精确命令和 artifactIds 调用 RunValidation，成功回执需为 remote-snapshot、snapshotIntegrity true，四个用例全过。验收通过依据 CAS hash、remote-snapshot、snapshotIntegrity 和回执 artifact digest；注入与回执的时间戳只作为记录。完成时再检查宿主测试 hash 和 CAS hash，Mission completed、恰好一条任务 accepted、无 blocker 才通过。该任务的最终成功 validator 决定必须引用覆盖 totals.mjs 冻结快照的精确回执；其他任务仅允许 cancelled 或 attempt 为 0 且从未进入 running/review。mock 的唯一任务及唯一 artifact 断言保持不变。

真实模式额外证据：

- `real-config.json`、`frozen-acceptance.json`、`totals.acceptance.test.mjs`：实际 profile 配置、宿主测试 SHA-256 与四个业务测试。
- `mission-export.json`：产品导出，包括事件、generationAdmissions、transcript、验收回执和 blockers。
- `session-evidence.json`、`node-evidence-stop.json`：协调端退出及远端节点、worker 停止后，只读查询 pi-durable 会话库的结果和节点停止记录。协调端库在 `home/agents/<agentId>.sqlite`；远端库在容器 `/node-home/worker-runtime/agents/<agentId 的 SHA-256>.sqlite`，清理容器前使用 `container exec` 的 `node:sqlite` 查询，只解析 stdout。节点停止后只保留容器和 bootstrap 等待进程，读库结束即清理。
- `real-evidence.json`：最终状态、轮数/60、每个 agent 及角色的模型计数、累计 token、工具调用名称序列、artifact/CAS hash、故障注入和回执。`modelCalls` 计数会话库中已提交的 assistant 响应，包含错误与重试响应；`admittedModelCalls` 另记产品准入数，包含辅助请求，不能把准入数称为已完成的提供商调用。usage 汇总各会话最新 `pi.usage` 文档的 models 桶，包含辅助调用，排除 tools 桶。工具名取 assistant 的 toolCall，按每个 agent 的 commit_seq、entry ID 和响应内位置排序，不记录参数或隐藏推理，也不依靠跨进程时钟排序。响应模型证据保留配置名、API `responseModel` 名、各名称的调用数及不一致标记；没有 `responseModel` 的调用记为未报告，不推断实际名。库读取失败显示 `complete: false`、错误类别和安全的 `error.code`，该 agent/角色的计数与 usage 为 null，整体标记 `evidenceComplete: false`，不单独使业务验收失败。未知金额为 null。`oracleTouches` 记录本地 shell 对验收文件或目录的触碰。
- `fault-injection.json`：触发事件序号、artifact ID、源文件改写前后 SHA-256、CAS 改写前后 SHA-256 和注入结束时间。
- `independent-review.json`、`independent-inputs/`、`host-runtime.json`、`rejected-publications.json`：独立容器复核结果及输入、Node hash 和不符合交付路径的发布记录。原始测试在脚本内存中保留，复核不从可能被修改的宿主测试文件读取。
- `summary.json`：验收及清理结果；成功时有模型计数、usage、`modelMismatches` 和最终 CAS hash。失败时保留已取得的 Mission/export/evidence，即使超时也尝试只读导出。最终凭据扫描覆盖 summary 及所有晚写文件，扫描失败会非零退出。

普通测试中的 `test/remote-linux-real.test.mjs` 只用假凭据和本地进程，覆盖配置、文件权限、脱敏、stdin 传递、故障注入、四个业务测试、固定 hash 命令、预言触碰检测、stdout/stderr 分离、最终扫描顺序、实际 pi-durable 库的只读查询、响应模型名、错误类别、额外任务、纠正发布、独立复核分歧和宿主 Node hash，不调用任何外部模型。真实 MiniMax/GLM 运行须由持有凭据的运行者执行，单元测试和 mock 容器通过都不能代替这一结果。

## 预检

正式验收最多 60 轮，可能产生真实费用。先跑预检，确认每个不同的 `(api, baseUrl, modelId, credentialEnv)` 组合都能完成一次最小工具调用。每个组合只发一次请求，客户端重试次数为 0。预检使用产品同一套 pi-ai provider，工具名为 `ping`，并强制要求调用它。为了少发 token，这次请求关闭 reasoning，并把 `maxTokens` 设为 64。默认单次请求超时 20 秒，可用 `--timeout-ms` 修改。

```sh
npm run build
node acceptance/remote-linux/preflight.mjs --real acceptance/remote-linux/real-minimax.json --secrets-file /私有目录/models.env
node acceptance/remote-linux/preflight.mjs --real acceptance/remote-linux/real-glm.json --secrets-file /私有目录/models.env --from-container
```

`--from-container` 把远端 worker 那一个组合改到临时 Apple Container 里请求，用来确认容器网络能够到达 endpoint。同一组合不会在宿主上再请求一次。容器镜像必须是本机已缓存的 `node:22-bookworm-slim` arm64；缺失时直接失败，不拉取。容器名使用 `mc-acc-i2-grok-` 前缀，可用 `MC_ACCEPTANCE_CONTAINER_PREFIX` 覆盖，覆盖值仍须以 `mc-acc-` 开头。运行带 `--rm`。只读挂载 `dist`、`node_modules` 和预检脚本。密钥只经 stdin 传入容器，不进入 argv、环境变量或挂载文件。若启动前已有同前缀容器，预检拒绝运行，由该容器的所有者处理。

标准输出是一行 JSON。`pass` 是总体结论。`checks` 的每一项对应一个组合，包含角色、`transport`（`host` 或 `container`）、HTTP 是否成功、状态码、延迟、是否返回名为 `ping` 的工具调用、token usage、`responseModel`，以及 `errorCategory`。`responseModel` 来自 pi-ai 读到的提供商流事件里的 `model` 字段；流里没有该字段，或请求在返回模型名之前失败时为 null，并由 `responseModelReason` 说明原因。部分兼容端点会把配置里的 `modelId` 映射成另一个模型。映射结果与 `modelId` 不同时，该项 `modelMismatch` 为 true，顶层 `modelMismatches` 列出这些组合，并带有 `notice`。这个标记不改变 `pass`，退出码仍只由工具调用是否成功决定。错误类别包括 `auth`、`timeout`、`http`、`network`、`no-tool-call`、`provider`、`container`。配置或 secrets 文件不合法时 `checks` 为空，并给出不含密钥的 `error`。任何输出都会脱敏。退出码非零表示先不要进入上面的正式验收。预检通过后再运行 `run.mjs --real`。
