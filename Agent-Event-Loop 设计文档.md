# Agent-Event-Loop 设计文档

**版本**：2.0.0
**状态**：正式发布
**技术栈**：Bun + TypeScript
**文档日期**：2026-07-09

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

### 1.3 术语表

| 术语             | 定义                                                         |
| :--------------- | :----------------------------------------------------------- |
| Agent-Event-Loop | 本项目的核心调度器，管理状态队列并驱动 Agent 执行            |
| State            | 一个原子认知单元（如 `THINK`, `ACT`），包含类型、数据和优先级 |
| Queue            | 存储待处理 State 的容器，分为普通队列和紧急队列              |
| Turn             | 一轮完整的 Agent 迭代（通常包含 `THINK` → `ACT/OBSERVE` → `VERIFY`） |
| Checkpoint       | 在关键节点保存的状态快照（存储在 SQLite 中）                 |
| Snapshot         | 紧急备份的完整状态（存储在文件系统中）                       |
| Hook             | 在 State 执行前后触发的拦截器，用于日志、鉴权、限流等        |

------

## 2. 总体架构

Agent-Event-Loop 采用分层架构，从上到下依次为：

text

```
┌─────────────────────────────────────────────────────────────┐
│                   应用层 (Application)                       │
│         - 用户输入 / 输出流                                 │
│         - 前端 Dashboard (WebSocket 连接)                   │
├─────────────────────────────────────────────────────────────┤
│              Agent-Event-Loop 核心调度器                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │  State Queue │  │ Budget Mgr   │  │  Hook Mgr    │      │
│  │ (dual queue) │  │ (limits)     │  │ (extensible) │      │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘      │
│         └─────────────────┴─────────────────┘               │
├─────────────────────────────────────────────────────────────┤
│                    执行层 (Executors)                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ LLM      │  │ Tool     │  │ Verifier │  │ Reflector│   │
│  │ Executor │  │ Executor │  │ (Judge)  │  │ (Self)   │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
├─────────────────────────────────────────────────────────────┤
│                    持久化与可观测层                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ Bun SQLite   │  │ Task Snapshot│  │ WebSocket    │      │
│  │ Checkpoints  │  │ (Bun.file)   │  │ Bridge       │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
└─────────────────────────────────────────────────────────────┘
```



**数据流**：

1. 用户输入 → 转换为初始 `GATHER` 状态并入队。
2. 调度器循环从队列取出状态，调用对应执行器。
3. 执行器产生新状态并入队（如 `THINK` → `ACT` → `OBSERVE`）。
4. 关键节点触发检查点保存，同时通过 WebSocket 广播状态变化。
5. 预算耗尽或达到终止条件时，注入 `TERMINATE` 状态，结束循环。

------

## 3. 核心组件设计

### 3.1 AgentEventLoop 主循环

`AgentEventLoop` 是整个框架的核心类，负责：

- 初始化队列、预算、执行器、持久化组件。
- 运行主循环（`run` 方法）。
- 响应外部中断（`interrupt`）和消息注入（`injectMessage`）。

**主循环伪代码**：

text

```
function run(initialPrompt):
    enqueue(GATHER(initialPrompt))
    while true:
        // 检查预算，若耗尽则强制终止
        if budget.exhausted and not has_terminate_state:
            clear_queue()
            enqueue(TERMINATE(urgent))
        
        // 处理所有紧急状态
        while has_urgent():
            state = dequeue_urgent()
            execute(state, urgent=true)
            if should_stop: break
        
        // 取普通状态
        state = dequeue_normal()
        if state is null:
            // 空队列处理：有输出则终止，否则空闲计数++
            if final_output: enqueue(TERMINATE)
            else if idle_spins > 3: enqueue(TERMINATE(reason='stall'))
            else: enqueue(THINK())  // 推进对话
            continue
        
        // 执行状态（非紧急）
        execute(state, urgent=false)
        yield_control()  // 让出事件循环
        
        // 检查终止条件
        if should_stop or (queue_empty and final_output): break
```



**关键方法**：

- `interrupt(type, message)`：支持优雅（注入 steering 消息）或硬中断（清空队列）。
- `injectMessage(message)`：插入人类反馈或外部指令。

### 3.2 状态队列（双队列）

- **普通队列**：存储常规状态（`GATHER`, `THINK`, `OBSERVE`, `VERIFY`, `REFINE`, `TERMINATE`）。
- **紧急队列**：存储高优先级状态（`REFLECT`, `TERMINATE`），**总是优先处理**。

**接口**：

typescript

```
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



### 3.3 预算管理

防止无限循环和资源耗尽，支持四种预算维度：

| 预算项             | 默认值        | 说明                             |
| :----------------- | :------------ | :------------------------------- |
| `maxTurns`         | 20            | 最大轮次数                       |
| `maxTotalTokens`   | 10000         | 总 Token 消耗上限                |
| `maxIterations`    | 50            | 最大迭代次数（包含所有状态执行） |
| `maxExecutionTime` | 300000 (5min) | 最长运行时间（毫秒）             |

预算耗尽时，主循环会强制注入 `TERMINATE` 状态，确保优雅退出。

### 3.4 状态执行器（Executor）

每个状态类型对应一个处理函数，负责具体业务逻辑：

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

### 3.5 钩子系统（Hook）

允许用户在状态执行前后插入自定义逻辑：

typescript

```
interface AgentHook {
  beforeState?(state: AgentState): Promise<AgentState | 'abort'>;
  afterState?(state: AgentState): Promise<void>;
  beforeLLM?(context: LLMContext): Promise<LLMContext | 'abort'>;
  beforeTool?(context: ToolContext): Promise<ToolContext | 'deny'>;
  afterTool?(result: ToolResult): Promise<ToolResult>;
}
```



内置钩子示例：日志钩子、性能指标钩子、敏感词过滤钩子。

------

## 4. 状态机定义

### 4.1 状态类型枚举

text

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

sql

```
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

typescript

```
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

1. 进程启动时，`AgentEventLoop` 尝试加载最近快照（`loadLatestSnapshot`）。
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

typescript

```
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

bash

```
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

### 10.2 集成测试

- 模拟 LLM 和工具，验证完整 Agent 流程
- 检查点恢复后状态一致性
- WebSocket 连接与消息收发

### 10.3 压力测试

- 并发运行多个 Agent 会话
- 长时间运行（超过预算），验证强制终止
- 崩溃恢复（模拟 `kill -9`）

### 10.4 测试覆盖率目标

> 80% 行覆盖率，100% 核心状态转换覆盖率。

------

## 11. 附录

### A. 完整类型定义（`types/states.ts`）

typescript

```
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

typescript

```
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

typescript

```
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

