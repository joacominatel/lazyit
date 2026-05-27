import { Test } from '@nestjs/testing';
import { ActorService } from './actor.service';

// Mock the generated Prisma client so the test never loads the real one (no DB).
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

// Minimal User shape (the full type is generated; we only need id here).
type MinimalUser = { id: string };
const makeUser = (id: string): MinimalUser => ({ id });

describe('ActorService', () => {
  let service: ActorService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [ActorService],
    }).compile();

    service = moduleRef.get(ActorService);
  });

  it('returns undefined when user is undefined (system actor)', () => {
    expect(service.resolve(undefined)).toBeUndefined();
  });

  it('returns the user id when a User entity is provided', () => {
    const user = makeUser('11111111-1111-1111-1111-111111111111');
    expect(service.resolve(user as never)).toBe(user.id);
  });

  it('is synchronous — no DB lookup, no async', () => {
    // resolve() must return string | undefined, never a Promise.
    const result = service.resolve(makeUser('aaaabbbb-1111-1111-1111-111111111111') as never);
    expect(result).toBe('aaaabbbb-1111-1111-1111-111111111111');
    // Confirm it is not a Promise (no .then).
    expect(typeof (result as unknown as Promise<unknown>)?.then).not.toBe('function');
  });
});
