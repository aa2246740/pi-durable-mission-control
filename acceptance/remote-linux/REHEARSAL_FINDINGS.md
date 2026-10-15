# 真实模式彩排发现

`--real <config> --rehearsal` 已用两个配置跑通真实题面、冻结验收、故障注入、只读会话取证、oracle 审计、独立容器复核及凭据扫描。错误实现均被冻结测试拒绝。所有模型请求只访问本地假服务，不读取用户 secrets。

## 脚本修正

原真实模式在 Mission blocked 时只报告 `blocked` 与 `completed` 的断言差异，未指出失败的冻结回执。`assertRealOutcome` 现在按精确验收命令筛选失败回执，报告 `Frozen acceptance failed for the published snapshot`、Mission 状态及失败回执数。完成条件保持为 completed，最终 `assertRealSuccess` 未改变。

假服务实现过程中发现产品的 Anthropic SDK 请求 `/v1/messages?beta=true`。请求校验允许此查询参数，仍校验路径、模型名、stream 与 `x-api-key`。此项是新增假服务的兼容修正。

## 产品结束竞态，未改 src

一次 MiniMax 正向彩排完成四个业务测试、独立容器复核及 Mission 完成门槛后，最终证据出现 delivery blocker，真实验收正确失败。证据在本工作树 `.acceptance-proof/rehearsal-1792006093939/minimax-positive/`。

`mission-export.json` 中的顺序是：

1. seq 118：`mission_completed`，Mission passed completion gates。
2. seq 119：`delivery_uncertain`，当前 orchestrator 输入结果为 `Harness is closed`。
3. seq 120：`operation_uncertain`，产生开放的 delivery blocker。

基线产品生成代码的 `workers.js` 中，`onRpc` 在回复 CompleteMission 后立即调用 `syncMissionLifecycle`。完成状态会触发 `stopMission`、关闭本地 worker。worker 当前 submission 的结束回调仍可能未提交，关闭后上报 uncertain。代码顺序和上述事件支持这个竞态根因，具体调度概率未测量。其他 MiniMax 和 GLM 正向运行通过，因此这个问题是偶发的。

任务禁止改 src。本次保留失败证据，不放宽无 blocker 的成功门槛，不增加自动重试。容器自测将继续暴露此产品问题。

## 容器记录

以下耗时单位为毫秒。前三次取 runner 的 summary，其余取容器自测 results.json 记录的子进程完整耗时，包含启动与退出。请求数计假服务已校验并发出的工具响应，不计拒绝的 HTTP 请求。所有容器运行带 --rm，只使用缓存镜像。每次 runner 均检查本任务前缀；竞态运行的 cleanupVerified 为 false，原因是最终验收发现 blocker，容器无残留。

| 证据目录 | 配置与实现 | 结果 | 耗时 | 模型请求数 |
| --- | --- | --- | ---: | ---: |
| minimax-first | MiniMax 正确 | 失败，假服务未兼容 beta 查询 | 12073 | 0 |
| minimax-second | MiniMax 正确 | 失败，记录 beta 查询定位 | 10820 | 0 |
| minimax-third | MiniMax 正确 | 通过 | 20046 | 30 |
| rehearsal-1792006093939/minimax-positive | MiniMax 正确 | 失败，产品结束竞态 | 19618 | 30 |
| rehearsal-1792006093939/minimax-negative | MiniMax 错误 | 冻结测试拒绝，假服务后续未处理 blocked | 17943 | 29 |
| rehearsal-1792006093939/glm-positive | GLM 正确 | 通过 | 19887 | 30 |
| rehearsal-1792006093939/glm-negative | GLM 错误 | 冻结测试拒绝，假服务后续未处理 blocked | 17106 | 29 |
| rehearsal-1792006319261/minimax-positive | MiniMax 正确 | 通过 | 24249 | 30 |
| rehearsal-1792006319261/minimax-negative | MiniMax 错误 | 预期失败，冻结验收原因，进程 exit 1 | 20018 | 30 |
| rehearsal-1792006319261/glm-positive | GLM 正确 | 通过 | 29363 | 30 |
| rehearsal-1792006319261/glm-negative | GLM 错误 | 预期失败，冻结验收原因，进程 exit 1 | 35286 | 30 |

最后一组容器自测为 tests 4 / pass 4 / fail 0。正向的三角色会话计数为 orchestrator 16、worker 8、validator 6，usage 均有 token。worker 的顺序为 GetMissionState、write_file、bash、PublishArtifact、UpdateTask、Report，随后读取状态并等待。validator 读取状态后执行 RunValidation、ValidateTask、Report。orchestrator 读取状态、创建任务、生成 worker 和 validator、按工具结果中的 ID 分配并派活，正向最后 CompleteMission，负向最后 RequestUserInput 请求修正并产生 blocker。初次路径失败尚无工具响应。旧负向运行在最终 GetMissionState 后因未处理 blocked 终止，未作为最终验收证明。

完整逐次工具序列及模型请求数在各目录的 rehearsal-tools.json、summary.json 和每组 results.json 中。最终正向 oracleTouches 为空，evidenceComplete 为 true，独立复核通过。两次最终负向均为四个冻结测试中 pass 3 / fail 1，失败内容为 totalCents did not reject invalid input，且有 passed=false 的 validator 决定。

提交前检查：`/Users/wu/.mc-orch/bin/wt-test d1-gpt` 为 tests 479 / pass 479 / fail 0，耗时 61645.279 ms。`npm run typecheck` 和 `npm run lint` 均通过。新增 11 个单元测试，未修改或跳过现有测试。
