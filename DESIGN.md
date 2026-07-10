# Agent-Event-Loop Design Document

**Version**: 2.0.0
**Status**: Released
**Stack**: Bun + TypeScript
**Date**: 2026-07-09

---

## 1. Introduction

### 1.1 Background

As Large Language Models (LLMs) grow more capable, building agents that can reason autonomously, invoke tools, and self-correct becomes a pressing need. Traditional agent implementations rely on recursive calls or simple while loops — they lack systematic support for concurrency, interruption, persistence, and observability.

The Event Loop model from the JavaScript/TypeScript ecosystem — built on message queues and non-blocking I/O — provides an elegant concurrency paradigm. This project **borrows** the core ideas of that model (not its implementation details) and repurposes them into a scheduling framework for **Agent cognition flows**, named **Agent-Event-Loop**.

### 1.2 Design Goals

- **Deterministic Scheduling**: Clear state transitions with priority and interrupt support.
- **Resilient Recovery**: Checkpoints and snapshots enable seamless recovery after crashes.
- **Observability**: Real-time event exposure for monitoring and debugging.
- **High Performance**: Leverages Bun's native capabilities for low latency.
- **Extensibility**: A Hook mechanism lets users inject custom logic.

### 1.3 Glossary

| Term             | Definition |
|-----------------|------------|
| Agent-Event-Loop | The core scheduler managing the state queue and driving agent execution |
| State           | An atomic cognitive unit (e.g. `THINK`, `ACT`) with type, data, and priority |
| Queue           | A container for pending States, split into normal and urgent queues |
| Turn            | One complete agent iteration (typically `THINK → ACT/OBSERVE → VERIFY`) |
| Checkpoint      | A state snapshot saved at key milestones (stored in SQLite) |
| Snapshot        | An emergency full-state backup (stored in the filesystem) |
| Hook            | An interceptor triggered before/after state execution (logging, auth, rate limiting) |

---

## 2. Overall Architecture

Agent-Event-Loop uses a layered architecture:

```text
┌─────────────────────────────────────────────────────────────┐
│                   Application Layer                          │
│         - User Input / Output Stream                         │
│         - Frontend Dashboard (WebSocket connection)          │
├─────────────────────────────────────────────────────────────┤
│              Agent-Event-Loop Core Scheduler                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │  State Queue │  │ Budget Mgr   │  │  Hook Mgr    │      │
│  │ (dual queue) │  │ (limits)     │  │ (extensible) │      │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘      │
│         └─────────────────┴─────────────────┘               │
├─────────────────────────────────────────────────────────────┤
│                   Execution Layer (Executors)                │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ LLM      │  │ Tool     │  │ Verifier │  │ Reflector│   │
│  │ Executor │  │ Executor │  │ (Judge)  │  │ (Self)   │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
├─────────────────────────────────────────────────────────────┤
│               Persistence & Observability Layer              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ Bun SQLite   │  │ Task Snapshot│  │ WebSocket    │      │
│  │ Checkpoints  │  │ (Bun.file)   │  │ Bridge       │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
└─────────────────────────────────────────────────────────────┘
```

**Data flow:**

1. User input → converted into an initial `GATHER` state and enqueued.
2. The scheduler loop dequeues states and calls the appropriate executor.
3. Executors produce new states and enqueue them (e.g. `THINK → ACT → OBSERVE`).
4. At key milestones a checkpoint is saved; state changes are broadcast via WebSocket.
5. When the budget is exhausted or termination conditions are met, a `TERMINATE` state is injected and the loop ends.

---

## 3. Core Component Design

### 3.1 AgentEventLoop Main Loop

`AgentEventLoop` is the framework's central class. It is responsible for:

- Initializing the queue, budget, executors, and persistence components.
- Running the main loop (the `run` method).
- Responding to external interrupts (`interrupt`) and message injection (`injectMessage`).

**Main loop pseudocode:**

