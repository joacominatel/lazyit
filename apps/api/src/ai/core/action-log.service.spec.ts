import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

jest.mock('../../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

import { actorOf, AiActionLogService } from './action-log.service';
import {
  isSensitiveKey,
  REDACTED,
  REDACTION_MAX_STRING,
  redactInput,
} from './redaction';

/**
 * The single writer of the permanent AI mutation ledger (INV-AI-10): it only inserts, it redacts the
 * input itself, it attributes at most one actor, and no other production code reaches the table.
 */
describe('AiActionLogService', () => {
  function service() {
    const create = jest.fn().mockResolvedValue({});
    return {
      create,
      log: new AiActionLogService({ aiActionLog: { create } } as never),
    };
  }
  const BASE = {
    invocationId: 'inv1',
    event: 'EXECUTED' as const,
    channel: 'MCP' as const,
    toolName: 'asset_update',
    toolClass: 'write' as const,
  };

  function written(create: jest.Mock): Record<string, unknown> {
    return (
      create.mock.calls as Array<[{ data: Record<string, unknown> }]>
    )[0][0].data;
  }

  it('inserts one row with the redacted input and the provenance', async () => {
    const { create, log } = service();
    await log.append({
      ...BASE,
      actor: { userId: 'u1' },
      input: { name: 'x', password: 'hunter2', nested: { clientSecret: 's' } },
      entityRefs: [{ type: 'asset', id: 'a1', op: 'updated' }],
      untrustedSources: [{ type: 'article', id: 'k1', op: 'navigate' }],
      approverUserId: 'u1',
      stepUp: true,
      provider: 'anthropic',
      model: 'm',
      requestId: 'r',
      mcpClientId: 'c',
      oauthGrantId: 'g',
    });
    expect(create).toHaveBeenCalledTimes(1);
    const data = written(create);
    expect(data).toMatchObject({
      invocationId: 'inv1',
      event: 'EXECUTED',
      channel: 'MCP',
      userId: 'u1',
      serviceAccountId: null,
      approverUserId: 'u1',
      stepUp: true,
      provider: 'anthropic',
      mcpClientId: 'c',
      oauthGrantId: 'g',
      errorCode: null,
    });
    expect(data.input).toEqual({
      name: 'x',
      password: REDACTED,
      nested: { clientSecret: REDACTED },
    });
    expect(JSON.stringify(data)).not.toContain('hunter2');
  });

  it('never records two actors (the CHECK would refuse the row)', async () => {
    const { create, log } = service();
    await log.append({
      ...BASE,
      actor: { userId: 'u1', serviceAccountId: 'sa1' },
    });
    expect(written(create)).toMatchObject({
      userId: 'u1',
      serviceAccountId: null,
    });
    expect(actorOf({ kind: 'service', serviceAccountId: 'sa1' })).toEqual({
      serviceAccountId: 'sa1',
    });
  });

  it('records the error, bounded', async () => {
    const { create, log } = service();
    await log.append({
      ...BASE,
      event: 'FAILED',
      actor: {},
      error: { code: 'CONFLICT', status: 409, message: 'x'.repeat(2000) },
    });
    const data = written(create);
    expect(data).toMatchObject({ errorCode: 'CONFLICT', errorStatus: 409 });
    expect((data.errorMessage as string).length).toBe(500);
  });
});

describe('redactInput', () => {
  it.each([
    'password',
    'newPassword',
    'api_key',
    'apiKey',
    'clientSecret',
    'accessToken',
    'refresh-token',
    'privateKey',
    'authorization',
    'otp',
    'credentials',
  ])('treats %s as sensitive', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each(['name', 'assetTag', 'serial', 'email', 'notes', 'keyboardLayout'])(
    'keeps %s',
    (key) => {
      expect(isSensitiveKey(key)).toBe(false);
    },
  );

  it('redacts at any depth, inside arrays, without mutating the input', () => {
    const input = {
      items: [{ token: 't', label: 'ok' }],
      deep: { a: { b: { secret: 's' } } },
    };
    const copy = JSON.parse(JSON.stringify(input)) as unknown;
    expect(redactInput(input)).toEqual({
      items: [{ token: REDACTED, label: 'ok' }],
      deep: { a: { b: { secret: REDACTED } } },
    });
    expect(input).toEqual(copy);
  });

  it('clips long strings and bounds the depth', () => {
    const long = 'a'.repeat(REDACTION_MAX_STRING + 10);
    expect((redactInput({ body: long }) as { body: string }).body).toHaveLength(
      REDACTION_MAX_STRING + 1,
    );
    let nested: unknown = 'leaf';
    for (let i = 0; i < 20; i++) nested = { n: nested };
    expect(JSON.stringify(redactInput(nested))).toContain(REDACTED);
  });

  it('keeps JSON scalars and drops what JSON cannot carry', () => {
    expect(
      redactInput({ n: 1, b: false, z: null, f: () => 1, inf: Infinity }),
    ).toEqual({ n: 1, b: false, z: null, inf: null });
  });
});

describe('the ledger is append-only in application code (INV-AI-10)', () => {
  const SRC = join(__dirname, '..', '..');

  function productionFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return productionFiles(path);
      return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
    });
  }

  it('no production file reaches aiActionLog other than through create, and only the writer does', () => {
    const offenders: string[] = [];
    const writers: string[] = [];
    for (const file of productionFiles(SRC)) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/aiActionLog\s*\.\s*(\w+)/g)) {
        if (match[1] === 'create') writers.push(relative(SRC, file));
        else offenders.push(`${relative(SRC, file)}: aiActionLog.${match[1]}`);
      }
      if (/ai_action_log/.test(source) && /\b(UPDATE|DELETE)\b/.test(source)) {
        offenders.push(`${relative(SRC, file)}: raw SQL on ai_action_log`);
      }
    }
    expect(offenders).toEqual([]);
    expect(writers).toEqual(['ai/core/action-log.service.ts']);
  });
});
