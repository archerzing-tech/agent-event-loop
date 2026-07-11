# Agent-Event-Loop 设计文档

**版本**：3.0.0
**状态**：正式发布
**技术栈**：Bun + TypeScript
**文档日期**：2026-07-11

------

## 1. 引言

### 1.1 背景

随着大语言模型（LLM）能力的增强，构建能够自主推理、调用工具、自我修正的智能体（Agent）成为迫切需求。传统的 Agent 实现多采用递归调用或简单的 while 循环，缺乏对并发、中断、持久化和可观测性的系统化设计。

JavaScript/TypeScript 生态中的 Event Loop 模型（基于消息队列、非阻塞 I/O）提供了优秀的并发处理范式。本项目**借鉴**该模型的核心思想（而非实现细节），将其改造为面向 Agent 认知流程的调度框架，命名为 **Agent-Event-Loop**。

### 1.2 设计目标

- **确定性调度**：状态流转清晰，支持优先级和中断。
- **弹性恢复**：通过检查点和快照，支持崩溃重启后无缝恢复。
- **可观测性**：实时暴露内部事件，便于监控和调试。
- **高性能**：充分利用 Bun 运行时的原生能力，降低延迟。
- **可扩展性**：通过 Hook 机制允许用户注入自定义逻辑。
- **关注点分离**：Agent Loop（无状态引擎） vs Agent Harness（有状态底盘）。

### 1.3 架构哲学：无状态 Loop + 有状态 Harness

借鉴 Claude Code、OpenCode、OpenHarness 等业界先锋的演进，v3.0 **将运行时解耦为两个独立层次**：

| 层次 | 有状态？ | 职责 |
|:---|:---|:---|
| **AgentLoop**（引擎） | ✅ **无状态** — 零可变字段，纯转换函数 | 思考-行动-观察状态机；调用 LLM 与工具；发出事件 |
| **AgentHarness**（底盘） | ❌ **有状态** — 持有全部会话状态 | 管理队列、消息、预算、持久化、生命周期、钩子、可观测性 |

这映射了 Anthropic 的"解耦大脑与双手"架构和 OpenHarness 的"Agent Loop 作为临时逻辑，Harness 作为持久基础设施"模式。

**关键洞察**：AgentLoop 本身不持有任何可变状态。所有状态（消息、队列、预算、计数器）由 Harness 管理。Loop 是纯计算——接收上下文，返回结果；Harness 将结果应用到其状态。

### 1.4 术语表

| 术语             | 定义                                                         |
| :--------------- | :----------------------------------------------------------- |
| AgentLoop        | 无状态状态机引擎：纯转换函数，零可变字段                      |
| AgentHarness     | 有状态运行时：管理会话、队列、生命周期、持久化                |
| State            | 一个原子认知单元（如 `THINK`, `ACT`），包含类型、数据和优先级 |
| Queue            | 存储待处理 State 的容器，分为普通队列和紧急队列              |
| Turn             | 一轮完整的 Agent 迭代（通常包含 `THINK` → `ACT/OBSERVE` → `VERIFY`） |
| Checkpoint       | 在关键节点保存的状态快照（存储在 SQLite 中）                 |
| Snapshot         | 紧急备份的完整状态（存储在文件系统中）                       |
| Hook             | 在 State 执行前后触发的拦截器，用于日志、鉴权、限流等        |
| LoopInput        | 传入 AgentLoop 单次状态转换的数据（不可变快照）              |
| LoopOutput       | AgentLoop 执行一个状态后产出的结果                            |

------

## 2. 总体架构

### 2.1 两层架构

Agent-Event-Loop v3.0 采用清晰分离的两层架构：