```text
function run(initialPrompt):
    enqueue(GATHER(initialPrompt))
    while true:
        // Check budget; force terminate if exhausted
        if budget.exhausted and not has_terminate_state:
            clear_queue()
            enqueue(TERMINATE(urgent))

        // Process all urgent states
        while has_urgent():
            state = dequeue_urgent()
            execute(state, urgent=true)
            if should_stop: break

        // Dequeue a normal state
        state = dequeue_normal()
        if state is null:
            // Empty queue handling: terminate if output exists, else count idle
            if final_output: enqueue(TERMINATE)
            else if idle_spins > 3: enqueue(TERMINATE(reason='stall'))
            else: enqueue(THINK())    // advance conversation
            continue

        // Execute the state (non-urgent)
        execute(state, urgent=false)
        yield_control()    // yield to the event loop

        // Check termination conditions
        if should_stop or (queue_empty and final_output): break
```

**Key methods:**

- `interrupt(type, message)`: Supports graceful (inject a steering message) or hard (clear the queue) interruption.
- `injectMessage(message)`: Insert human feedback or external commands.

### 3.2 State Queue (Dual Queue)

- **Normal Queue**: Stores regular states (`GATHER`, `THINK`, `OBSERVE`, `VERIFY`, `REFINE`, `TERMINATE`).
- **Urgent Queue**: Stores high-priority states (`REFLECT`, `TERMINATE`), **always processed first**.

**Interface:**

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

### 3.3 Budget Management

Prevents infinite loops and resource exhaustion via four dimensions:

| Budget Item        | Default       | Description |
|--------------------|---------------|-------------|
| `maxTurns`         | 20            | Maximum number of turns |
| `maxTotalTokens`   | 10000         | Maximum total token consumption |
| `maxIterations`    | 50            | Maximum iterations (all state executions) |
| `maxExecutionTime` | 300000 (5min) | Maximum wall-clock time (ms) |

When any budget limit is hit, the main loop forcibly injects a `TERMINATE` state to ensure a graceful exit.

### 3.4 State Executors

Each state type has a corresponding handler function:

| State       | Handler           | Responsibility |
|-------------|-------------------|----------------|
| `GATHER`    | `handleGather`    | Compress context (summarize/truncate), enqueue `THINK` |
| `THINK`     | `handleThink`     | Call LLM with streaming; aggregate tool calls; enqueue `ACT` or `VERIFY` |
| `ACT`       | `handleAct`       | Execute tools (parallel or sequential); enqueue `OBSERVE` |
| `OBSERVE`   | `handleObserve`   | Inspect tool results; enqueue `THINK` or `REFLECT` |
| `VERIFY`    | `handleVerify`    | Use LLM-as-Judge to evaluate output; enqueue `TERMINATE` or `REFINE` |
| `REFINE`    | `handleRefine`    | Reorganize the prompt based on feedback; enqueue `THINK` |
| `REFLECT`   | `handleReflect`   | Self-analyze the current state; decide to fix or terminate |
| `TERMINATE` | `handleTerminate` | Set the termination flag; record the final output |

All executors **never throw exceptions**. Errors are converted into `REFLECT` states and enqueued as urgent.

### 3.5 Hook System

Allows users to inject custom logic before/after state execution:

```typescript
interface AgentHook {
  beforeState?(state: AgentState): Promise<AgentState | 'abort'>;
  afterState?(state: AgentState): Promise<void>;
  beforeLLM?(context: LLMContext): Promise<LLMContext | 'abort'>;
  beforeTool?(context: ToolContext): Promise<ToolContext | 'deny'>;
  afterTool?(result: ToolResult): Promise<ToolResult>;
}
```

Built-in hook examples: logger hook (JSON Lines), performance metrics hook, sensitive-word filter hook.

---

## 4. State Machine Definition

### 4.1 State Type Flow

