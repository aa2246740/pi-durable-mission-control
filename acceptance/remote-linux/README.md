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

orchestrator 从 GetMissionState 读取真实角色、任务、workspace、agent ID，生成远端 worker 和本地 validator，并分配一个有独立 validator 的任务。worker 写入 linux-delivery.json，在 Linux bash 中执行 `command -v node` 和实际内容自查，PublishArtifact 后修改节点原文件，再 UpdateTask review 和 Report。orchestrator 收到交付报告后派 validator。validator 用 RunValidation 执行仅协调端存在的只读 node:test 文件，检查冻结内容、独立快照目录和宿主测试文件的只读权限，再 ValidateTask、Report。orchestrator 调用 CompleteMission。任何错误都终止验收，不掩盖命令失败。

保留目录包含：

- `summary.json`：状态、耗时、Linux Node/PATH、artifact 远端来源、回执 exitCode/snapshotIntegrity、下载 Content-Disposition、blocker 和清理结果。
- `mission.json`：任务、事件、artifact、真实验收回执和独立验收决定。
- `runtimes.json`：远端 worker 的停止回报；成功前等待物理停止确认为 closed，并再次检查 blocker。
- `mock-tools.json`：模型返回的工具调用，以及从对话中收到的真实工具 JSON 结果；不记录请求头或凭据。
- `host-acceptance.test.mjs`：协调端生成的只读验收测试。不会挂载到容器中。
- `coordinator.log`、`container.log`、`home/`：日志和协调端持久状态。凭据值不保留。

summary 必须同时满足 Mission completed、任务 accepted、验收 exitCode 0、snapshotIntegrity true、remote-snapshot、Linux machine provenance、正确下载文件名、成功 Linux PATH 自查、发布后原文件变化、没有 blocker、validator 未调用 RequestUserInput，才算通过。修改原文件后仍通过冻结内容测试证明读取的是发布快照。

普通 `npm test` 包含 mock 协议与决策单元测试，不启动 Apple Container。容器验收测试单独运行：

```sh
node --test acceptance/remote-linux/container.test.mjs
```

脚本自身的测试（依赖 Apple Container，不属于 `npm test`）在 `npm run build` 之后运行：

```sh
node --test acceptance/remote-linux/container.test.mjs
MC_ACCEPTANCE_TEST_KEEP=1 node --test acceptance/remote-linux/container.test.mjs
node --test acceptance/remote-linux/lifecycle.test.mjs
```

容器测试默认检查成功后目录已删除；环境变量 `MC_ACCEPTANCE_TEST_KEEP=1` 检查 `--keep --out` 保留的 summary，再删除该次测试证据。生命周期测试分别验证真实运行中的 SIGINT 和超时，先检查失败证据保留与清理结果，再删除该次测试证据。三个命令应依次执行，避免同一容器名前缀的验收互相影响。

## 真实模型模式

此模式由真实模型自行选择工具，不启动脚本化 mock。配置文件为 JSON，顶层固定包含 `orchestrator`、`worker`、`validator` 三个产品 profile，字段为 `name`、`api`、`modelId`、`baseUrl`、`credentialEnv`、`contextWindow`、`maxTokens`、`reasoning`、`toolCalling`、`vision`，可选完整的 `cost`。不支持把密钥写入配置。未知价格必须省略 `cost`，产品会保留 `costKnown: false`；不能把未知价格填成 0。示例的 token 上限沿用产品 preset，可按服务实际限制调整，不代表已验证服务能力。

- `real-minimax.json`：本地 orchestrator/validator 用 MiniMax-M2.5，Anthropic Messages API，`https://api.minimaxi.com/anthropic`；远端 worker 用 MiniMax-M2.7，OpenAI Completions API，`https://api.minimaxi.com/v1`。凭据引用均为 `MINIMAX_CN`。
- `real-glm.json`：三个角色均用 glm-4.7，OpenAI Completions API，`https://open.bigmodel.cn/api/coding/paas/v4`，凭据引用为 `ZHIPU_API_KEY`。

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