```
┌─────────────────────────────────────────────────────────────────────┐
│                        应用层 (Application)                           │
│              用户输入 / 输出 / 前端 Dashboard                        │
└────────────────────────┬────────────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────────────┐
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │            AgentHarness（有状态底盘）                           │  │
│  │                                                                 │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐  │  │
│  │  │  StateQueue  │  │ BudgetManager│  │  HookManager       │  │  │
│  │  │  （双队列）    │  │  （4D 限制）  │  │  （可扩展）         │  │  │
│  │  └──────┬───────┘  └──────┬───────┘  └────────────────────┘  │  │
│  │         │                 │                                    │  │
│  │  ┌──────▼─────────────────▼────────────────────────────────┐  │  │
│  │  │          Session 状态 (messages, counters 等)            │  │  │
│  │  └──────────────────────────────────────────────────────────┘  │  │
│  │                                                                 │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐  │  │
│  │  │  Persistence │  │  EventBus    │  │  WebSocketBridge   │  │  │
│  │  │  （检查点）    │  │  （事件）      │  │  （实时流）          │  │  │
│  │  └──────────────┘  └──────────────┘  └────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                         │                                            │
│                         │ 委托状态转换                                │
│                         ▼                                            │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │           AgentLoop（无状态引擎）                               │  │
│  │                                                                 │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │  │
│  │  │ GATHER   │  │ THINK    │  │ ACT      │  │ OBSERVE      │  │  │
│  │  │ 执行器    │  │ 执行器    │  │ 执行器    │  │ 执行器        │  │  │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────────┘  │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │  │
│  │  │ VERIFY   │  │ REFINE   │  │ REFLECT  │  │ TERMINATE    │  │  │
│  │  │ 执行器    │  │ 执行器    │  │ 执行器    │  │ 执行器        │  │  │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────────┘  │  │
│  │                                                                 │  │
│  │  // 零字段——只有纯转换函数                                       │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

**数据流**：

1. 用户输入 → `AgentHarness.run()` 转换为初始 `GATHER` 状态并入队。
2. Harness 主循环出队状态，调用 `hooks.beforeState()`，然后用钩子包装 LLM 和工具。
3. Harness 委托给 **AgentLoop.transition(LoopInput)** — 纯计算。
4. **AgentLoop** 执行状态机：调用 LLM、运行工具处理器、发射事件，返回 `LoopOutput`。
5. **AgentHarness** 将 `LoopOutput` 应用到会话状态（更新 messages、queue、budget、output）。
6. 关键节点 Harness 保存检查点并通过 WebSocket 广播状态变化。
7. 预算耗尽或达到终止条件时，Harness 注入 `TERMINATE`，结束循环。

### 2.2 与主流架构的比较

| 方面 | **Agent-Event-Loop v3.0** | Claude Code | OpenCode | OpenHarness |
|:---|:---|:---|:---|:---|
| **Loop** | 无状态纯引擎 | 无状态"大脑"Harness | 思考-行动-观察循环 | 临时引擎 |
| **Harness** | 有状态底盘 | 外部 Session 日志 | Session/状态管理器 | 持久底盘 |
| **状态** | Harness 持有（messages, queue, budget） | 外部持久 Session 日志 | 本地 JSONL 文件 | Step 级执行 |
| **恢复** | 快照 → 检查点 | `getSession(id)` 恢复 | Agent 重启 | 可重试步骤 |

------

## 3. 核心组件设计

### 3.1 AgentLoop — 无状态状态机引擎

`AgentLoop` 是一个**零可变字段**的纯状态机。它是一个自包含模块，接收 `LoopInput`（当前上下文的快照），返回 `LoopOutput`。

```typescript
class AgentLoop {
  // ⚡ 零字段！该类不持有任何可变状态。
  
  async transition(input: LoopInput): Promise<LoopOutput> {
    // 根据 state.type 路由到对应执行器
  }
}

interface LoopInput {
  state: AgentState;                        // 当前要处理的状态
  messages: readonly Message[];             // 只读消息历史
  tools: Record<string, ToolMetadata>;      // 工具注册表
  llm: LLMProvider;                         // LLM（Harness 已包装钩子）
  refineAttempts: Record<string, number>;   // 重试计数器
  currentOutput: string | null;             // 当前累积的输出
  emit: (type: string, payload?: unknown) => void;  // 事件发射回调
}

interface LoopOutput {
  nextStates: Array<{ state: AgentState; priority?: Priority }>;
  messages: Message[];
  output: string | null;
  tokenText: string;           // LLM 生成的文本（供 Harness 做 Token 估算）
  refineAttempts?: Record<string, number>;  // 更新后的重试计数
  terminate: boolean;
  terminateReason?: string;
}
```

**关键特性**：

- **纯净**：无可变字段、无隐藏状态、无基础设施依赖。
- **可组合**：可与任何 Harness 配合使用；可独立进行单元测试。
- **可观测**：通过回调发射事件（LLMRequest、LLMChunk、ToolExecStart 等）。
- **执行器映射表**：每个状态类型（`GATHER`、`THINK`、...、`TERMINATE`）有对应的纯处理器，返回 `LoopOutput`。

### 3.2 AgentHarness — 有状态运行时底盘

`AgentHarness` 是核心运行时类。它拥有所有可变状态和基础设施，并将状态转换委托给无状态的 `AgentLoop`。

```typescript
class AgentHarness {
  readonly sessionId: string;
  
