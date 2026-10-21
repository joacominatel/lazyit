// Writes users / service accounts / folders: DB_TEST_URL must be a throwaway, migrated Postgres (`bun run test:db`).
import { PrismaService } from '../src/prisma/prisma.service';
import { includeOmitted } from '../src/prisma/prisma-omit';

const URL = process.env.DB_TEST_URL;

const USER_ID = 'e1518eee-eeee-4eee-8eee-eeeeeeeeeeee';
const HASH = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA';

/**
 * The client-level omit (ADR-0105) against the REAL Prisma 7 client and Postgres: the unit suite mocks
 * Prisma, so this is where the runtime behaviour the opt-ins rely on is pinned — the root client, the
 * soft-delete `$extends`, interactive transactions, nested includes, write results, the per-query
 * `omit: { col: false }` and the `select` override, and that raw SQL is not covered.
 */
describe('Prisma global omit against Postgres (#1518)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    if (!URL) {
      throw new Error(
        'DB_TEST_URL is not set: this suite needs a throwaway, migrated Postgres',
      );
    }
    process.env.DATABASE_URL = URL;
    prisma = new PrismaService();
    await prisma.$executeRaw`
      INSERT INTO users (id, email, "firstName", "lastName", "passwordHash", "updatedAt")
      VALUES (${USER_ID}::uuid, 'omit-1518@test.invalid', 'O', 'Mit', ${HASH}, now())
      ON CONFLICT (id) DO UPDATE SET "passwordHash" = ${HASH}, "deletedAt" = NULL`;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('omits the column from a default read on the root (soft-delete-extended) client', async () => {
    const row = await prisma.user.findFirst({ where: { id: USER_ID } });
    expect(row).not.toBeNull();
    expect(row).not.toHaveProperty('passwordHash');
    expect(row?.email).toBe('omit-1518@test.invalid');
  });

  it('re-includes it with omit: { col: false }', async () => {
    const row = await prisma.user.findFirst({
      where: { id: USER_ID },
      omit: { passwordHash: false },
    });
    expect(row?.passwordHash).toBe(HASH);
  });

  it('re-includes it when a select names it, and a select that does not name it leaves it out', async () => {
    const named = await prisma.user.findFirst({
      where: { id: USER_ID },
      select: { passwordHash: true },
    });
    expect(named).toEqual({ passwordHash: HASH });
    const other = await prisma.user.findFirst({
      where: { id: USER_ID },
      select: { id: true },
    });
    expect(other).toEqual({ id: USER_ID });
  });

  it('omits inside an interactive transaction, and the opt-in works there too', async () => {
    const [plain, optedIn] = await prisma.$transaction(async (tx) => [
      await tx.user.findFirst({ where: { id: USER_ID } }),
      await tx.user.findFirst({
        where: { id: USER_ID },
        omit: { passwordHash: false },
      }),
    ]);
    expect(plain).not.toHaveProperty('passwordHash');
    expect(optedIn?.passwordHash).toBe(HASH);
  });

  it('omits from write results (update / upsert) unless the write opts in', async () => {
    const updated = await prisma.user.update({
      where: { id: USER_ID },
      data: { firstName: 'O' },
    });
    expect(updated).not.toHaveProperty('passwordHash');
    const upserted = await prisma.smtpSettings.upsert({
      where: { id: 'singleton' },
      create: { id: 'singleton', passwordCiphertext: 'c', passwordIv: 'i' },
      update: { passwordCiphertext: 'c', passwordIv: 'i' },
      omit: { passwordCiphertext: false },
    });
    expect(upserted.passwordCiphertext).toBe('c');
    expect(upserted).not.toHaveProperty('passwordIv');
    expect(upserted).not.toHaveProperty('passwordAuthTag');
  });

  it('includeOmitted re-includes every omitted column of the model', async () => {
    const row = await prisma.smtpSettings.findFirst({
      where: { id: 'singleton' },
      omit: includeOmitted('smtpSettings'),
    });
    expect(row?.passwordCiphertext).toBe('c');
    expect(row?.passwordIv).toBe('i');
    expect(row).toHaveProperty('passwordAuthTag', null);
  });

  it('omits from a nested include, and the include accepts its own opt-in', async () => {
    const run = Date.now().toString(36); // folder names are unique per parent; reruns must not collide
    const parent = await prisma.articleCategory.create({
      data: {
        name: `omit-1518-parent-${run}`,
        accessRules: [{ role: 'ADMIN' }],
      },
    });
    const child = await prisma.articleCategory.create({
      data: { name: `omit-1518-child-${run}`, parentId: parent.id },
    });
    expect(parent).not.toHaveProperty('accessRules');
    const plain = await prisma.articleCategory.findFirst({
      where: { id: child.id },
      include: { parent: true },
    });
    expect(plain?.parent).not.toHaveProperty('accessRules');
    const optedIn = await prisma.articleCategory.findFirst({
      where: { id: child.id },
      include: { parent: { omit: { accessRules: false } } },
    });
    expect(optedIn?.parent?.accessRules).toEqual([{ role: 'ADMIN' }]);
  });

  it('is not applied to raw SQL (callers of $queryRaw select columns explicitly)', async () => {
    const rows = await prisma.$queryRaw<{ passwordHash: string }[]>`
      SELECT "passwordHash" FROM users WHERE id = ${USER_ID}::uuid`;
    expect(rows[0]?.passwordHash).toBe(HASH);
  });
});
