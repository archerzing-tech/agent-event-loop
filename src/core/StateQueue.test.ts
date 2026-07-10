import { describe, it, expect } from 'bun:test';
import { StateQueue } from './StateQueue.ts';
import { makeState } from '../types/states.ts';

describe('StateQueue', () => {
  it('urgent states are dequeued before normal ones', () => {
    const q = new StateQueue();
    q.enqueue(makeState('THINK'));
    q.enqueue(makeState('TERMINATE', {}, 'urgent'));
    q.enqueue(makeState('OBSERVE'));
    expect(q.dequeue()!.type).toBe('TERMINATE');
    expect(q.dequeue()!.type).toBe('THINK');
    expect(q.dequeue()!.type).toBe('OBSERVE');
  });

  it('force enqueues into urgent regardless of priority', () => {
    const q = new StateQueue();
    q.enqueue(makeState('THINK'), true);
    expect(q.hasUrgent()).toBe(true);
  });

  it('hasTerminateState detects TERMINATE anywhere', () => {
    const q = new StateQueue();
    q.enqueue(makeState('THINK'));
    expect(q.hasTerminateState()).toBe(false);
    q.enqueue(makeState('TERMINATE', {}, 'urgent'));
    expect(q.hasTerminateState()).toBe(true);
  });

  it('serializes and restores via JSON', () => {
    const q = new StateQueue();
    q.enqueue(makeState('THINK'));
    q.enqueue(makeState('REFLECT', {}, 'urgent'));
    const snap = q.toJSON();
    const q2 = new StateQueue();
    q2.fromJSON(snap);
    expect(q2.totalSize).toBe(2);
    expect(q2.hasUrgent()).toBe(true);
  });
});