  // 状态（可变，由 Harness 拥有）：
  private queue: StateQueue;
  private budget: BudgetManager;
  private messages: Message[];
  private refineAttempts: Map<string, number>;
  private output: { value: string | null };
  private turnCounter: number;
  // ... 等
  
  // 基础设施（由 Harness 拥有）：
  private loop: AgentLoop;           // 无状态引擎 🔄
  private events: EventBus;
  private hooks: HookManager;
  private persistence?: IPersistence;
  private bridge?: WebSocketBridge;
  
  // 钩子包装缓存（构造时创建，避免每次 execute 重建）
  private wrappedLLM: LLMProvider;   // 带钩子的 LLM
  private wrappedTools: Record<string, ToolMetadata>; // 带钩子的工具
}
```

**职责**：

- **Session 管理**：messages[]、queue、budget、counters、output
- **生命周期**：`run()`、`interrupt()`、`injectMessage()`、`dispose()`
- **钩子编排**：在委托给 AgentLoop 前调用 `hooks.beforeState()`
- **持久化**：检查点（SQLite）和快照（文件系统）
- **可观测性**：EventBus → WebSocket 桥接
- **主循环**：`run()` 方法实现双队列调度循环

**主循环伪代码**：

```
function run(initialPrompt):
    attempt_restore()                      // 先试快照，再试检查点
    if not restored:
        enqueue(GATHER(initialPrompt))

    while true:
        // 1. 检查预算，若耗尽则强制终止
        if budget.exhausted and not has_terminate:
            clear_queue()
            enqueue(TERMINATE(urgent))

        // 2. 处理优雅中断
        if interruptFlag == 'graceful':
            inject steering message
            enqueue(THINK)

        // 3. 处理所有紧急状态
        while has_urgent():
            state = dequeue_urgent()
            await execute(state)
            if terminated: return finish()

        // 4. 取普通状态
        state = dequeue_normal()
        if state is null:                 // 空队列
            if output exists: enqueue(TERMINATE)
            else if idle > 3: enqueue(TERMINATE(stall))
            else: enqueue(THINK(idle))
            continue

        await execute(state)
        yield_control()

        if terminated or (queue_empty and output):
            return finish()

function execute(state):
    emit(StateStart)
    budget.bumpIteration()

    // 1. 钩子：前置处理状态
    checked = hooks.beforeState(state)
    if checked == 'abort': return

    // 2. 委托给无状态 AgentLoop
    result = await loop.transition({
        state: checked,
        messages: this.messages,
        tools: this.wrappedTools,             // 构造时已缓存的钩子包装
        llm: this.wrappedLLM,
        refineAttempts: fromMap(this.refineAttempts),
        currentOutput: this.output.value,
        emit: (type, p) => this.events.emit(type, p),
    })

    // 3. Harness 应用结果
    this.messages = result.messages
    this.output.value = result.output
    this.budget.addTokens(result.tokenText)
    if result.refineAttempts:
        this.refineAttempts.update(result.refineAttempts)
    for ns in result.nextStates:
        this.queue.enqueue(ns.state, ns.priority == 'urgent')

    // 4. 检查终止
    if result.terminate:
        this.terminated = true
        this.terminateReason = result.terminateReason

    // 5. 钩子：后置处理
    await hooks.afterState(checked)
    emit(StateEnd)

    // 6. 保存检查点
    if checkpoint_needed:
        save_checkpoint()
