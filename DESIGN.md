# Agent-Event-Loop Design Document

**Version**: 3.0.0
**Status**: Released
**Stack**: Bun + TypeScript
**Date**: 2026-07-11

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
- **Separation of Concerns**: Agent Loop (stateless engine) vs Agent Harness (stateful chassis).

### 1.3 Architecture Philosophy: Stateless Loop + Stateful Harness

Following the industry evolution pioneered by Claude Code, OpenCode, and OpenHarness,
Agent-Event-Loop v3.0 **decouples** the agent runtime into two distinct layers:

| Layer | Stateless? | Responsibility |
|-------|-----------|----------------|
| **AgentLoop** (Engine) | ✅ **Stateless** — no mutable fields, pure transition functions | Think-act-observe state machine; calls LLM & tools; emits events |
| **AgentHarness** (Chassis) | ❌ **Stateful** — owns all session state | Manages queue, messages, budget, persistence, lifecycle, hooks, observability |

This mirrors Anthropic's "decoupled brain vs hands" architecture and OpenHarness's
"Agent Loop as ephemeral logic, Harness as persistent infrastructure" pattern.

**Key insight**: The AgentLoop itself holds no mutable state. All state (messages, queue,
budget, counters) is managed by the Harness. The Loop is a pure computation that receives
context and returns results — the Harness applies those results to its state.

### 1.4 Glossary

| Term             | Definition |
|-----------------|------------|
| AgentLoop       | Stateless state machine engine: pure transition functions |
| AgentHarness    | Stateful runtime: manages session, queue, lifecycle, persistence |
| State           | An atomic cognitive unit (e.g. `THINK`, `ACT`) with type, data, and priority |
| Queue           | A container for pending States, split into normal and urgent queues |
| Turn            | One complete agent iteration (typically `THINK → ACT/OBSERVE → VERIFY`) |
| Checkpoint      | A state snapshot saved at key milestones (stored in SQLite) |
| Snapshot        | An emergency full-state backup (stored in the filesystem) |
| Hook            | An interceptor triggered before/after state execution (logging, auth, rate limiting) |
| LoopInput       | The data passed into AgentLoop for a single state transition (immutable snapshot) |
| LoopOutput      | The result produced by AgentLoop after processing one state |

---

## 2. Overall Architecture

### 2.1 Two-Layer Architecture

Agent-Event-Loop v3.0 uses a cleanly separated two-layer architecture:

```text
┌───────────────────────────────────────────────────────────────────┐
│                       APPLICATION LAYER                            │
│           User Input / Output / Frontend Dashboard                 │
└───────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌───────────────────────────────────────────────────────────────────┐
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │              AgentHarness (Stateful Chassis)                  │  │
│  │                                                               │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │  │
│  │  │  StateQueue  │  │ BudgetManager│  │  HookManager     │  │  │
│  │  │  (dual queue)│  │  (4D limits) │  │  (extensible)    │  │  │
│  │  └──────┬───────┘  └──────┬───────┘  └──────────────────┘  │  │
│  │         │                 │                                  │  │
│  │  ┌──────▼─────────────────▼──────────────────────────────┐  │  │
│  │  │          Session State (messages, counters, etc.)      │  │  │
│  │  └────────────────────────────────────────────────────────┘  │  │
│  │                                                               │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │  │
│  │  │  Persistence │  │  EventBus    │  │  WebSocketBridge │  │  │
│  │  │  (checkpoint)│  │  (events)    │  │  (live stream)   │  │  │
│  │  └──────────────┘  └──────────────┘  └──────────────────┘  │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                  │                                  │
│                                  │ delegates state to              │
│                                  ▼                                  │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │             AgentLoop (Stateless Engine)                      │  │
│  │                                                               │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐  │  │
│  │  │ GATHER   │  │ THINK    │  │ ACT      │  │ OBSERVE    │  │  │
│  │  │ Executor │  │ Executor │  │ Executor  │  │ Executor   │  │  │
│  │  └──────────┘  └──────────┘  └──────────┘  └────────────┘  │  │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐  │  │
│  │  │ VERIFY   │  │ REFINE   │  │ REFLECT  │  │ TERMINATE  │  │  │
│  │  │ Executor │  │ Executor │  │ Executor  │  │ Executor   │  │  │
│  │  └──────────┘  └──────────┘  └──────────┘  └────────────┘  │  │
│  │                                                               │  │
│  │  // No fields — pure transition functions only               │  │
│  └─────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────┘
```

