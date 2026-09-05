# DSH Adaptive Loop

`dal` 是一个本地、由人治理的证据与自我改进循环，面向**闭环、重复性的智能体工作流**——目标有界、状态迁移可观测、评分器确定性的任务类别（客服类工作流、运维例行流程、可基准化的业务流程）。开放式创作型编程属于开环问题，明确排除在改进声明之外：没有可评估的有界目标，dal 就不对其做任何递归自我改进声明。

版本 0 会验证结构化任务反馈、存储不可变的本地记录、评估不执行的权限请求、运行钉住的离线安全/回归套件、确定性聚类失败、估计仅观测的 Run-to-Run controller state、封存留出集（holdout）、产出受治理的模型提案草稿、用 UCB1 搜索候选分支、在受限环境执行确定性校验器、暂存但不应用插件候选，并记录由人控制的提案状态。

它**不会**在受审批约束的提案器之外调用 LLM 或优化器，不会无约束地执行所请求的操作，不会安装插件，不会在未经批准的决策下修改 dsh 配置，不会应用插件候选，也不会自动晋升候选。HMR 仅在隔离 linked worktree 的预配置路径中暂存文件，应用操作已由代码隔离。

## 适用与不适用

- **适用：** 带确定性评分器的重复性闭环工作流类别——`benchmarks/tau-style-workflow` 工作区即参考范式。
- **不适用：** 把开放式编程或研究当作改进目标；这些任务仍会记录反馈与运行记录，但不做任何改进声明。
- **锚点始终由人掌控：** 评分器、封存留出集、权限、最大预算、晋升策略、审计日志、回滚机制——提案器永远不能编辑它们。

## 环境要求

- Node.js 22 或更高
- pnpm 10 或更高

## 快速开始

```sh
pnpm install --frozen-lockfile
pnpm run dal feedback validate tests/fixtures/feedback/completed.json
pnpm run dal feedback ingest tests/fixtures/feedback/completed.json --store .dal/demo-feedback
pnpm run dal feedback summary --store .dal/demo-feedback --format json
pnpm run dal policy check tests/fixtures/guardrail/allowed-read.json --store .dal/demo-guardrail
pnpm run dal eval run tests/fixtures/evaluation/v0-suite.json --store .dal/demo-evaluations
pnpm run dal control estimate --policy tests/fixtures/controller/controller-policy.json \
  --batch batch-control-001 --runs tests/fixtures/controller/runs --store .dal/demo-control
pnpm run dal capsule check capsules
pnpm run check
```

预期结果：反馈、本地读取的策略决策、知识胶囊与评估套件全部通过；摄取会生成一条不可变记录；摘要报告一条已完成记录；controller estimation 发布一条 `ready` 状态。重复发布相同的反馈、策略或 controller state 是幂等的。所有命令都在本地运行。

## 命令

