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

import { assetsToolset } from '../tools/assets.tools';
import type { PrismaService } from '../../prisma/prisma.service';
import { mutationWeightOf, mutationsUsed } from './mutation-weight';
import type { RegisteredAiTool } from './tool-descriptor';

/** SEC-081: the per-SA mutation cap counts changes — a batch its rows — through the descriptor hook. */

const registered = (name: string): RegisteredAiTool =>
  ({
    descriptor: assetsToolset.tools.find((tool) => tool.name === name)!,
  }) as RegisteredAiTool;

const CREATE_BATCH = registered('asset_create_batch');
const UPDATE_BATCH = registered('asset_update_batch');
const UPDATE = registered('asset_update');

describe('mutationWeightOf', () => {
  it('weighs the real batch tools by the rows they would write (skipped rows excluded)', () => {
    expect(
      mutationWeightOf(UPDATE_BATCH, {
        rows: [
          { asset: 'LAP-1', status: 'IN_STORAGE' },
          { asset: 'LAP-2', status: 'IN_STORAGE' },
          { asset: 'LAP-3', status: 'IN_STORAGE', skip: true },
        ],
      }),
    ).toBe(2);
    expect(
      mutationWeightOf(CREATE_BATCH, {
        rows: [
          { name: 'A', model: 'M', location: 'L' },
          { name: 'B', model: 'M', location: 'L' },
          { name: 'C', model: 'M', location: 'L' },
        ],
      }),
    ).toBe(3);
  });

  it('is 1 for a single-record tool, an unknown tool, and an input the tool refuses', () => {
    expect(mutationWeightOf(UPDATE, { asset: 'LAP-1', status: 'IN_USE' })).toBe(
      1,
    );
    expect(mutationWeightOf(undefined, { rows: [1, 2, 3] })).toBe(1);
    expect(mutationWeightOf(UPDATE_BATCH, { rows: 'not rows' })).toBe(1);
  });
});

describe('mutationsUsed', () => {
  it('counts plain writes as one each and batches by their stored rows', async () => {
    const count = jest
      .fn()
      .mockResolvedValueOnce(3) // every write in scope
      .mockResolvedValueOnce(1); // of which batches
    const findMany = jest.fn().mockResolvedValue([
      {
        toolName: 'asset_update_batch',
        input: {
          rows: [
            { asset: 'LAP-1', status: 'IN_STORAGE' },
            { asset: 'LAP-2', status: 'IN_STORAGE' },
            { asset: 'LAP-3', status: 'IN_STORAGE' },
          ],
        },
      },
    ]);
    const prisma = {
      aiToolInvocation: { count, findMany },
    } as unknown as PrismaService;
    const where = { runId: 'r1' };
    await expect(
      mutationsUsed(prisma, [UPDATE, UPDATE_BATCH], where, 10),
    ).resolves.toBe(2 + 3);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          runId: 'r1',
          toolName: { in: ['asset_update_batch'] },
        },
        take: 10,
      }),
    );
  });

  it('is the plain count when no weighted tool exists', async () => {
    const count = jest.fn().mockResolvedValue(4);
    const prisma = {
      aiToolInvocation: { count, findMany: jest.fn() },
    } as unknown as PrismaService;
    await expect(mutationsUsed(prisma, [UPDATE], {}, 10)).resolves.toBe(4);
  });
});