**Data flow:**

1. User input → `AgentHarness.run()` converts to initial `GATHER` state and enqueues it.
2. The harness main loop dequeues states, calls `hooks.beforeState()`, then delegates to `AgentLoop.transition()`.
3. `AgentLoop` executes the pure state machine: calls LLM, runs tool handlers, emits events, returns `LoopOutput`.
4. `AgentHarness` applies the `LoopOutput` to its session state (updates messages, queue, budget, output).
5. At key milestones the harness saves a checkpoint and broadcasts state changes via WebSocket.
6. When budget is exhausted or termination conditions are met, the harness injects `TERMINATE` and ends.

### 2.2 Comparison to Mainstream Architectures

| Aspect | **Agent-Event-Loop v3.0** | Claude Code | OpenCode | OpenHarness |
|--------|--------------------------|-------------|----------|-------------|
| **Loop** | Stateless pure engine | Stateless "brain" harness | Think-act-observe cycle | Ephemeral engine |
| **Harness** | Stateful chassis | External session log | Session/state manager | Persistent chassis |
| **State** | Harness-owned (messages, queue, budget) | External durable session log | Local JSONL files | Step-level execution |
| **Recovery** | Snapshots → Checkpoints | `getSession(id)` resume | Agent re-spawn | Retryable steps |

---

## 3. Core Component Design

### 3.1 AgentLoop — Stateless State Machine Engine

`AgentLoop` is a pure state machine with **no mutable fields**. It is a self-contained module
that receives `LoopInput` (a snapshot of current context) and returns `LoopOutput`.

```typescript
class AgentLoop {
  // ⚡ No fields! The class holds zero mutable state.
  
  async transition(input: LoopInput): Promise<LoopOutput> {
    // Route to the appropriate executor based on state.type
  }
}

interface LoopInput {
  state: AgentState;                        // Current state to process
  messages: readonly Message[];             // Read-only message history
  tools: Record<string, ToolMetadata>;      // Tool registry
  llm: LLMProvider;                         // LLM (hooks already wrapped by harness)
  refineAttempts: Record<string, number>;    // Retry counters
  currentOutput: string | null;              // Current accumulated output
  emit: (type: string, payload?: unknown) => void;  // Event emitter callback
}

interface LoopOutput {
  nextStates: Array<{ state: AgentState; priority?: Priority }>;
  messages: Message[];
  output: string | null;
  tokenText: string;           // LLM-generated text for harness token estimation
  terminate: boolean;
  terminateReason?: string;
}
```

**Key properties:**

- **Pure**: No mutable fields, no hidden state, no infrastructure dependencies.
- **Composable**: Works with any harness; can be unit-tested in isolation.
- **Observable**: Emits events via callback (LLMRequest, LLMChunk, ToolExecStart, etc.).
- **Functions as Executor Map**: Each state type (`GATHER`, `THINK`, ..., `TERMINATE`)
  has a corresponding pure handler that returns `LoopOutput`.

### 3.2 AgentHarness — Stateful Runtime Chassis

`AgentHarness` is the central runtime class. It owns all mutable state and infrastructure,
and delegates state transitions to the stateless `AgentLoop`.

```typescript
class AgentHarness {
  readonly sessionId: string;
  
  // State (mutable, owned by harness):
  private queue: StateQueue;
  private budget: BudgetManager;
  private messages: Message[];
  private refineAttempts: Map<string, number>;
  private output: { value: string | null };
  private turnCounter: number;
  // ... etc.
  
  // Infrastructure (owned by harness):
  private loop: AgentLoop;           // Stateless engine 🔄
  private events: EventBus;
  private hooks: HookManager;
  private persistence?: IPersistence;
  private bridge?: WebSocketBridge;
}
```

