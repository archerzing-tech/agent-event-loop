# Agent-Event-Loop

> Inject the JavaScript Event Loop philosophy into AI Agent cognition architecture.

[![Bun 1.0+](https://img.shields.io/badge/Bun-1.0+-fbf0df?logo=bun&logoColor=fbf0df)](https://bun.sh)
[![TypeScript 5.0+](https://img.shields.io/badge/TypeScript-5.0+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![MIT License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

---

[**简体中文**](./README.zh-CN.md) · [Design Document (中文)](./Agent-Event-Loop%20设计文档.md)

---

## Overview

**Agent-Event-Loop** is an AI Agent orchestration framework inspired by the JavaScript Event Loop. It transforms the core ideas of Event Loop — **message queue**, **non-blocking I/O**, and **event-driven architecture** — into a scheduling system for **Agent cognition flows**.

| Concept | Agent-Event-Loop | Purpose |
|---|---|---|
| Message Queue | **State Queue** | Schedule cognitive states instead of events |
| Microtask Queue | **Priority Queue** | Urgent states (REFLECT/TERMINATE) are processed first |
| Event Handler | **State Executor** | Handle each cognitive state (THINK, ACT, VERIFY, ...) |
| Error Propagation | **Stateful Recovery** | Errors become REFLECT states instead of crashes |
| GC / Heap | **Session Store** | Persist conversation history and intermediate state |

---

## Architecture

### Layered Design

```mermaid
graph LR
    Input["User Input"]
    Loop["Agent-Event-Loop"]
    Output["Final Result"]

    Input --> Loop
    Loop --> Output
```

### Main Loop Flow

The `run()` method drives the entire cognitive cycle:

```mermaid
flowchart LR
    GATHER --> THINK
    THINK --> ACT
    ACT --> OBSERVE
    OBSERVE --> THINK
    THINK --> VERIFY
    VERIFY --> TERMINATE
    VERIFY --> REFINE
    REFINE --> THINK
```

### State Machine

8 cognitive states form the complete agent lifecycle:

```mermaid
graph LR
    GATHER --> THINK
    THINK --> ACT
    ACT --> OBSERVE
    OBSERVE --> THINK
    THINK --> VERIFY
    VERIFY --> TERMINATE
    VERIFY --> REFINE
    REFINE --> THINK
    REFLECT -.-> THINK
    REFLECT -.-> TERMINATE
```

---

## Features

| Feature | Description |
|---|---|
| **🔄 State-Driven Loop** | `GATHER → THINK → ACT → OBSERVE → VERIFY (+ REFINE/REFLECT) → TERMINATE` |
| **⚡ Dual-Queue Scheduling** | Normal states + urgent queue (REFLECT, TERMINATE processed first) — inspired by Microtask/Macrotask |
| **📊 4D Budget Control** | maxTurns / maxTotalTokens / maxIterations / maxExecutionTime |
| **🩹 Self-Healing Errors** | Errors never crash the loop; they're converted to urgent REFLECT states for self-correction |
| **💾 Checkpoint + Snapshot** | SQLite checkpoints (every N turns) + file system snapshots (disaster recovery) |
| **🌐 WebSocket Observability** | Live event streaming via `ws://host:port/agent-ws?sessionId=xxx` — bidirectional INTERRUPT/INJECT commands |
| **🔌 Hook System** | `beforeState/afterState/beforeLLM/beforeTool/afterTool` — extensible via `AgentHook` interface |
| **🧩 Plugin LLM & Tools** | Swap between MockLLMProvider, OpenAIProvider, or custom providers |
| **⚡ Bun-Native Performance** | `bun:sqlite` (WAL), `Bun.write` (io_uring), `queueMicrotask`, `Bun.serve()` |

---

## Quick Start

### Install

```bash
curl -fsSL https://bun.sh/install | bash
git clone https://github.com/archerzing-tech/agent-event-loop.git
cd agent-event-loop
bun install
```

### Minimal Example

```typescript
import { AgentEventLoop } from 'agent-event-loop';

const agent = new AgentEventLoop({
  llm: { provider: 'openai', model: 'gpt-4o-mini', apiKey: process.env.OPENAI_API_KEY },
  tools: {
    search: async (query) => { /* search logic */ },
    calculator: async (expr) => { /* calculator logic */ },
  },
  budget: { maxTurns: 10, maxTotalTokens: 5000 },
});

const result = await agent.run("Search today's news and summarize into 3 points");
console.log(result.output);
```

### Run Demos

```bash
# Minimal verification (offline, no API key needed)
bun run demo

# Advanced: multi-tool orchestration, VERIFY→REFINE, REFLECT self-heal, budget exhaustion, hook interception
bun run demo:complex

# WebSocket bridge: in-process client subscribes to events, sends INTERRUPT
bun run demo:ws
```

### WebSocket Monitoring

```typescript
// Agent starts WebSocket bridge
const agent = new AgentEventLoop({ wsPort: 8080, /* ... */ });

// Client connects
const ws = new WebSocket('ws://localhost:8080/agent-ws?sessionId=demo');
ws.onmessage = (e) => {
  const evt = JSON.parse(e.data);
  console.log(`[${evt.type}]`, evt.payload);
};

// Send control commands from the frontend
ws.send(JSON.stringify({ type: 'INTERRUPT', kind: 'hard', reason: 'user-cancelled' }));
ws.send(JSON.stringify({ type: 'INJECT', message: 'Use a simpler style' }));
```

### Session Recovery

```typescript
// Reuse the same sessionId to recover from the last checkpoint
const agent = new AgentEventLoop(config, 'user-123-session');
await agent.run('Continue my previous task');
```

---

## Performance Benchmarks

Tested on Bun v1.1.0, MacBook Pro M2 Pro, 16GB RAM:

| Metric | Value |
|---|---|
| Per-turn latency (no tool calls) | ~1.2s |
| Per-turn latency (3 tool calls) | ~2.8s |
| Checkpoint write latency | ~1.2ms |
| WebSocket event broadcast latency | <5ms |
| Crash recovery time | <200ms |
| Recommended concurrent sessions | 100 |

---

## Comparison

| Feature | **Agent-Event-Loop** | LangGraph | AutoGPT | Strands SDK | verl |
|---|---|---|---|---|---|
| **Scheduling** | Queue (Event Loop inspired) | Graph Traversal (DAG) | Recursive Loop | Event-Driven | Coroutines |
| **Interrupt Support** | ✅ Dual-mode | ⚠️ Limited | ❌ | ✅ | ❌ |
| **Persistence** | ✅ SQLite + Snapshots | ❌ | ❌ | ✅ Checkpoints | ❌ |
| **Live Observability** | ✅ WebSocket (native) | ⚠️ Extra setup | ❌ | ✅ Event System | ❌ |
| **Error Recovery** | ✅ Stateful (REFLECT) | ⚠️ Partial | ❌ | ✅ | ❌ |
| **Budget Control** | ✅ 4 Dimensions | ⚠️ Partial | ❌ | ✅ Limits | ❌ |
| **Self-Reflection** | ✅ Built-in REFLECT | ⚠️ Custom | ❌ | ❌ | ❌ |
| **LLM-as-Judge** | ✅ Built-in VERIFY | ⚠️ Custom | ❌ | ✅ | ❌ |
| **Runtime** | ✅ Bun Native | Node.js | Node.js | Python | Python |

---

## Roadmap

### v2.0.0 (Current) ✅
- Core Event Loop scheduler
- Dual-queue + budget control
- SQLite checkpoints + file snapshots
- WebSocket observability (§6.2)
- Stateful error recovery
- 8-state state machine
- Extensible Hook system
- Mock / OpenAI LLM providers

### v2.1.0 (Planned)
- Multi-Agent collaboration (shared queue)
- Vector memory / RAG integration
- Built-in tool expansion
- OpenTelemetry integration

### v2.2.0 (Future)
- Dynamic state injection (real-time intervention)
- Reinforcement learning feedback
- Web UI visual dashboard
- Distributed deployment (Redis queue)

---

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Commit your changes: `git commit -m 'Add amazing feature'`
4. Push: `git push origin feature/amazing-feature`
5. Open a Pull Request

### Testing

```bash
bun test                          # Run all tests
bun test src/core/StateQueue.test.ts  # Specific test
bun test --coverage              # With coverage
```

---

## License

[MIT License](LICENSE) © 2026 Agent-Event-Loop Contributors

---

## Acknowledgements

- **JavaScript Event Loop** — the elegant concurrency model that inspired this project
- **Anthropic** — Agent Loop research and practice
- **Strands SDK** — event-driven agent architecture inspiration
- **LangGraph** — graph traversal and state management paradigm
- **Bun team** — exceptional JavaScript runtime
