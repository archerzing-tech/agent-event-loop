# Agent-Event-Loop

> **v3.0 — 无状态引擎 + 有状态底盘**  
> 将 Agent 循环与运行时框架解耦

[![Bun 1.0+](https://img.shields.io/badge/Bun-1.0+-fbf0df?logo=bun&logoColor=fbf0df)](https://bun.sh)
[![TypeScript 5.0+](https://img.shields.io/badge/TypeScript-5.0+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![MIT License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

[English](./README.md) | **简体中文**

---

## 📖 目录

- [什么是 Agent-Event-Loop](#-什么是-agent-event-loop)
- [灵感来源](#-灵感来源)
- [架构总览](#-架构总览)
- [如何运作](#-如何运作)
- [关键设计决策](#-关键设计决策)
- [与其他系统比较](#-与其他系统比较)
- [快速开始](#-快速开始)
- [设计文档](#-设计文档)
- [路线图](#-路线图)
- [许可证](#-许可证)

---

## 🎯 什么是 Agent-Event-Loop

**Agent-Event-Loop** 是一个受 JavaScript Event Loop 启发而设计的 **AI Agent 调度框架**。它将 Event Loop 的**消息队列**、**非阻塞 I/O**、**事件驱动**等核心思想，系统性地改造为面向 **Agent 认知流程** 的调度体系。

这不是简单的"套壳"，而是**范式的迁移**：

- 原版 Event Loop 调度 **外部事件**（点击、网络请求）
- Agent-Event-Loop 调度 **内部认知状态**（思考、行动、反思、验证）

### v3.0 新特性：两层架构

借鉴 Claude Code、OpenCode、OpenHarness 等行业先锋的设计理念，v3.0 将运行时解耦为**两个独立层次**：

| 层次 | 有状态？ | 职责 |
|:---|:---|:---|
| **AgentLoop** (引擎) | ✅ **无状态** — 零可变字段，纯转换函数 | 思考-行动-观察状态机；调用 LLM 与工具；发出事件 |
| **AgentHarness** (底盘) | ❌ **有状态** — 持有全部会话状态 | 管理队列、消息、预算、持久化、生命周期、钩子、可观测性 |

### 核心映射表

| Event Loop 概念 | Agent-Event-Loop 概念 | 设计意图 |
|:---|:---|:---|
| Message Queue | **State Queue** | 调度单位从"消息"变为"认知状态" |
| Microtask Queue | **Priority Queue** | 高优状态（中断/反思）优先处理 |
| Call Stack | **Turn Context** | 保存当前轮次的上下文快照 |
| Heap | **Session Store** | 持久化对话历史和中间状态 |
| Event Handler | **State Executor** | 执行具体认知状态的逻辑 |
| Event Listener | **Hook System** | 用户可注入自定义拦截逻辑 |
| Rendering | **Streaming** | LLM Token 的实时流式输出 |
| `setTimeout` | **Yield Control** | 主动让出主线程，防止阻塞 |

---

## 💡 灵感来源

### JavaScript Event Loop 的优雅之处

JavaScript Event Loop 是单线程并发模型的典范：

```javascript
while (queue.waitForMessage()) {
  queue.processNextMessage();
}
```

其核心优势：
- **消息驱动**：一切皆为消息，解耦生产者和消费者
- **非阻塞**：I/O 操作不阻塞主线程，通过回调处理结果
- **优先级**：微任务（Microtask）优先于宏任务（Macrotask）
- **可观察**：通过事件监听器暴露内部状态变化

### 为什么是 Event Loop 而非其他模型？

| 并发模型 | 优点 | 缺点 | 适合 Agent？ |
|:---|:---|:---|:---|
| **多线程** | 真正并行 | 竞态条件、死锁、调试困难 | ❌ 风险太高 |
| **Actor 模型** | 隔离性好 | 消息传递开销大 | ⚠️ 过于重量级 |
| **协程** | 轻量、可暂停 | 需要显式调度 | ✅ 部分借鉴 |
| **Event Loop** | 简单、确定、可预测 | 单线程 CPU 密集型瓶颈 | ✅ **最适合** |

**原因**：
1. Agent 的本质是**状态机**，而非并行计算
2. LLM 调用是 I/O 密集型（网络请求），适合非阻塞模型
3. 单线程消除竞态条件，降低心智负担
4. 队列模型天然支持**优先级**和**中断**

### 学术界与工业界的印证

- **Anthropic Agent Loop**：Gather → Act → Verify 循环，本质是消息队列驱动的状态机
- **OpenHarness / OpenClaw**：Agent Loop vs Harness 架构模式分离
- **OpenCode**：多 Agent 编排的启发
- **Strands SDK**：使用 `event_loop_cycle` 作为 Agent 调度的核心模式
- **LangGraph**：图遍历中隐含了队列调度思想

---

## 🏗️ 架构总览

### 两层系统设计

```
┌───────────────────────────────────────────────────────┐
│                    应用层 (Application)                  │
│             用户输入 / 前端 Dashboard                    │
└──────────────────────┬────────────────────────────────┘
                       │
┌──────────────────────▼────────────────────────────────┐
│  ┌─────────────────────────────────────────────────┐  │
│  │         AgentHarness (有状态底盘)                  │  │
│  │                                                   │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────────┐   │  │
│  │  │StateQueue│  │ Budget   │  │ HookManager  │   │  │
│  │  │(双队列)   │  │ (4D限制)  │  │ (可扩展)      │   │  │
│  │  └────┬─────┘  └────┬─────┘  └──────┬───────┘   │  │
│  │       │              │               │            │  │
│  │  ┌────▼──────────────▼───────────────▼────────┐  │  │
│  │  │         Session 状态 (messages, counters)    │  │  │
│  │  └─────────────────────────────────────────────┘  │  │
│  │                                                   │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────────┐   │  │
│  │  │Persistence│  │EventBus  │  │WebSocketBridge│  │  │
│  │  │(检查点)    │  │(事件)    │  │(实时流)       │   │  │
│  │  └──────────┘  └──────────┘  └──────────────┘   │  │
│  └─────────────────────────────────────────────────┘  │
│                       │                                │
│                       │ 委托状态转换                      │
│                       ▼                                │
│  ┌─────────────────────────────────────────────────┐  │
│  │         AgentLoop (无状态引擎)                    │  │
│  │                                                   │  │
│  │  ┌───────┐ ┌───────┐ ┌───────┐ ┌────────┐      │  │
│  │  │ GATHER│ │ THINK │ │ ACT   │ │ OBSERVE│      │  │
│  │  └───────┘ └───────┘ └───────┘ └────────┘      │  │
│  │  ┌───────┐ ┌───────┐ ┌───────┐ ┌────────┐      │  │
│  │  │ VERIFY│ │ REFINE│ │REFLECT│ │TERMINATE│      │  │
│  │  └───────┘ └───────┘ └───────┘ └────────┘      │  │
│  │                                                   │  │
│  │  // 零字段——纯转换函数                              │  │
│  └─────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────┘
```

### 数据流

1. **AgentHarness** 接收用户输入 → 将初始 `GATHER` 状态入队
2. **AgentHarness** 出队状态，调用 `hooks.beforeState()`，用钩子包装 LLM/工具
3. **AgentHarness** 委托给 **AgentLoop.transition(LoopInput)** — 纯计算
4. **AgentLoop** 执行状态机，调用 LLM 与工具，返回 `LoopOutput`
5. **AgentHarness** 将 `LoopOutput` 应用到会话状态，保存检查点，通过 WebSocket 广播
6. 循环重复直到预算耗尽或达到终止条件

### 状态机

8 种状态构成完整的认知循环：

```
GATHER → THINK → (ACT → OBSERVE) ↺ THINK → VERIFY → (REFINE ↺ THINK) → TERMINATE
                  ↑_________________|         |______|
                                              (REFLECT) 可随时插入
```

### 状态转换条件

| 当前状态 | 下一状态 | 触发条件 |
|:---|:---|:---|
| GATHER | THINK | 上下文压缩完成 |
| THINK | ACT | LLM 响应包含工具调用 |
| THINK | VERIFY | LLM 响应不含工具调用 |
| ACT | OBSERVE | 工具执行完毕（含并行） |
| OBSERVE | THINK | 观察结果正常，需继续推理 |
| OBSERVE | REFLECT | 工具执行出错 |
| VERIFY | TERMINATE | 验证通过 |
| VERIFY | REFINE | 验证未通过且重试次数 < 3 |
| REFINE | THINK | 构建修正提示后重新推理 |
| REFLECT | THINK | 需要修正 |
| REFLECT | TERMINATE | 无需修正且已有输出 |
| TERMINATE | (结束) | 无 |

### 主循环伪代码

```
function run(initialPrompt):
    attempt_restore()                      // 尝试从快照/检查点恢复
    if not restored:
        enqueue(GATHER(initialPrompt))

    while true:
        // 1. 检查预算，若耗尽则强制终止
        if budget.exhausted and not has_terminate_state:
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
            if terminated: return

        // 4. 取普通状态
        state = dequeue_normal()
        if state is null:
            // 空队列处理
            if output exists: enqueue(TERMINATE)
            else if idle > 3: enqueue(TERMINATE(stall))
            else: enqueue(THINK(idle))
            continue

        await execute(state)
        yield_control()

        if terminated or (queue_empty and output):
            return

function execute(state):
    // 1. 钩子：前置处理
    checked = hooks.beforeState(state)
    if checked == 'abort': return

    // 2. 委托给无状态 AgentLoop
    result = await loop.transition({
        state: checked,
        messages: this.messages,
        tools: this.tools,
        llm: wrapLLMWithHooks(),
        // ...
    })

    // 3. Harness 应用结果
    this.messages = result.messages
    this.output.value = result.output
    // 入队新状态、更新预算、检查终止

    // 4. 钩子：后置处理
    await hooks.afterState(checked)
    // 5. 保存检查点
```

---

## 🛠️ 关键设计决策

### 1. 无状态引擎 + 有状态底盘分离

遵循 Anthropic 的"解耦大脑与双手"架构和 OpenHarness 的"Agent Loop 作为临时逻辑，Harness 作为持久基础设施"模式：

| 层面 | 设计原则 | 包含内容 |
|:---|:---|:---|
| **AgentLoop** | 零可变字段，纯函数 | 状态机转换逻辑，LLM/工具调用，事件发射 |
| **AgentHarness** | 持有全部可变状态 | Session 状态、持久化、WebSocket、钩子编排 |

**关键洞察**：AgentLoop 本身不持有任何可变状态。所有状态（消息、队列、预算、计数器）由 Harness 管理。Loop 是纯计算——接收上下文，返回结果；Harness 将结果应用到其状态。

### 2. 双队列架构

```typescript
class StateQueue {
  private normalQueue: AgentState[] = [];  // 常规（THINK, ACT, OBSERVE...）
  private urgentQueue: AgentState[] = [];  // 紧急（REFLECT, TERMINATE）
}
```

**为什么需要双队列？**
- Agent 需要**自我打断**能力（发现逻辑错误时立即反思）
- 紧急状态必须**优先处理**，不能排在普通状态之后
- 参考 Event Loop 的 Microtask/Macrotask 分级思想

### 3. 状态驱动的错误恢复

Agent 状态执行器**不抛出异常**，而是将错误转换为 `REFLECT` 紧急状态：

```typescript
try {
  await executeState(state);
} catch (error) {
  queue.enqueue({ type: 'REFLECT', priority: 'urgent', ... });
}
```

从"崩溃"进化为**自愈的智能体**。

### 4. 预算驱动的终止

| 预算项 | 默认值 | 说明 |
|:---|:---|:---|
| `maxTurns` | 20 | 最大轮次数 |
| `maxTotalTokens` | 10000 | 总 Token 消耗上限 |
| `maxIterations` | 50 | 最大迭代次数 |
| `maxExecutionTime` | 300000 (5min) | 最长运行时间 |

预算耗尽 → 强制注入 `TERMINATE`，防止无限循环、Token 爆炸。

### 5. 检查点 + 快照双保险

| 机制 | 存储介质 | 频率 | 用途 |
|:---|:---|:---|:---|
| **检查点** | SQLite | 每 5 轮 | 快速恢复，历史回溯 |
| **快照** | 文件系统 | 同步写入 | 灾难恢复（进程崩溃） |

### 6. WebSocket 可观测性

事件总线（EventBus）驱动 WebSocket 桥接：
- 端点：`ws://host:port/agent-ws?sessionId=xxx`
- 消息格式：`{ type, payload, timestamp }`
- 双向通信：前端可发送 `{ type: "INTERRUPT", reason: "..." }`

### 7. 钩子系统（Hook）

每个状态转换的生命周期都暴露为可拦截的钩子：

```typescript
interface AgentHook {
  beforeState?(state: AgentState): Promise<AgentState | 'abort'>;
  afterState?(state: AgentState): Promise<void>;
  beforeLLM?(context: LLMContext): Promise<LLMContext | 'abort'>;
  beforeTool?(context: ToolContext): Promise<ToolContext | 'deny'>;
  afterTool?(result: ToolResult): Promise<ToolResult>;
}
```

### 8. Bun 原生性能优化

| 优化点 | 实现 | 收益 |
|:---|:---|:---|
| SQLite 检查点 | `bun:sqlite` + WAL | 写入延迟 ~1ms（12x 提升） |
| 文件快照 | `Bun.write` (io_uring) | 吞吐量 3x |
| WebSocket | 原生 `Bun.serve()` | 零依赖，冷启动快 80% |
| 让出控制权 | `queueMicrotask` | 不阻塞主循环 |
| 工具调用并发 | 智能分组（只读并行，写入串行） | 减少总耗时 |

---

## 📊 与其他系统比较

| 特性 | **Agent-Event-Loop v3.0** | LangGraph | AutoGPT | Strands SDK |
|:---|:---|:---|:---|:---|
| **架构模型** | 无状态 Loop + 有状态 Harness | 图遍历 (DAG) | 递归循环 | 事件驱动 |
| **中断支持** | ✅ 优雅/硬双模式 | ⚠️ 有限 | ❌ | ✅ |
| **状态持久化** | ✅ SQLite + 快照 | ❌ | ❌ | ✅ 检查点 |
| **实时可观测** | ✅ WebSocket 原生 | ⚠️ 需额外配置 | ❌ | ✅ 事件系统 |
| **错误恢复** | ✅ 状态化（REFLECT） | ⚠️ 部分 | ❌ | ✅ |
| **预算控制** | ✅ 四维度 | ⚠️ 部分 | ❌ | ✅ Limits |
| **自我反思** | ✅ 内置 REFLECT | ⚠️ 需自定义 | ❌ | ❌ |
| **LLM-as-Judge** | ✅ 内置 VERIFY | ⚠️ 需自定义 | ❌ | ✅ |
| **纯引擎可测性** | ✅ 零字段 AgentLoop | ❌ | ❌ | ❌ |
| **运行时** | ✅ Bun 原生 | Node.js | Node.js | Python |

---

## 🚀 快速开始

### 安装

```bash
# 确保已安装 Bun
curl -fsSL https://bun.sh/install | bash

# 克隆项目
git clone https://github.com/archerzing-tech/agent-event-loop.git
cd agent-event-loop

# 安装依赖
bun install
```

### 最简示例（AgentHarness）

使用 `AgentHarness` 获得完整的 Agent 体验——会话管理、持久化、钩子、WebSocket：

```typescript
import { AgentHarness } from 'agent-event-loop';

const agent = new AgentHarness({
  llm: {
    provider: 'openai',
    model: 'gpt-4o-mini',
    apiKey: process.env.OPENAI_API_KEY,
  },
  tools: {
    search: async (query) => { /* 搜索逻辑 */ },
    calculator: async (expr) => { /* 计算逻辑 */ },
  },
  budget: { maxTurns: 10, maxTotalTokens: 5000 },
});

const result = await agent.run("帮我查一下今天的新闻并总结成三点");
console.log(result.output);
```

### 最简示例（AgentLoop — 纯单元测试）

直接使用 `AgentLoop` 对状态引擎进行隔离的单元测试：

```typescript
import { AgentLoop, type LoopInput } from 'agent-event-loop';
import { makeState } from 'agent-event-loop';

const loop = new AgentLoop();  // ⚡ 零可变状态——可在整个测试套件中复用

const out = await loop.transition({
  state: makeState('THINK'),
  messages: [{ role: 'user', content: 'hello' }],
  tools: {},
  llm: mockLLM,               // 注入你自己的 Mock
  refineAttempts: {},
  currentOutput: null,
  emit: (type, payload) => {}, // 事件间谍
});

expect(out.nextStates[0].state.type).toBe('VERIFY');
```

`AgentLoop` 类有**零个字段**——你可以只实例化一次，跨整个测试套件复用。

### 向后兼容

`AgentEventLoop` 仍作为 `AgentHarness` 的别名可用：

```typescript
import { AgentEventLoop } from 'agent-event-loop';
// 相同的 API，无需修改
const agent = new AgentEventLoop({ /* ... */ });
```

### 运行 Demo

```bash
# 最小验证（离线可跑，无需 API Key）
bun run demo

# 验证高级能力：多工具编排、验证-精炼循环、REFLECT 自愈、预算耗尽、钩子拦截
bun run demo:complex

# WebSocket 桥接验证（进程内连接 + INTERRUPT 控制）
bun run demo:ws
```

### 启用 WebSocket 监控

```typescript
// Agent 启动 WebSocket 桥接
const agent = new AgentHarness({ wsPort: 8080, /* ... */ });

// 前端连接
const ws = new WebSocket('ws://localhost:8080/agent-ws?sessionId=demo');
ws.onmessage = (e) => {
  const evt = JSON.parse(e.data);
  console.log(`[${evt.type}]`, evt.payload);
};

// 从前端发送控制命令
ws.send(JSON.stringify({ type: 'INTERRUPT', kind: 'hard', reason: 'user-cancelled' }));
ws.send(JSON.stringify({ type: 'INJECT', message: '请改用简明风格' }));
```

### 恢复中断的会话

```typescript
// 使用相同的 sessionId，自动从检查点恢复
const agent = new AgentHarness(config, 'user-123-session');
await agent.run('继续我之前的任务');
```

### 性能基准

在 Bun v1.3.0, MacBook Pro M2 Pro, 16GB RAM 上测试：

| 指标 | 值 |
|:---|:---|
| 每轮延迟（无工具调用） | ~1.2s |
| 每轮延迟（3 个工具调用） | ~2.8s |
| 检查点写入延迟 | ~1.2ms |
| WebSocket 事件广播延迟 | <5ms |
| 崩溃恢复时间 | <200ms |
| AgentLoop 纯转换（无 I/O） | <0.01ms |
| 推荐并发连接数 | 100 |

**AgentLoop 纯转换**基准测试衡量无状态引擎自身的开销——低于毫秒级，因为它没有可变状态且没有基础设施依赖。

---

## 📄 设计文档

完整的系统设计文档（中文）见 [Agent-Event-Loop 设计文档](./Agent-Event-Loop%20设计文档.md)，包含：

- 核心组件设计详解（含 v3.0 两层架构）
- 完整状态机与转换条件
- 检查点与持久化机制
- 可观测性与 WebSocket 桥接
- 错误处理与恢复策略
- 性能优化（Bun 特定）
- 部署与配置指南
- 测试策略

---

## 🗺️ 路线图

### v3.0（当前）✅

- 🔄 **Harness + Loop 分离**：AgentLoop（无状态引擎）+ AgentHarness（有状态底盘）
- 🧪 **AgentLoop 单元测试**：65 个测试覆盖全部 8 个执行器 + 调度器
- 📖 **设计文档**：v3.0 架构已记录在 DESIGN.md 中
- 全部 v2.0 特性保留（双队列、预算、检查点、WebSocket、钩子）

### v2.0（上一版本）✅

- 核心 Event Loop 调度器
- 双队列 + 四维预算控制
- Bun SQLite 检查点 + 文件快照
- WebSocket 可观测性（设计文档 §6.2）
- 状态驱动的错误恢复
- 完整状态机（8 种状态）
- Hook 可扩展系统
- Mock / OpenAI LLM Provider

### v2.1（计划中）

- ⬜ 多 Agent 协作（共享队列）
- ⬜ 向量记忆检索（RAG 集成）
- ⬜ 更丰富的内置工具集
- ⬜ OpenTelemetry 集成

### v2.2（未来）

- ⬜ 动态状态注入（用户实时干预）
- ⬜ 强化学习反馈集成
- ⬜ Web UI 可视化 Dashboard
- ⬜ 分布式部署（Redis 队列）

---

## 📁 项目结构

```
src/
  agentLoop/
    AgentLoop.ts           # 🆕 无状态引擎——纯转换函数
    AgentLoop.test.ts      # 🆕 65 个无状态引擎单元测试
  harness/
    AgentHarness.ts        # 🆕 有状态运行时——会话、生命周期、基础设施
  core/
    AgentEventLoop.ts      # AgentHarness 的向后兼容别名
    StateQueue.ts          # 双队列（普通 + 紧急）
    EventBus.ts            # 内存事件总线
    BudgetManager.ts       # 4D 预算控制
  hooks/
    HookManager.ts         # 可扩展钩子系统
  persistence/
    Persistence.ts         # SQLite 检查点 + 文件快照
  observability/
    WebSocketBridge.ts     # 实时事件流
  llm/
    MockLLMProvider.ts     # 离线测试 Provider
    OpenAIProvider.ts      # OpenAI 集成
  types/
    states.ts              # AgentState, Priority
    events.ts              # AgentEvent, EventBus 类型
    config.ts              # 配置类型
```

---

## 🎮 适用场景

| 场景 | 适用性 | 说明 |
|:---|:---|:---|
| 客户支持 Agent | ⭐⭐⭐⭐⭐ | 长时间对话，需要中断和恢复 |
| 代码生成与审查 | ⭐⭐⭐⭐⭐ | 多轮验证和精炼 |
| 研究助理 | ⭐⭐⭐⭐ | 搜索→阅读→总结，工具调用密集 |
| 自主决策系统 | ⭐⭐⭐⭐ | 需要反思和自我修正 |
| 实时交互应用 | ⭐⭐⭐⭐⭐ | WebSocket 流式输出 |
| 批量任务处理 | ⭐⭐⭐⭐ | 预算控制防止成本失控 |
| 教育/演示 | ⭐⭐⭐⭐⭐ | 可视化状态流转 |

---

## 🤝 贡献指南

1. Fork 本仓库
2. 创建功能分支：`git checkout -b feature/amazing-feature`
3. 提交变更：`git commit -m 'Add some amazing feature'`
4. 推送分支：`git push origin feature/amazing-feature`
5. 提交 Pull Request

### 测试

```bash
# 运行所有测试（173+ 个）
bun test

# 运行特定 AgentLoop 测试
bun test src/agentLoop/AgentLoop.test.ts

# 测试覆盖率
bun test --coverage
```

---

## 📄 许可证

[MIT License](LICENSE) © 2026 Agent-Event-Loop Contributors

---

## 🙏 致谢

- **JavaScript Event Loop**：提供了优雅的并发模型灵感
- **Anthropic**：Agent Loop 的研究与实践（解耦大脑与双手）
- **OpenHarness / OpenClaw**：Agent Loop vs Harness 架构模式
- **OpenCode**：多 Agent 编排的启发
- **Strands SDK**：事件驱动 Agent 架构的启发
- **LangGraph**：图遍历与状态管理的范式
- **Bun 团队**：提供了卓越的 JavaScript 运行时
