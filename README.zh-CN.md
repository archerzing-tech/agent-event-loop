# Agent-Event-Loop

> 将 JavaScript Event Loop 的哲学注入 AI Agent 认知架构

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

### 核心哲学

| 维度 | 原版 Event Loop | Agent-Event-Loop | 改造说明 |
|:---|:---|:---|:---|
| **调度对象** | 外部事件（点击、网络完成） | 内部认知状态（思考、行动、反思） | 从"发生了什么"到"我想干什么" |
| **消息来源** | 用户/操作系统 | Agent 自身执行结果 | 从外部驱动到自我驱动 |
| **调度策略** | FIFO 严格 | 动态优先级（紧急/普通） | 支持中断和反思的认知架构 |
| **终止条件** | 队列为空 | 目标达成或预算耗尽 | 从"无事可做"到"任务完成" |
| **错误处理** | 抛出异常 | 转换为 REFLECT 状态 | 从"崩溃"到"自我修复" |

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
- **Strands SDK**：使用 `event_loop_cycle` 作为 Agent 调度的核心模式
- **verl 项目**：`AgentLoopBase` 抽象了用户自定义循环的能力
- **LangGraph**：图遍历中隐含了队列调度思想

---

## 🏗️ 架构总览

Agent-Event-Loop 采用**分层架构**，从上到下依次为：

```
┌─────────────────────────────────────────────────────────────┐
│                     应用层 (Application)                      │
│         - 用户输入 / 输出流                                  │
│         - 前端 Dashboard (WebSocket 连接)                    │
├─────────────────────────────────────────────────────────────┤
│               Agent-Event-Loop 核心调度器                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │  State Queue │  │ Budget Mgr   │  │  Hook Mgr    │       │
│  │ (dual queue) │  │ (4D limits)  │  │ (extensible) │       │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘       │
│         └─────────────────┴─────────────────┘                │
├─────────────────────────────────────────────────────────────┤
│                     执行层 (Executors)                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │
│  │  LLM     │  │  Tool    │  │ Verifier │  │ Reflector│    │
│  │ Executor │  │ Executor │  │ (Judge)  │  │ (Self)   │    │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘    │
├─────────────────────────────────────────────────────────────┤
│                   持久化与可观测层                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │ Bun SQLite   │  │Task Snapshot │  │ WebSocket    │       │
│  │ Checkpoints  │  │(Bun.file)    │  │ Bridge       │       │
│  └──────────────┘  └──────────────┘  └──────────────┘       │
└─────────────────────────────────────────────────────────────┘
```

### 数据流

1. **用户输入** → 转换为初始 `GATHER` 状态并入队
2. **调度器循环**从队列取出状态，调用对应执行器
3. **执行器**产生新状态并入队（如 `THINK` → `ACT` → `OBSERVE`）
4. **关键节点**触发检查点保存，同时通过 WebSocket 广播状态变化
5. **预算耗尽**或达到终止条件时，注入 `TERMINATE` 状态，结束循环

---

## 🔄 如何运作

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
    enqueue(GATHER(initialPrompt))
    while true:
        // 1. 检查预算，若耗尽则强制终止
        if budget.exhausted and not has_terminate_state:
            clear_queue()
            enqueue(TERMINATE(urgent))

        // 2. 处理所有紧急状态（REFLECT / TERMINATE）
        while has_urgent():
            state = dequeue_urgent()
            execute(state, urgent=true)
            if should_stop: break

        // 3. 取普通状态
        state = dequeue_normal()
        if state is null:
            // 空队列处理：有输出则终止，否则空闲计数++
            if final_output: enqueue(TERMINATE)
            else if idle_spins > 3: enqueue(TERMINATE(reason='stall'))
            else: enqueue(THINK())  // 推进对话
            continue

        // 4. 执行状态（非紧急）
        execute(state, urgent=false)
        yield_control()  // 让出事件循环，避免阻塞

        // 5. 检查终止条件
        if should_stop or (queue_empty and final_output): break
```

---

## 🛠️ 关键设计决策

### 1. 双队列架构

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

### 2. 状态驱动的错误恢复

Agent 状态执行器**不抛出异常**，而是将错误转换为 `REFLECT` 紧急状态：

```typescript
try {
  await executeState(state);
} catch (error) {
  queue.enqueue({ type: 'REFLECT', priority: 'urgent', ... });
}
```

从"崩溃"进化为**自愈的智能体**。

### 3. 预算驱动的终止

| 预算项 | 默认值 | 说明 |
|:---|:---|:---|
| `maxTurns` | 20 | 最大轮次数 |
| `maxTotalTokens` | 10000 | 总 Token 消耗上限 |
| `maxIterations` | 50 | 最大迭代次数 |
| `maxExecutionTime` | 300000 (5min) | 最长运行时间 |

预算耗尽 → 强制注入 `TERMINATE`，防止无限循环、Token 爆炸。

### 4. 检查点 + 快照双保险

| 机制 | 存储介质 | 频率 | 用途 |
|:---|:---|:---|:---|
| **检查点** | SQLite | 每 5 轮 | 快速恢复，历史回溯 |
| **快照** | 文件系统 | 同步写入 | 灾难恢复（进程崩溃）|

### 5. WebSocket 可观测性

事件总线（EventBus）驱动 WebSocket 桥接：
- 端点：`ws://host:port/agent-ws?sessionId=xxx`
- 消息格式：`{ type, payload, timestamp }`
- 双向通信：前端可发送 `{ type: "INTERRUPT", reason: "..." }`