```

### 3.3 状态队列（双队列）

- **普通队列**：存储常规状态（`GATHER`, `THINK`, `OBSERVE`, `VERIFY`, `REFINE`, `TERMINATE`）。
- **紧急队列**：存储高优先级状态（`REFLECT`, `TERMINATE`），**总是优先处理**。

**接口**：

```typescript
interface IStateQueue {
  enqueue(state: AgentState, force?: boolean): void;
  dequeue(): AgentState | undefined;
  hasUrgent(): boolean;
  hasTerminateState(): boolean;
  toJSON(): { normal: AgentState[]; urgent: AgentState[] };
  fromJSON(data: ...): void;
  clear(): void;
  get totalSize(): number;
}
```

### 3.4 预算管理

防止无限循环和资源耗尽，支持四种预算维度：

| 预算项             | 默认值        | 说明                             |
| :----------------- | :------------ | :------------------------------- |
| `maxTurns`         | 20            | 最大轮次数                       |
| `maxTotalTokens`   | 10000         | 总 Token 消耗上限                |
| `maxIterations`    | 50            | 最大迭代次数（包含所有状态执行） |
| `maxExecutionTime` | 300000 (5min) | 最长运行时间（毫秒）             |

预算耗尽时，主循环会强制注入 `TERMINATE` 状态，确保优雅退出。

### 3.5 状态执行器（Executor）

每个状态类型在 `AgentLoop` 内部有对应的处理函数：

| 状态        | 处理函数          | 职责                                                     |
| :---------- | :---------------- | :------------------------------------------------------- |
| `GATHER`    | `handleGather`    | 压缩上下文（摘要/截断），然后入队 `THINK`                |
| `THINK`     | `handleThink`     | 调用 LLM 流式推理，聚合工具调用，入队 `ACT` 或 `VERIFY`  |
| `ACT`       | `handleAct`       | 执行工具（并行或顺序），入队 `OBSERVE`                   |
| `OBSERVE`   | `handleObserve`   | 检查工具结果，入队 `THINK` 或 `REFLECT`                  |
| `VERIFY`    | `handleVerify`    | 使用 LLM-as-Judge 评估输出，入队 `TERMINATE` 或 `REFINE` |
| `REFINE`    | `handleRefine`    | 基于反馈重新组织提示，入队 `THINK`                       |
| `REFLECT`   | `handleReflect`   | 自我分析当前状态，决定修正或继续                         |
| `TERMINATE` | `handleTerminate` | 设置终止标志，记录最终输出                               |

所有执行器均**不抛出异常**，而是将错误转换为 `REFLECT` 状态入队。

### 3.6 钩子系统（Hook）

允许用户在状态执行前后插入自定义逻辑：

```typescript
interface AgentHook {
  beforeState?(state: AgentState): Promise<AgentState | 'abort'>;
  afterState?(state: AgentState): Promise<void>;
  beforeLLM?(context: LLMContext): Promise<LLMContext | 'abort'>;
  beforeTool?(context: ToolContext): Promise<ToolContext | 'deny'>;
  afterTool?(result: ToolResult): Promise<ToolResult>;
}
```

内置钩子示例：日志钩子（JSON Lines）、性能指标钩子、敏感词过滤钩子。

钩子由 **Harness** 编排——在委托给 AgentLoop 之前调用 `beforeState`，在 AgentLoop 返回后调用 `afterState`。LLM 和工具的钩子通过缓存包装器注入：Harness 在构造时调用 `wrapLLMWithHooks()` 和 `wrapToolsWithHooks()` 创建带有钩子的 LLM 和工具实例（缓存为 `wrappedLLM` 和 `wrappedTools`），然后传入无状态的 AgentLoop，避免每次状态转换重建包装对象。

------

## 4. 状态机定义

### 4.1 状态类型枚举

```
GATHER → THINK → (ACT → OBSERVE) ↺ THINK → VERIFY → (REFINE ↺ THINK) → TERMINATE
                   ↑_________________|        |______|
                                              (REFLECT) 可随时插入