| 命令 | 行为 |
| --- | --- |
| `dal feedback validate <file>` | 校验 schema、结果语义与密钥/PII 策略，不写入任何内容 |
| `dal feedback ingest <file> [--store <dir>]` | 校验通过后原子发布一条不可变的本地信封记录 |
| `dal feedback query [filters]` | 按 ID、变更、结果、隐私标签或日期查询本地记录 |
| `dal feedback summary [filters]` | 汇总结果与低效类别 |
| `dal capsule check <path-or-directory>` | 对胶囊 schema、新鲜度、来源或摘要漂移失败关闭 |
| `dal approval verify <file> ...` | 校验精确的人类决策、范围、候选摘要与有效期 |
| `dal policy check <action-file> ...` | 记录一次确定性策略决策；不执行任何操作 |
| `dal eval run <suite-file> ...` | 运行钉住的本地夹具并发布机器可读的记分卡 |
| `dal run ingest <file> [--store <dir>]` | 校验并不可变地存储一条带失败事实与钉住上下文的运行记录 |
| `dal cluster run [--store <dir>] [--output <dir>] [--batch <id>]` | 按规范失败指纹确定性聚类失败的运行，并绑定到运行批次 |
| `dal control estimate --policy <file> --batch <id> ...` | 从一个兼容运行批次估计带 Wilson 区间和显式排除项的不可变、仅观测状态（DAL-023） |
| `dal install user-global --approval <decision-file>` | 经审批校验的自动化安装：技能与全局 AGENTS.md |
| `dal seal init/verify/reveal` | 一次性封存留出集承诺，带 Merkle 漂移检测 |
| `dal saga begin/complete/status/list` | 恰好一次的效果意图与回执，支持崩溃恢复 |
| `dal admit issue/complete/status` | 绑定 nonce 的准入：候选无法伪造自己的启动回执 |
| `dal propose prepare/run` | 受治理的提案器：净化载荷、经校验的 send_data_externally 审批、在可编辑表面上产出模型草稿 |
| `dal branch record/evaluate/stats/select` | 有界搜索档案：带父链接的分支、以确定性评分器为价值函数、UCB1 选择 |
| `dal verify run` | 受限校验执行器：Seatbelt 强制本地校验，沙箱不可用时失败关闭 |
| `dal verify run / propose run --runner docker` | 容器托管的 harness 执行：钉住的镜像、工作区挂载、默认断网（DAL-020） |
| `dal reset status\|execute` | 重置基线：移除 `.dal` 证据、以当前快照重新开始；校验过的回执存于 `.dal/resets/` |
| `dal optimize prepare\|evaluate` | SkillOpt 形态的仅准备/仅评估适配器：从运行记录生成净化的训练集；确定性的有界编辑校验门（DAL-021） |
| `dal improvement transition <proposal-file> ... --output <new-file>` | 校验并独占发布一个新的不可变提案状态到 `.dal/proposals/` |

精确选项见 `pnpm run dal --help`。

## 插件模式（run / improvement）

`plugins/` 目录发布一个 dsh bundle（`@lunarmoon26/dal-modes`），内含彼此分离的运行与工作台条目：

- **Run 模式**（`@lunarmoon26/dal-run-record`）——默认开启：把会话事件投影为 `.dal/runs` 下隐私安全的运行记录（只有计数、摘要、结果与失败码；绝不包含提示词文本、消息内容、工具参数或结果）。
- **Improvement 模式**（`@lunarmoon26/dal-improve-tools`）——默认关闭：基于确定性 dal CLI 的工作台工具（聚类、准备载荷、摘要、分支评估、重置状态）。不暴露任何受审批门控的操作——`propose run` 与 `reset execute` 仅限 CLI。
- **HMR 候选暂存**（`@lunarmoon26/dal-hmr-candidate`）——默认关闭且由代码隔离：在固定目录暂存插件/配置模块文件并报告摘要，但在校验审批或写入任何在线文件之前拒绝应用；不会准入任何运行时代际。
- **G2 候选项**（`@lunarmoon26/dal-unknown-effect-guard`）——默认关闭：对结果未知的工作流副作用实施按智能体隔离的重试锁。当前只有源码与单元测试，既未安装，也未应用为新一代配置。

把 bundle 挂载进 profile（`dsh plugin --profile <name> add ./plugins/dal-modes ./plugins/dal-run-record ./plugins/dal-improve-tools ./plugins/dal-hmr-candidate`，然后配置并启用工作台条目）属于受审批门控的 `install_or_mount_plugin` 操作；见 [`docs/spec.md`](docs/spec.md) DAL-019 与 [`docs/operator-guide.md`](docs/operator-guide.md)。即使启用 HMR 条目也无法应用候选。G2 包仍不在此命令中，挂载与应用都需各自审批。

## 有意拒绝的示例

以下命令在报告安全的规则/错误码后返回退出码 `1`。策略命令仍会保留其不可变的拒绝审计；敏感反馈不持久化任何内容。

