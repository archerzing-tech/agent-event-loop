import { describe, it, expect } from 'bun:test';
import { EventBus, Events } from './EventBus.ts';

describe('EventBus', () => {
  it('emits event to registered type listener', () => {
    const bus = new EventBus();
    const received: unknown[] = [];

    bus.on('test-event', (e) => received.push(e.payload));
    bus.emit('test-event', { key: 'value' });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ key: 'value' });
  });

  it('event object has correct shape', () => {
    const bus = new EventBus();
    const received: unknown[] = [];

    bus.on('shape-test', (e) => received.push(e));
    bus.emit('shape-test', 'hello');

    expect(received[0]).toMatchObject({
      type: 'shape-test',
      payload: 'hello',
    });
    expect((received[0] as any).timestamp).toBeGreaterThan(0);
  });

  it('does not invoke listener for a different event type', () => {
    const bus = new EventBus();
    const received: unknown[] = [];

    bus.on('type-a', (e) => received.push(e.payload));
    bus.emit('type-b', 'should-not-be-seen');

    expect(received).toHaveLength(0);
  });

  it('supports multiple handlers for the same event', () => {
    const bus = new EventBus();
    const results: number[] = [];

    bus.on('multi', () => results.push(1));
    bus.on('multi', () => results.push(2));
    bus.emit('multi');

    expect(results).toEqual([1, 2]);
  });

  it('supports multiple handlers for different events', () => {
    const bus = new EventBus();
    const results: string[] = [];

    bus.on('alpha', () => results.push('a'));
    bus.on('beta', () => results.push('b'));
    bus.emit('alpha');
    bus.emit('beta');

    expect(results).toEqual(['a', 'b']);
  });

  it('onAny catches all events regardless of type', () => {
    const bus = new EventBus();
    const types: string[] = [];

    bus.onAny((e) => types.push(e.type));
    bus.emit('event-1');
    bus.emit('event-2');

    expect(types).toEqual(['event-1', 'event-2']);
  });

  it('onAny receives events alongside specific listeners', () => {
    const bus = new EventBus();
    const anyLog: string[] = [];
    const specificLog: string[] = [];

    bus.on('foo', () => specificLog.push('foo-specific'));
    bus.onAny((e) => anyLog.push(e.type));

    bus.emit('foo');
    bus.emit('bar');

    expect(specificLog).toEqual(['foo-specific']);
    expect(anyLog).toEqual(['foo', 'bar']);
  });

  it('emitting without payload works', () => {
    const bus = new EventBus();
    let called = false;

    bus.on('no-payload', () => { called = true; });
    bus.emit('no-payload');

    expect(called).toBe(true);
  });

  it('does not throw when emitting with no listeners', () => {
    const bus = new EventBus();
    expect(() => bus.emit('orphan-event', {})).not.toThrow();
  });

  it('does not throw when emitting with no onAny listeners', () => {
    const bus = new EventBus();
    expect(() => bus.emit('any-orphan')).not.toThrow();
  });

  it('same handler can be registered only once per type', () => {
    const bus = new EventBus();
    const calls: number[] = [];

    const handler = (e: any) => calls.push(e.payload);
    bus.on('dedup', handler);
    bus.on('dedup', handler); // duplicate registration (Set dedup)
    bus.emit('dedup', 42);

    expect(calls).toHaveLength(1);
  });
});

describe('Events constants', () => {
  it('defines all expected event type constants', () => {
    const expected = [
      'LoopStart', 'LoopEnd', 'TurnStart', 'TurnEnd',
      'LLMRequest', 'LLMChunk', 'ToolExecStart', 'ToolExecEnd',
      'StateStart', 'StateEnd', 'ReflectionResult', 'Terminate',
      'ExternalInterrupt',
    ];
    for (const key of expected) {
      expect((Events as Record<string, string>)[key]).toBe(key);
    }
  });

  it('all constants are frozen', () => {
    expect(Object.isFrozen(Events)).toBe(true);
  });
});

describe('EventBus — integration with Events constants', () => {
  it('works with Events constants as types', () => {
    const bus = new EventBus();
    const log: string[] = [];

    bus.on(Events.StateStart, (e) => log.push(`start:${(e.payload as any).type}`));
    bus.on(Events.StateEnd, (e) => log.push(`end:${(e.payload as any).type}`));

    bus.emit(Events.StateStart, { type: 'THINK' });
    bus.emit(Events.StateEnd, { type: 'THINK' });

    expect(log).toEqual(['start:THINK', 'end:THINK']);
  });
});