```

### 4.2 状态转换条件

| 当前状态  | 下一状态  | 触发条件                 |
| :-------- | :-------- | :----------------------- |
| GATHER    | THINK     | 上下文压缩完成           |
| THINK     | ACT       | LLM 响应包含工具调用     |
| THINK     | VERIFY    | LLM 响应不含工具调用     |
| ACT       | OBSERVE   | 工具执行完毕（含并行）   |
| OBSERVE   | THINK     | 观察结果正常，需继续推理 |
| OBSERVE   | REFLECT   | 工具执行出错             |
| VERIFY    | TERMINATE | 验证通过                 |
| VERIFY    | REFINE    | 验证未通过且重试次数 < 3 |
| REFINE    | THINK     | 构建修正提示后重新推理   |
| REFLECT   | THINK     | 需要修正                 |
| REFLECT   | TERMINATE | 无需修正且已有输出       |
| REFLECT   | THINK     | 无需修正但无输出         |
| TERMINATE | (结束)    | 无                       |

### 4.3 中断处理

- **外部中断**：通过 `interrupt()` 方法触发，可注入 `steering` 消息（优雅）或立即停止（硬）。
- **内部中断**：在 `THINK` 流式过程中检测到错误模式（如重复、逻辑矛盾），自动入队 `REFLECT`。

------

## 5. 检查点与持久化

### 5.1 检查点（Checkpoint）

- **存储介质**：Bun 内置 SQLite（`bun:sqlite`）。
- **保存时机**：每完成 N 轮（默认 5 轮）或关键状态（如 `ACT` 后）。
- **存储内容**：
  - 完整队列（普通 + 紧急）
  - 消息历史
  - 预算快照
  - 精炼尝试次数映射
  - 最终输出（若有）
- **恢复**：`restore(sessionId)` 加载最新检查点，恢复全部状态。

**表结构**：

```sql
CREATE TABLE checkpoints (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_count INTEGER,
  queue_normal TEXT,
  queue_urgent TEXT,
  messages TEXT,
  budget_snapshot TEXT,
  refine_attempts TEXT,
  final_output TEXT,
  created_at INTEGER
);
```

### 5.2 紧急快照（Snapshot）

- **存储介质**：文件系统（使用 `Bun.file` / `Bun.write`）。
- **保存时机**：每次检查点保存时同步写入，也支持手动触发（如收到 SIGTERM）。
- **用途**：灾难恢复（进程崩溃后重启），加载最新快照即可继续。

**文件格式**：`snapshot_{sessionId}_{timestamp}.json`，包含完整状态。

### 5.3 持久化接口

```typescript
interface IPersistence {
  saveCheckpoint(data: CheckpointData): Promise<string>;
  loadLatestCheckpoint(sessionId: string): Promise<CheckpointData | null>;
  saveSnapshot(data: SnapshotData): Promise<string>;
  loadLatestSnapshot(sessionId: string): Promise<SnapshotData | null>;
  cleanup(sessionId: string, keep: number): Promise<void>;
}
```

------

## 6. 可观测性

### 6.1 事件总线（EventBus）

所有内部状态变更、LLM 块、工具结果等均以事件形式发布。

**事件类型**：

- `LoopStart` / `LoopEnd`
- `TurnStart` / `TurnEnd`
- `LLMRequest` / `LLMChunk`
- `ToolExecStart` / `ToolExecEnd`
- `StateStart` / `StateEnd`
- `ReflectionResult`
- `Terminate`
- `ExternalInterrupt`

### 6.2 WebSocket 桥接

基于 `Bun.serve()` 的 WebSocket 服务，将事件实时推送给前端。

- **端口**：可配置（默认 8080）
- **端点**：`ws://host:port/agent-ws?sessionId=xxx`
- **消息格式**：JSON，包含 `type`、`payload`、`timestamp`
- **双向通信**：前端可发送 `{type: "INTERRUPT", reason: "..."}` 进行控制。

### 6.3 日志与指标

内置 `LoggerHook` 输出结构化日志（JSON Lines），便于接入 ELK 或 Loki。
性能指标（每轮耗时、Token 消耗、工具调用次数）通过事件总线导出，可集成 Prometheus。

------

## 7. 错误处理与恢复

### 7.1 错误分类

| 错误类型         | 处理策略                                     |
| :--------------- | :------------------------------------------- |
| LLM 超时         | 重试 1 次，失败则入队 `REFLECT`              |
| 工具执行异常     | 记录错误，入队 `OBSERVE`（结果中包含 error） |
| 状态执行异常     | 捕获后转换为 `REFLECT`（紧急），继续循环     |
| 预算耗尽         | 强制注入 `TERMINATE`                         |
| 队列为空且无输出 | 空闲计数器递增，超过阈值后强制终止           |

### 7.2 崩溃恢复流程

1. 进程启动时，`AgentHarness` 尝试加载最近快照（`loadLatestSnapshot`）。
2. 若快照存在，恢复队列、消息、预算等，继续执行。
3. 若快照不存在，尝试加载最新检查点（SQLite）。
4. 若均不存在，视为新会话。

### 7.3 优雅关闭

监听 `SIGTERM` / `SIGINT`，调用 `interrupt('graceful')`，等待当前状态执行完成后再退出。

------

## 8. 性能优化（Bun 特定）

| 优化点        | 实现方式                       | 收益                       |
| :------------ | :----------------------------- | :------------------------- |
| SQLite 检查点 | `bun:sqlite` + WAL 模式        | 写入延迟从 ~15ms 降至 ~1ms |
| 文件快照      | `Bun.write` (io_uring)         | 吞吐量提升 3 倍            |
| WebSocket     | 原生 `Bun.serve()`             | 冷启动快 80%，无额外依赖   |
| 流式 LLM      | `for await` + `queueMicrotask` | 不阻塞主循环，支持高并发   |
| 工具调用并发  | 智能分组（只读并行，写入串行） | 减少总耗时                 |
| 上下文压缩    | 使用 LLM 摘要或向量检索        | 降低 Token 消耗            |

