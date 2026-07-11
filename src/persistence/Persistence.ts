import { Database } from 'bun:sqlite';
import { Glob } from 'bun';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentState } from '../types/states.ts';
import type { Message } from '../types/config.ts';

/**
 * 检查点 / 快照持久化（设计文档第 5 章）。
 * - 检查点：Bun 内置 SQLite（WAL 模式），每 N 轮或关键状态写入。
 * - 快照：文件系统（Bun.write），灾难恢复用，每次检查点同步写入。
 */
export interface CheckpointData {
  id: string;
  sessionId: string;
  turnCount: number;
  queueNormal: AgentState[];
  queueUrgent: AgentState[];
  messages: Message[];
  budget: { turns: number; iterations: number; tokens: number; elapsedMs: number };
  refineAttempts: Record<string, number>;
  finalOutput: string | null;
  createdAt: number;
}

export interface SnapshotData extends CheckpointData {}

export interface IPersistence {
  saveCheckpoint(data: CheckpointData): Promise<string>;
  loadLatestCheckpoint(sessionId: string): Promise<CheckpointData | null>;
  saveSnapshot(data: SnapshotData): Promise<string>;
  loadLatestSnapshot(sessionId: string): Promise<SnapshotData | null>;
  cleanup(sessionId: string, keep: number): Promise<void>;
}

export class SqlitePersistence implements IPersistence {
  private db: Database;
  private snapshotDir: string;

  constructor(dbPath: string, snapshotDir: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    mkdirSync(snapshotDir, { recursive: true });
    this.snapshotDir = snapshotDir;
    this.db = new Database(dbPath, { create: true });
    this.db.run('PRAGMA journal_mode = WAL;');
    this.db.run(`CREATE TABLE IF NOT EXISTS checkpoints (
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
    );`);
    this.db.run('CREATE INDEX IF NOT EXISTS idx_cp_session ON checkpoints(session_id, created_at);');
  }

  async saveCheckpoint(data: CheckpointData): Promise<string> {
    this.db.run(
      `INSERT OR REPLACE INTO checkpoints
       (id, session_id, turn_count, queue_normal, queue_urgent, messages, budget_snapshot, refine_attempts, final_output, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.id,
        data.sessionId,
        data.turnCount,
        JSON.stringify(data.queueNormal),
        JSON.stringify(data.queueUrgent),
        JSON.stringify(data.messages),
        JSON.stringify(data.budget),
        JSON.stringify(data.refineAttempts),
        data.finalOutput,
        data.createdAt,
      ]
    );
    // 同步写快照
    await this.saveSnapshot(data);
    return data.id;
  }

  async loadLatestCheckpoint(sessionId: string): Promise<CheckpointData | null> {
    const row = this.db
      .query('SELECT * FROM checkpoints WHERE session_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(sessionId) as any;
    if (!row) return null;
    return {
      id: row.id,
      sessionId: row.session_id,
      turnCount: row.turn_count,
      queueNormal: JSON.parse(row.queue_normal),
      queueUrgent: JSON.parse(row.queue_urgent),
      messages: JSON.parse(row.messages),
      budget: JSON.parse(row.budget_snapshot),
      refineAttempts: JSON.parse(row.refine_attempts),
      finalOutput: row.final_output,
      createdAt: row.created_at,
    };
  }

  async saveSnapshot(data: SnapshotData): Promise<string> {
    const ts = data.createdAt;
    const file = `${this.snapshotDir}/snapshot_${data.sessionId}_${ts}.json`;
    await Bun.write(file, JSON.stringify(data, null, 2));
    return file;
  }

  async loadLatestSnapshot(sessionId: string): Promise<SnapshotData | null> {
    const files = Array.from(
      new Glob('snapshot_*.json').scanSync({ cwd: this.snapshotDir, absolute: true })
    ).filter((p) => p.includes(sessionId));
    if (!files.length) return null;
    files.sort();
    const latest = files[files.length - 1];
    const text = await Bun.file(latest).text();
    return JSON.parse(text) as SnapshotData;
  }

  async cleanup(sessionId: string, keep: number): Promise<void> {
    // 1. 清理快照文件
    const files = Array.from(
      new Glob('snapshot_*.json').scanSync({ cwd: this.snapshotDir, absolute: true })
    ).filter((p) => p.includes(sessionId));
    files.sort();
    for (const f of files.slice(0, Math.max(0, files.length - keep))) {
      await Bun.file(f).delete();
    }
    // 2. 清理旧的 SQLite 检查点行（保留最近 keep 条）
    this.db.run(
      `DELETE FROM checkpoints WHERE session_id = ? AND id NOT IN (
        SELECT id FROM checkpoints WHERE session_id = ? ORDER BY created_at DESC LIMIT ?
      )`,
      [sessionId, sessionId, keep]
    );
  }
}

export function defaultCheckpointConfig() {
  return {
    enabled: true,
    dbPath: './data/checkpoints.sqlite',
    interval: 5,
    snapshotDir: './data/snapshots',
  };
}
