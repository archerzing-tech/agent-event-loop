import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqlitePersistence, type CheckpointData } from './Persistence.ts';
import { makeState } from '../types/states.ts';

describe('SqlitePersistence — intermediate state recovery', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'persist-test-'));
  const dbPath = join(tmpDir, 'test.sqlite');
  const snapDir = join(tmpDir, 'snaps');
  const sessionId = 'test-session';

  let persistence: SqlitePersistence;

  beforeAll(() => {
    persistence = new SqlitePersistence(dbPath, snapDir);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('saves and loads an intermediate checkpoint (mid-execution with ACT in queue)', async () => {
    const checkpoint: CheckpointData = {
      id: 'cp-1',
      sessionId,
      turnCount: 3,
      queueNormal: [
        makeState('OBSERVE', { results: [{ ok: true }] }),
        makeState('THINK', { reason: 'continue' }),
      ],
      queueUrgent: [
        makeState('REFLECT', { error: '工具执行出错，需修正重试' }, 'urgent'),
      ],
      messages: [
        { role: 'user', content: '计算 3+4 并搜索最新新闻' },
        { role: 'assistant', content: '', toolCall: { id: 'call-1', name: 'calculator', params: { expression: '3+4' } } },
        { role: 'tool', content: '7' },
      ],
      budget: { turns: 1, iterations: 4, tokens: 15, elapsedMs: 200 },
      refineAttempts: {},
      finalOutput: null,
      createdAt: Date.now(),
    };

    const id = await persistence.saveCheckpoint(checkpoint);
    expect(id).toBe('cp-1');

    const loaded = await persistence.loadLatestCheckpoint(sessionId);
    expect(loaded).not.toBeNull();
    expect(loaded!.turnCount).toBe(3);
    expect(loaded!.queueNormal).toHaveLength(2);
    expect(loaded!.queueUrgent).toHaveLength(1);
    expect(loaded!.queueUrgent[0].type).toBe('REFLECT');
    expect(loaded!.messages).toHaveLength(3);
    expect(loaded!.finalOutput).toBeNull();
    // 验证没有 TERMINATE 状态（恢复时不应有）
    expect(loaded!.queueNormal.some((s) => s.type === 'TERMINATE')).toBe(false);
    expect(loaded!.queueUrgent.some((s) => s.type === 'TERMINATE')).toBe(false);
  });

  it('saves and loads multiple checkpoints, loads latest', async () => {
    const cp1: CheckpointData = {
      id: 'cp-old',
      sessionId,
      turnCount: 1,
      queueNormal: [makeState('THINK', { reason: 'first' })],
      queueUrgent: [],
      messages: [{ role: 'user', content: '第一轮' }],
      budget: { turns: 0, iterations: 1, tokens: 2, elapsedMs: 50 },
      refineAttempts: {},
      finalOutput: null,
      createdAt: Date.now() - 1000,
    };
    const cp2: CheckpointData = {
      id: 'cp-latest',
      sessionId,
      turnCount: 5,
      queueNormal: [makeState('VERIFY', { answer: '最终答案' })],
      queueUrgent: [],
      messages: [{ role: 'user', content: '第五轮' }],
      budget: { turns: 3, iterations: 8, tokens: 40, elapsedMs: 500 },
      refineAttempts: { verify: 2 },
      finalOutput: '最终答案',
      createdAt: Date.now(),
    };

    await persistence.saveCheckpoint(cp1);
    await persistence.saveCheckpoint(cp2);

    const loaded = await persistence.loadLatestCheckpoint(sessionId);
    expect(loaded).not.toBeNull();
    // 应加载最新的（turnCount=5）
    expect(loaded!.id).toBe('cp-latest');
    expect(loaded!.turnCount).toBe(5);
  });

  it('handles session with no checkpoints gracefully', async () => {
    const loaded = await persistence.loadLatestCheckpoint('nonexistent-session');
    expect(loaded).toBeNull();
  });

  it('saves and loads snapshot as fallback for recovery', async () => {
    const snapData: CheckpointData = {
      id: 'snap-fallback',
      sessionId: 'snap-session',
      turnCount: 2,
      queueNormal: [makeState('ACT', { toolCalls: [{ name: 'search' }] })],
      queueUrgent: [],
      messages: [{ role: 'user', content: '快照测试' }],
      budget: { turns: 1, iterations: 3, tokens: 10, elapsedMs: 150 },
      refineAttempts: {},
      finalOutput: null,
      createdAt: Date.now(),
    };

    const filePath = await persistence.saveSnapshot(snapData);
    expect(filePath).toContain('snap-session');

    const loaded = await persistence.loadLatestSnapshot('snap-session');
    expect(loaded).not.toBeNull();
    expect(loaded!.turnCount).toBe(2);
    expect(loaded!.queueNormal[0].type).toBe('ACT');
  });
});
