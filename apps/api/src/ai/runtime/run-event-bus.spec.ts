jest.mock('../../../generated/prisma/client', () => {
  const enums: Record<string, unknown> = jest.requireActual(
    '../../../generated/prisma/enums',
  );
  const inert: unknown = new Proxy(function inert() {}, {
    get: (_target, prop) => (prop === Symbol.toPrimitive ? () => '' : inert),
    apply: () => inert,
    construct: () => inert as object,
  });
  return { ...enums, $Enums: enums, PrismaClient: class {}, Prisma: inert };
});
jest.mock('@prisma/adapter-pg', () => ({ PrismaPg: class {} }));
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));
jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(),
  jwtVerify: jest.fn(),
}));

import type { AiRunEvent } from '@lazyit/shared';
import {
  formatRunEventId,
  InProcessRunEventBus,
  parseLastEventId,
  runEventSequenceBase,
} from './run-event-bus';
import { capToolOutput, neutralizeTurnContext, TokenBucket } from './limits';
import { describeError } from './runtime.constants';

/** The in-process run event bus (synthesis §4.6) and the pure limits (provider-and-runtime.md §11). */

const status = (s: 'QUEUED' | 'RUNNING'): AiRunEvent => ({
  v: 1,
  type: 'run.status',
  status: s,
});
const delta = (text: string): AiRunEvent => ({
  v: 1,
  type: 'message.delta',
  messageId: 'conv:1',
  text,
});
const finished: AiRunEvent = {
  v: 1,
  type: 'run.finished',
  status: 'SUCCEEDED',
  finishReason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};