------

## 9. 部署与配置

### 9.1 环境要求

- Bun v1.0.0 或更高
- 至少 2GB 内存（推荐 4GB+）
- 存储空间：SQLite 数据库 + 快照目录（建议 SSD）

### 9.2 配置示例（`config.ts`）

```typescript
export const config: AgentEventLoopConfig = {
  budget: {
    maxTurns: 20,
    maxTotalTokens: 10000,
    maxIterations: 50,
    maxExecutionTime: 300000,
  },
  llm: {
    provider: 'openai',
    model: 'gpt-4o-mini',
    temperature: 0.7,
    apiKey: process.env.OPENAI_API_KEY,
  },
  tools: {
    search: searchHandler,
    calculator: calcHandler,
  },
  checkpoint: {
    enabled: true,
    dbPath: './data/checkpoints.sqlite',
    interval: 5, // 每5轮保存一次
  },
  wsPort: 8080,
  verbose: true,
};
```

### 9.3 启动命令

```bash
bun run src/index.ts --session-id "user-123" --prompt "帮我规划一次旅行"
```

### 9.4 Docker 部署（可选）

提供 Dockerfile，使用 `oven/bun` 基础镜像，暴露 WebSocket 端口。

------

## 10. 测试策略

### 10.1 单元测试（`bun:test`）

- 状态队列入队/出队逻辑
- 预算管理边界条件
- 状态机转换规则
- 序列化/反序列化正确性
- AgentLoop 纯转换输出验证

### 10.2 集成测试

- 模拟 LLM 和工具，验证完整 Agent 流程
- 检查点恢复后状态一致性
- WebSocket 连接与消息收发
- Harness + Loop 集成测试

### 10.3 模糊测试

- 随机生成 LoopInput 验证 `AgentLoop.transition()` 永远不抛异常
- 覆盖所有 8 种状态类型、LLM 异常、工具异常、超长消息等边界

### 10.4 压力测试

- 并发运行多个 Agent 会话
- 长时间运行（超过预算），验证强制终止
- 崩溃恢复（模拟 `kill -9`）

### 10.5 测试覆盖率目标

> 80% 行覆盖率，100% 核心状态转换覆盖率。

当前测试套件：**181 个测试，0 失败**（包含 65 个 AgentLoop 单元测试、29 个 AgentHarness 集成测试、8 个模糊测试）。

------

## 11. 附录

### A. 完整类型定义（`types/states.ts`）

```typescript
export type AgentStateType = 
  | 'GATHER' | 'THINK' | 'ACT' | 'OBSERVE' 
  | 'VERIFY' | 'REFINE' | 'REFLECT' | 'TERMINATE';

export interface BaseState<T extends AgentStateType> {
  type: T;
  id: string;
  timestamp: number;
  priority: 'normal' | 'high' | 'urgent';
}

// 各具体状态继承 BaseState 并添加各自字段...
```

### B. 事件总线接口（`types/events.ts`）

```typescript
export interface AgentEvent {
  type: string;
  payload: any;
  timestamp: number;
}

export interface EventBus {
  emit(event: AgentEvent): void;
  on(type: string, handler: (e: AgentEvent) => void): void;
  onAny(handler: (e: AgentEvent) => void): void;
}
```

### C. 工具注册规范

```typescript
type ToolHandler = (params: any) => Promise<ToolResult>;
interface ToolMetadata {
  name: string;
  description: string;
  parameters: Record<string, any>;
  sideEffects?: boolean; // 为 true 时顺序执行
}
```

### D. 变更日志

| 版本  | 日期       | 变更内容                                                     |
| :---- | :--------- | :----------------------------------------------------------- |
| 1.0.0 | 2026-01-15 | 初始设计（Node.js 版本）                                     |
| 2.0.0 | 2026-07-09 | 重写为 Bun 原生，新增检查点、WebSocket、快照，修复预算和空转缺陷 |
| 3.0.0 | 2026-07-11 | Harness + Loop 分离：AgentLoop（无状态引擎）和 AgentHarness（有状态底盘）；执行器返回纯结果；所有可变状态移至 Harness |