### 6. Bun 原生性能优化

| 优化点 | 实现 | 收益 |
|:---|:---|:---|
| SQLite 检查点 | `bun:sqlite` + WAL | 写入延迟 ~1ms（12x 提升） |
| 文件快照 | `Bun.write` (io_uring) | 吞吐量 3x |
| WebSocket | 原生 `Bun.serve()` | 零依赖，冷启动快 80% |
| 让出控制权 | `queueMicrotask` | 不阻塞主循环 |
| 工具调用并发 | 智能分组（只读并行，写入串行） | 减少总耗时 |

---

## 📊 与其他系统比较

| 特性 | **Agent-Event-Loop** | LangGraph | AutoGPT | Strands SDK | verl |
|:---|:---|:---|:---|:---|:---|
| **调度模型** | 队列（Event Loop 改造） | 图遍历 (DAG) | 递归循环 | 事件驱动 | 协程 |
| **中断支持** | ✅ 优雅/硬双模式 | ⚠️ 有限 | ❌ | ✅ | ❌ |
| **状态持久化** | ✅ SQLite + 快照 | ❌ | ❌ | ✅ 检查点 | ❌ |
| **实时可观测** | ✅ WebSocket 原生 | ⚠️ 需额外配置 | ❌ | ✅ 事件系统 | ❌ |
| **错误恢复** | ✅ 状态化（REFLECT） | ⚠️ 部分 | ❌ | ✅ | ❌ |
| **预算控制** | ✅ 四维度 | ⚠️ 部分 | ❌ | ✅ Limits | ❌ |
| **自我反思** | ✅ 内置 REFLECT | ⚠️ 需自定义 | ❌ | ❌ | ❌ |
| **LLM-as-Judge** | ✅ 内置 VERIFY | ⚠️ 需自定义 | ❌ | ✅ | ❌ |
| **运行时** | ✅ Bun 原生 | Node.js | Node.js | Python | Python |

### vs LangGraph
LangGraph 用图遍历模型，节点边需预定义，适合确定性流程。Agent-Event-Loop 用队列模型，状态转换由 LLM 动态决定，**更灵活**。

### vs AutoGPT
AutoGPT 是简单 while 循环 + 递归，缺乏调度控制和资源管理。Agent-Event-Loop 提供预算、中断、检查点等**企业级能力**。

### vs Strands SDK
Strands 是 Python 生态的优秀 Agent 框架。Agent-Event-Loop 借鉴其事件驱动理念，但使用 **TypeScript + Bun**，类型更安全、性能更优。

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

### 最简示例

```typescript
import { AgentEventLoop } from './src/core/AgentEventLoop';

const agent = new AgentEventLoop({
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
const agent = new AgentEventLoop({
  // ... 其他配置
  wsPort: 8080,
});

// 前端连接
const ws = new WebSocket('ws://localhost:8080/agent-ws?sessionId=xxx');
ws.onmessage = (e) => {
  const event = JSON.parse(e.data);
  console.log('[Agent Event]', event.type, event.payload);
};
```

### 恢复中断的会话

```typescript
// 使用相同的 sessionId
const agent = new AgentEventLoop(config, 'user-123-session');
// 自动从检查点恢复
await agent.run('继续我之前的任务');
```

---

## 📄 设计文档

完整的系统设计文档（中文）见 [Agent-Event-Loop 设计文档](./Agent-Event-Loop%20设计文档.md)，包含：

- 核心组件设计详解
- 完整状态机与转换条件
- 检查点与持久化机制
- 可观测性与 WebSocket 桥接
- 错误处理与恢复策略
- 性能优化（Bun 特定）
- 部署与配置指南
- 测试策略

---

## 🗺️ 路线图

### v2.0.0（当前）✅

- ✅ 核心 Event Loop 调度器
- ✅ 双队列 + 四维预算控制
- ✅ Bun SQLite 检查点 + 文件快照
- ✅ WebSocket 可观测性（设计文档 §6.2）
- ✅ 状态驱动的错误恢复
- ✅ 完整状态机（8 种状态）
- ✅ Hook 可扩展系统
- ✅ Mock / OpenAI LLM Provider

### v2.1.0（计划中）

- ⬜ 多 Agent 协作（共享队列）
- ⬜ 向量记忆检索（RAG 集成）
- ⬜ 更丰富的内置工具集
- ⬜ OpenTelemetry 集成

### v2.2.0（未来）

- ⬜ 动态状态注入（用户实时干预）
- ⬜ 强化学习反馈集成
- ⬜ Web UI 可视化 Dashboard
- ⬜ 分布式部署（Redis 队列）

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
# 运行所有测试
bun test

# 运行特定测试
bun test src/core/StateQueue.test.ts

# 测试覆盖率
bun test --coverage
```

---

## 📄 许可证

[MIT License](LICENSE) © 2026 Agent-Event-Loop Contributors

---

## 🙏 致谢

- **JavaScript Event Loop**：提供了优雅的并发模型灵感
- **Anthropic**：Agent Loop 的研究与实践
- **Strands SDK**：事件驱动 Agent 架构的启发
- **LangGraph**：图遍历与状态管理的范式
- **Bun 团队**：提供了卓越的 JavaScript 运行时