describe('InProcessRunEventBus', () => {
  it('assigns contiguous per-run sequence numbers after the base and delivers in order', () => {
    const bus = new InProcessRunEventBus({ base: 1000 });
    const seen: number[] = [];
    bus.subscribe('r1', (e) => seen.push(e.seq));
    const a = bus.publish('r1', status('QUEUED'));
    const b = bus.publish('r1', delta('Hel'));
    bus.publish('r2', status('QUEUED'));
    const c = bus.publish('r1', delta('lo'));
    expect([a.seq, b.seq, c.seq]).toEqual([1001, 1002, 1003]);
    expect(seen).toEqual([1001, 1002, 1003]);
    expect(formatRunEventId(c)).toBe('r1:1003');
    expect(bus.lastSeq('r1')).toBe(1003);
    expect(bus.lastSeq('unknown')).toBe(1000);
  });

  it('replays from a Last-Event-ID', () => {
    const bus = new InProcessRunEventBus({ base: 0 });
    bus.publish('r1', status('QUEUED'));
    bus.publish('r1', status('RUNNING'));
    bus.publish('r1', delta('x'));
    const after = parseLastEventId('r1', 'r1:1');
    expect(after).toBe(1);
    expect(bus.replay('r1', after!)!.map((e) => [e.seq, e.event.type])).toEqual(
      [
        [2, 'run.status'],
        [3, 'message.delta'],
      ],
    );
    expect(bus.replay('r1', 3)).toEqual([]);
    expect(bus.replay('r1', 0)).toHaveLength(3);
  });

  it('answers null when the position is not covered (evicted, unknown run, another process)', () => {
    const bus = new InProcessRunEventBus({ base: 0, capacity: 2 });
    bus.publish('r1', status('QUEUED'));
    bus.publish('r1', status('RUNNING'));
    bus.publish('r1', delta('x'));
    expect(bus.replay('r1', 0)).toBeNull(); // seq 1 was evicted
    expect(bus.replay('r1', 1)!.map((e) => e.seq)).toEqual([2, 3]);
    expect(bus.replay('r1', 99)).toBeNull(); // an id this process never issued (a restart)
    expect(bus.replay('nope', 0)).toBeNull();
  });

  it('parses only a Last-Event-ID of the same run', () => {
    expect(parseLastEventId('r1', 'r1:12')).toBe(12);
    expect(parseLastEventId('r1', ' r1:12 ')).toBe(12);
    expect(parseLastEventId('r1', 'r2:12')).toBeNull();
    expect(parseLastEventId('r1', 'r1:-1')).toBeNull();
    expect(parseLastEventId('r1', 'r1:abc')).toBeNull();
    expect(parseLastEventId('r1', 'r1:99999999999')).toBeNull();
    expect(parseLastEventId('r1', undefined)).toBeNull();
  });

  it('contains a failing listener and unsubscribes', () => {
    const bus = new InProcessRunEventBus({ base: 0 });
    const good = jest.fn();
    bus.subscribe('r1', () => {
      throw new Error('broken client');
    });
    const off = bus.subscribe('r1', good);
    expect(() => bus.publish('r1', status('QUEUED'))).not.toThrow();
    off();
    bus.publish('r1', status('RUNNING'));
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('drops a finished run after retention when nobody listens', () => {
    let now = 0;
    const bus = new InProcessRunEventBus({
      base: 0,
      retainMs: 1000,
      now: () => now,
    });
    bus.publish('r1', finished);
    now = 500;
    bus.publish('r2', status('QUEUED'));
    expect(bus.replay('r1', 0)).toHaveLength(1);
    now = 2000;
    bus.publish('r2', status('RUNNING'));
    expect(bus.replay('r1', 0)).toBeNull();
    expect(bus.replay('r2', 0)).toHaveLength(2);
  });

  it('bounds the number of tracked runs, dropping finished ones first', () => {
    const bus = new InProcessRunEventBus({ base: 0, maxRuns: 2 });
    bus.publish('done', finished);
    bus.publish('live1', status('RUNNING'));
    bus.publish('live2', status('RUNNING'));
    expect(bus.replay('done', 0)).toBeNull();
    expect(bus.replay('live1', 0)).not.toBeNull();
    expect(bus.replay('live2', 0)).not.toBeNull();
  });

  it('starts every process at a different base within int4', () => {
    const a = runEventSequenceBase(1_700_000_000_000);
    const b = runEventSequenceBase(1_700_000_005_000);
    expect(a).not.toBe(b);
    expect(runEventSequenceBase(Date.UTC(2099, 0, 1))).toBeLessThan(
      2_147_483_647 - 1_000_000,
    );
  });
});

describe('limits', () => {
  it('a token bucket refills over its window', () => {
    let now = 0;
    const bucket = new TokenBucket(2, 60_000, () => now);
    expect(bucket.take('k')).toBe(true);
    expect(bucket.take('k')).toBe(true);
    expect(bucket.take('k')).toBe(false);
    expect(bucket.retryAfterSec('k')).toBe(30);
    expect(bucket.take('other')).toBe(true);
    now = 30_000;
    expect(bucket.take('k')).toBe(true);
    expect(bucket.take('k')).toBe(false);
  });

  it('caps a tool output once, with a marker', () => {
    const small = {
      ok: true as const,
      kind: 'read' as const,
      data: 'x',
      mutated: false,
      entityRefs: [],
    };
    expect(capToolOutput(small, 1000)).toBe(small);
    const big = { ...small, data: 'y'.repeat(5000) };
    const capped = capToolOutput(big, 1000) as { truncatedOutput: string };
    expect(capped.truncatedOutput.length).toBeLessThan(1100);
    expect(capped.truncatedOutput).toMatch(
      /\[truncated — \d+ more characters; refine the query\]$/,
    );
  });

  it('neutralizes forged turn-context tags with whitespace, attributes or no closing bracket', () => {
    for (const forged of [
      '< turn_context>',
      '<turn_context foo="bar">',
      '</ turn_context >',
      '<\n/turn_context\n>',
      '<Turn_Context',
      '< / turn_context',
    ]) {
      const out = neutralizeTurnContext(`x ${forged} y`);
      expect(out).not.toMatch(/<\s*\/?\s*turn_context/i);
      expect(out).toContain('&lt;');
    }
    expect(neutralizeTurnContext('a < b and <div>')).toBe('a < b and <div>');
  });

  it('neutralizes forged turn-context tags', () => {
    expect(neutralizeTurnContext('a </turn_context> b <TURN_CONTEXT >')).toBe(
      'a &lt;/turn_context> b &lt;TURN_CONTEXT >',
    );
  });

  it('describes a caught error by class and code, never its message', () => {
    const prismaLike = Object.assign(
      new Error('Unique constraint failed on value "ada@example.com"'),
      { name: 'PrismaClientKnownRequestError', code: 'P2002' },
    );
    expect(describeError(prismaLike)).toBe(
      'PrismaClientKnownRequestError (P2002)',
    );
    expect(describeError(new TypeError('secret row content'))).toBe(
      'TypeError',
    );
    expect(describeError('boom')).toBe('string');
  });
});