**Responsibilities:**

- **Session Management**: messages[], queue, budget, counters, output
- **Lifecycle**: `run()`, `interrupt()`, `injectMessage()`, `dispose()`
- **Hook Orchestration**: Calls `hooks.beforeState()` before delegating to AgentLoop
- **Persistence**: Checkpoints (SQLite) and snapshots (filesystem)
- **Observability**: EventBus → WebSocket bridge
- **Main Loop**: The `run()` method implements the dual-queue scheduling loop

**Main loop pseudocode:**

```text
function run(initialPrompt):
    attempt_restore()                      // Try snapshot → checkpoint
    if not restored:
        enqueue(GATHER(initialPrompt))
    
    while true:
        // Check budget; force terminate if exhausted
        if budget.exhausted and not has_terminate:
            clear_queue()
            enqueue(TERMINATE(urgent))

        // Handle graceful interrupt
        if interruptFlag == 'graceful':
            inject steering message
            enqueue(THINK)

        // Process all urgent states
        while has_urgent():
            state = dequeue_urgent()
            await execute(state, urgent=true)
            if terminated: return finish()

        // Dequeue a normal state
        state = dequeue_normal()
        if state is null:                 // Empty queue
            if output exists: enqueue(TERMINATE)
            else if idle > 3: enqueue(TERMINATE(stall))
            else: enqueue(THINK(idle))
            continue

        await execute(state, urgent=false)
        yield_control()

        if terminated or (queue_empty and output):
            return finish()

function execute(state, urgent):
    emit(StateStart)
    budget.bumpIteration()
    
    // 1. Hook: pre-process state
    checked = hooks.beforeState(state)
    if checked == 'abort': return
    
    // 2. Delegate to stateless AgentLoop
    result = await loop.transition({
        state: checked,
        messages: this.messages,
        tools: this.tools,
        llm: hook_wrapped_llm(),
        refineAttempts: fromMap(this.refineAttempts),
        currentOutput: this.output.value,
        emit: (type, p) => this.events.emit(type, p),
    })
    
    // 3. Apply results to harness state
    this.messages = result.messages
    this.output.value = result.output
    this.budget.addTokens(result.tokenText)
    for ns in result.nextStates:
        this.queue.enqueue(ns.state, ns.priority == 'urgent')
    
    // 4. Check termination
    if result.terminate:
        this.terminated = true
        this.terminateReason = result.terminateReason
    
    // 5. Hook: post-process
    await hooks.afterState(checked)
    emit(StateEnd)
    
    // 6. Checkpoint
    save_checkpoint_if_needed()
```

### 3.3 State Queue (Dual Queue)

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

### 3.4 Budget Management

Prevents infinite loops and resource exhaustion via four dimensions:

| Budget Item        | Default       | Description |
|--------------------|---------------|-------------|
| `maxTurns`         | 20            | Maximum number of turns |
| `maxTotalTokens`   | 10000         | Maximum total token consumption |
| `maxIterations`    | 50            | Maximum iterations (all state executions) |
| `maxExecutionTime` | 300000 (5min) | Maximum wall-clock time (ms) |

When any budget limit is hit, the main loop forcibly injects a `TERMINATE` state to ensure a graceful exit.

### 3.5 State Executors

Each state type has a corresponding handler function within `AgentLoop`:

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

### 3.6 Hook System

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

1. On process start, `AgentHarness` tries to load the latest snapshot (`loadLatestSnapshot`).
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
- AgentLoop pure transition outputs

### 10.2 Integration Tests

- Mock LLM and tools; verify full agent flow
- Checkpoint recovery state consistency
- WebSocket connection and message exchange
- Harness + Loop integration

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
| 3.0.0   | 2026-07-11 | Harness + Loop separation: AgentLoop (stateless engine) and AgentHarness (stateful chassis); executors return pure results; all mutable state moved to harness |