```text
GATHER → THINK → (ACT → OBSERVE) ↺ THINK → VERIFY → (REFINE ↺ THINK) → TERMINATE
                   ↑_________________|        |______|
                                              (REFLECT) can be injected at any time as an urgent state
```

### 4.2 State Transition Conditions

| Current State | Next State | Trigger Condition |
|---------------|------------|-------------------|
| GATHER        | THINK      | Context compression complete |
| THINK         | ACT        | LLM response includes tool calls |
| THINK         | VERIFY     | LLM response has no tool calls |
| ACT           | OBSERVE    | Tool execution complete (parallel or serial) |
| OBSERVE       | THINK      | Results normal, continue reasoning |
| OBSERVE       | REFLECT    | Tool execution failed |
| VERIFY        | TERMINATE  | Verification passed |
| VERIFY        | REFINE     | Verification failed and retries < 3 |
| REFINE        | THINK      | Reformulated prompt ready for re-reasoning |
| REFLECT       | THINK      | Fix needed |
| REFLECT       | TERMINATE  | No fix needed and output exists |
| REFLECT       | THINK      | No fix needed and no output exists |
| TERMINATE     | (end)      | N/A |

### 4.3 Interrupt Handling

- **External Interrupt**: Triggered via `interrupt()`. Can inject a steering message (graceful) or stop immediately (hard).
- **Internal Interrupt**: During `THINK` streaming, if error patterns are detected (repetition, contradiction), a `REFLECT` state is auto-enqueued.

---

## 5. Checkpoints & Persistence

### 5.1 Checkpoints

- **Storage**: Bun built-in SQLite (`bun:sqlite`).
- **Save trigger**: Every N turns (default 5) or after key states (e.g. after `ACT`).
- **Stored content**:
  - Full queue (normal + urgent)
  - Message history
  - Budget snapshot
  - Refine attempt counters
  - Final output (if any)
- **Recovery**: `restore(sessionId)` loads the latest checkpoint and restores all state.

**Table schema:**

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

### 5.2 Emergency Snapshots

- **Storage**: Filesystem (using `Bun.file` / `Bun.write`).
- **Save trigger**: Written synchronously with every checkpoint save; can also be triggered manually (e.g. on SIGTERM).
- **Purpose**: Disaster recovery — after a process crash, restart loads the latest snapshot to continue.

**File format**: `snapshot_{sessionId}_{timestamp}.json`, containing the full state.

### 5.3 Persistence Interface

```typescript
interface IPersistence {
  saveCheckpoint(data: CheckpointData): Promise<string>;
  loadLatestCheckpoint(sessionId: string): Promise<CheckpointData | null>;
  saveSnapshot(data: SnapshotData): Promise<string>;
  loadLatestSnapshot(sessionId: string): Promise<SnapshotData | null>;
  cleanup(sessionId: string, keep: number): Promise<void>;
}
```

---

## 6. Observability

### 6.1 EventBus

All internal state changes, LLM chunks, tool results, etc., are published as events.

**Event types:**

- `LoopStart` / `LoopEnd`
- `TurnStart` / `TurnEnd`
- `LLMRequest` / `LLMChunk`
- `ToolExecStart` / `ToolExecEnd`
- `StateStart` / `StateEnd`
- `ReflectionResult`
- `Terminate`
- `ExternalInterrupt`

### 6.2 WebSocket Bridge

A WebSocket server built on `Bun.serve()` that pushes events to the frontend in real time.

- **Port**: Configurable (default 8080)
- **Endpoint**: `ws://host:port/agent-ws?sessionId=xxx`
- **Message format**: JSON with `type`, `payload`, `timestamp`
- **Bidirectional**: Frontend can send `{type: "INTERRUPT", reason: "..."}` for control

### 6.3 Logging & Metrics

A built-in `LoggerHook` produces structured logs (JSON Lines), suitable for ingestion into ELK or Loki. Performance metrics (per-turn latency, token consumption, tool call counts) are exported through the event bus and can be integrated with Prometheus.