协调端只通过 env 接收本地角色所需的凭据。Linux 节点只通过 `container run -i` 的 stdin 接收 worker 所需的凭据和 node token，再用 `--credential-ref` 显式放行名称。值不进入 argv、挂载文件或证据；输出按全部已读凭据脱敏，退出前递归扫描证据文件，包括 SQLite 与二进制文件，发现任一凭据原值即失败。

真实模式默认超时 30 分钟，`--timeout-ms` 可修改。三个角色共用最多 60 轮，包含辅助模型请求，可能发生真实计费。示例未声明价格，`maxCost: 0` 表示没有金额上限；不能用未知价格计算金额或声称免费。预算耗尽、Mission failed/blocked 或超时都会失败并保留证据。成功默认也保留；只有成功时 `--discard` 才删除，不能与 `--keep` 同用。

Mission 使用 shared workspace，`remoteWorkspaceIds` 只有本次 Linux workspace。产品默认 `approve` 会等待人工批准文件写入、shell 和验收命令；此无人值守复现明确选择 `trusted`，以便脚本全程不发送人工消息、不解除 blocker、不调用 resume、不通过 API 修改任务状态。模型仍需自己创建任务、交付、验收和完成 Mission。

宿主生成 `totals.acceptance.test.mjs`，权限 0400，记录 SHA-256，且不挂载给 Linux。四个用例验证导出的 `totalCents(lines)`：空订单为 0、多行合计、整数分乘法与零值、拒绝负数/非整数/非数字/缺字段及超出安全整数的金额。每行字段是 `quantity` 与 `unitPriceCents`，完整规则同时写入 goal、acceptance 和 assertion，模型无须读取宿主测试源码。

worker 必须先在 Linux 自查，在 `/work/totals.mjs` 交付一个 artifact。脚本观察到该 worker 的 `artifact_published` 事件后，用 `container exec <本次容器名> node -e ...` 把源文件改成 `throw new Error("mutated after publish")`，记录改写前后 hash，并检查协调端 CAS hash 不变。脚本只等待结果；模型不能通过修复或再次发布绕开本次故障。独立本地 validator 必须用 Mission 中的精确命令和 artifactIds 调用 RunValidation，成功回执需为 remote-snapshot、snapshotIntegrity true，四个用例全过。验收结束时间必须晚于故障注入。完成时再检查宿主测试 hash 和 CAS hash，Mission completed、唯一任务 accepted、无 blocker 才通过。

真实模式额外证据：

- `real-config.json`、`frozen-acceptance.json`、`totals.acceptance.test.mjs`：实际 profile 配置、宿主测试 SHA-256 与四个业务测试。
- `mission-export.json`：产品导出，包括事件、generationAdmissions、transcript、验收回执和 blockers。
- `real-evidence.json`：最终状态、轮数/60、每个角色的 `modelCalls`、`modelResponses`、token usage、工具调用名称序列、artifact/CAS hash、故障注入 hash 与验收回执。`modelCalls` 是产品实际准入的模型请求数，包含辅助请求；准入后失败的调用也计入，不能据此声称提供商已完成响应。`modelResponses` 是提交的普通 assistant 响应数。usage 汇总 durable 模型账本，包含辅助调用；未取得 usage 时为 null。未知金额为 null。工具序列按 transcript 提交时间排序，同一响应内保留顺序；不包含工具参数或隐藏推理。
- `fault-injection.json`：触发事件序号、artifact ID、源文件改写前后 SHA-256、CAS 改写前后 SHA-256 和注入结束时间。
- `summary.json`：验收及清理结果；成功时有模型计数、usage 和最终 CAS hash。失败时保留已取得的 Mission/export/evidence，即使超时也尝试只读导出。

普通测试中的 `test/remote-linux-real.test.mjs` 只用假凭据和本地进程，覆盖配置、文件权限、脱敏、stdin 传递、故障注入、四个业务测试和证据判定，不调用任何外部模型。真实 MiniMax/GLM 运行须由持有凭据的运行者执行，单元测试和 mock 容器通过都不能代替这一结果。