```sh
pnpm run dal feedback validate tests/fixtures/feedback/secret.json
pnpm run dal policy check tests/fixtures/guardrail/unapproved-candidate.json --store .dal/demo-guardrail
pnpm run dal improvement transition tests/fixtures/proposals/proposed-hard-stop.json \
  --to sandbox_evaluated --actor-kind dsh-agent --actor-id agent-local \
  --evidence repo://.dal/evaluations/example.json --notes "Verify hard-stop enforcement." \
  --output .dal/proposals/hard-stop-attempt.json
```

## 运作模型

- 持久化语法精确定义：[`schemas/`](schemas/)
- 产品行为：[`docs/spec.md`](docs/spec.md)
- 护栏、威胁模型与记分卡：[`docs/evaluation-and-guardrails.md`](docs/evaluation-and-guardrails.md)
- 审批与隐私策略：[`docs/governance.md`](docs/governance.md)
- 运维流程：[`docs/operator-guide.md`](docs/operator-guide.md)
- 需求证明：[`docs/requirement-evidence.md`](docs/requirement-evidence.md)
- Controller 契约与研究声明边界：[`docs/control-governed-evolution.md`](docs/control-governed-evolution.md)
- 仅限未来的工作：[`ROADMAP.md`](ROADMAP.md)

本地生成的证据位于 `.dal/` 下，不纳入源码控制。策略配置的评估存储中的硬停止记分卡会隔离匹配的摘要；回滚与发布仍是人工流程。

## 安装与首个工作区

```sh
npm install -g <this-package>        # 或在检出的仓库内：pnpm install -g .
dal init                             # 在任意工作区内：存储、技能、指令、gitignore 规则
```

`dal init` 会搭建 `.dal/` 证据存储、一个 `end-task-feedback` 技能、工作区指令与证据存储的 gitignore 规则；它从不覆盖已有文件，也从不触碰 `~/.dsh` 或 `~/.agents`。要让该工作流出现在每个工作区，由人执行 `dal init` 打印的可选 user-global 步骤（技能放到 `~/.agents/skills/`，指令放到 `~/.dsh/AGENTS.md`）——该步骤会修改共享配置，需要你的批准。此后智能体随工作记录日志，由一位人在收工时对账（`dal feedback summary`、`dal cluster run`、提案、人工提交）。运行手册见运维指南。

## 自我改进边界

改进提案只能修改可编辑表面（`prompt`、`tool_descriptions`、`skills`、`memory_policy`、`routing`、`stop_retry_logic`、`harness_code`），且自 `proposed` 阶段起必须携带可证伪的预测。不可变锚点（`evaluator`、`sealed_holdout`、`permissions`、`maximum_budget`、`promotion_policy`、`audit_log`、`rollback_mechanism`）永远不是提案目标。运行记录、确定性失败聚类、仅观测 controller state 和默认关闭的源码候选项为循环供料；PI governor、response model、predictive selection、基于模型的聚类与自主应用候选项仍属未来工作。

## 预期的使用方式

智能体白天正常工作；每个任务以一条结构化反馈记录收尾，失败时再加一条运行记录。这些记录及其派生 controller observation 存放在受 VCS 跟踪的存储中（`.dal/outbox`、`.dal/store`、`.dal/runs`、`.dal/clusters`、`.dal/control-states`）。收工时由一位人负责对账：拉取、汇总、聚类失败、在有已审查 controller policy 时估计状态、评审、推动提案走完分阶段生命周期，并通过确定性或私有隔离评估器进行评估；只有人工提交才能晋升变更。HMR 助手仅提供非活动暂存。精确运行手册见运维指南。

## 基准工作区

[`benchmarks/tau-style-workflow/`](benchmarks/tau-style-workflow/) 是一个目标测试工作区，模拟 τ-bench 范式（闭环重复工作流、确定性终态评分器、成文策略）：任务、策略、确定性的 `grade.ts` 校验器、循环要改进的工作区技能、仅源码的工作区插件包，以及一个钉住并演练整个工作区的 dal 评估套件。`pnpm run benchmark:check` 会运行它，且是 `pnpm run check` 的一部分。
