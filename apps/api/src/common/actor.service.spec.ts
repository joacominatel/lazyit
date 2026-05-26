import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { ActorService } from './actor.service';
import { PrismaService } from '../prisma/prisma.service';

// Mock the generated Prisma client so the test never loads the real one (no DB).
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

// A well-formed UUID for the live-user cases.
const VALID_ID = '11111111-1111-1111-1111-111111111111';

describe('ActorService', () => {
  let service: ActorService;
  let user: { findFirst: jest.Mock };

  beforeEach(async () => {
    user = { findFirst: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [ActorService, { provide: PrismaService, useValue: { user } }],
    }).compile();

    service = moduleRef.get(ActorService);
  });

  // --- absent actor (system / unknown) ------------------------------------
  it('resolves undefined to undefined (system actor) without touching the DB', async () => {
    await expect(service.resolve(undefined)).resolves.toBeUndefined();
    expect(user.findFirst).not.toHaveBeenCalled();
  });

  it('resolves an empty string to undefined (system actor) without touching the DB', async () => {
    await expect(service.resolve('')).resolves.toBeUndefined();
    expect(user.findFirst).not.toHaveBeenCalled();
  });

  // --- malformed id -------------------------------------------------------
  it('rejects a malformed id with 400 (never hits the DB)', async () => {
    await expect(service.resolve('not-a-uuid')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(user.findFirst).not.toHaveBeenCalled();
  });

  // --- well-formed but not a live user ------------------------------------
  it('rejects a well-formed id that does not reference a live user with 400', async () => {
    // findFirst returns null for a nonexistent or soft-deleted user (the extension adds
    // deletedAt:null), so both collapse to the same 400.
    user.findFirst.mockResolvedValue(null);

    await expect(service.resolve(VALID_ID)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  // --- valid live user ----------------------------------------------------
  it('returns the id for a valid live user, querying by id only (soft-delete added by the extension)', async () => {
    user.findFirst.mockResolvedValue({ id: VALID_ID });

    await expect(service.resolve(VALID_ID)).resolves.toBe(VALID_ID);
    expect(user.findFirst).toHaveBeenCalledWith({
      where: { id: VALID_ID },
      select: { id: true },
    });
    // The service must not hand-roll a deletedAt filter — that is the soft-delete extension's job.
    const calls = user.findFirst.mock.calls as Array<
      [{ where: Record<string, unknown> }]
    >;
    expect(calls[0][0].where).not.toHaveProperty('deletedAt');
  });
});