---

## 7. Error Handling & Recovery

### 7.1 Error Classification

| Error Type          | Handling Strategy |
|---------------------|-------------------|
| LLM timeout         | Retry 1 time; if still failing, enqueue `REFLECT` |
| Tool execution error| Log the error, enqueue `OBSERVE` with error in result |
| State execution error| Catch and convert to `REFLECT` (urgent); continue loop |
| Budget exhausted    | Force-inject `TERMINATE` |
| Empty queue + no output | Increment idle counter; force terminate after threshold |

### 7.2 Crash Recovery Flow

1. On process start, `AgentEventLoop` tries to load the latest snapshot (`loadLatestSnapshot`).
2. If a snapshot exists, restore queue, messages, budget, etc., and continue.
3. If no snapshot exists, try the latest SQLite checkpoint.
4. If neither exists, treat as a new session.

### 7.3 Graceful Shutdown

Listen for `SIGTERM` / `SIGINT`, call `interrupt('graceful')`, wait for the current state to finish executing, then exit.

---

## 8. Bun-Specific Performance Optimizations

| Optimization        | Implementation               | Benefit |
|---------------------|------------------------------|---------|
| SQLite checkpoints  | `bun:sqlite` + WAL mode      | Write latency from ~15ms to ~1ms |
| File snapshots      | `Bun.write` (io_uring)       | 3x throughput |
| WebSocket           | Native `Bun.serve()`         | 80% faster cold start, zero deps |
| Streaming LLM       | `for await` + `queueMicrotask` | Non-blocking main loop |
| Parallel tool calls | Smart grouping (read-only parallel, writes serial) | Lower total latency |
| Context compression | LLM summarization or vector retrieval | Reduced token consumption |

---

## 9. Deployment & Configuration

### 9.1 Requirements

- Bun v1.0.0 or later
- Minimum 2 GB RAM (4 GB+ recommended)
- Storage: SQLite database + snapshot directory (SSD recommended)

### 9.2 Configuration Example (`config.ts`)

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
    interval: 5,    // save every 5 turns
  },
  wsPort: 8080,
  verbose: true,
};
```

### 9.3 Startup Command

```bash
bun run src/index.ts --session-id "user-123" --prompt "Plan a trip for me"
```

### 9.4 Docker (Optional)

A `Dockerfile` is provided using the `oven/bun` base image, exposing the WebSocket port.

---

## 10. Testing Strategy

### 10.1 Unit Tests (`bun:test`)

- State queue enqueue/dequeue logic
- Budget manager boundary conditions
- State machine transition rules
- Serialization / deserialization correctness

### 10.2 Integration Tests

- Mock LLM and tools; verify full agent flow
- Checkpoint recovery state consistency
- WebSocket connection and message exchange

### 10.3 Stress Tests

- Run multiple agent sessions concurrently
- Long-running sessions (beyond budget) to verify forced termination
- Crash recovery (simulate `kill -9`)

### 10.4 Coverage Targets

> 80% line coverage, 100% core state transition coverage.

---

## 11. Appendix

### A. Full Type Definitions (`types/states.ts`)

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

// Specific states extend BaseState with additional fields...
```

### B. EventBus Interface (`types/events.ts`)

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

### C. Tool Registration Specification

```typescript
type ToolHandler = (params: any) => Promise<ToolResult>;
interface ToolMetadata {
  name: string;
  description: string;
  parameters: Record<string, any>;
  sideEffects?: boolean;    // true = execute sequentially
}
```

### D. Changelog

| Version | Date       | Changes |
|---------|------------|---------|
| 1.0.0   | 2026-01-15 | Initial design (Node.js version) |
| 2.0.0   | 2026-07-09 | Rewritten for Bun native; added checkpoints, WebSocket, snapshots; fixed budget and idle-spin defects |
