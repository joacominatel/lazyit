import { ARGON2ID_PARAMS } from '@lazyit/shared';
import { LocalCredentialService } from './local-credential.service';
import {
  resetAdminPassword,
  type LiveAdminCandidate,
  type ResetAdminPasswordClient,
} from './reset-admin-password';

/** A fake `PrismaClient.user` delegate recording every `update` call, for asserting the write. */
function fakeClient(user: LiveAdminCandidate | null): {
  client: ResetAdminPasswordClient;
  updates: Array<{
    where: { id: string };
    data: {
      passwordHash: string;
      passwordUpdatedAt: Date;
      sessionEpoch: { increment: number };
    };
  }>;
} {
  const updates: Array<{
    where: { id: string };
    data: {
      passwordHash: string;
      passwordUpdatedAt: Date;
      sessionEpoch: { increment: number };
    };
  }> = [];
  const client: ResetAdminPasswordClient = {
    user: {
      findFirst: () => Promise.resolve(user),
      update: (args) => {
        updates.push(args);
        return Promise.resolve(undefined);
      },
    },
  };
  return { client, updates };
}

describe('resetAdminPassword (F1d recovery-CLI core, #994)', () => {
  // The REAL LocalCredentialService — no stub — so the test proves the CLI's output hash is
  // interchangeable with an app-set one (same argon2id params, verifies via the same service).
  const credentials = new LocalCredentialService();

  it('refuses a non-ADMIN user', async () => {
    const { client, updates } = fakeClient({
      id: 'u-member',
      email: 'member@x.test',
      role: 'MEMBER',
    });

    await expect(
      resetAdminPassword(client, credentials, 'member@x.test', 'N3wPassw0rd!'),
    ).rejects.toThrow(/not an ADMIN/);
    expect(updates).toHaveLength(0);
  });

  it('refuses when no live user matches the identifier', async () => {
    const { client, updates } = fakeClient(null);

    await expect(
      resetAdminPassword(client, credentials, 'ghost@x.test', 'N3wPassw0rd!'),
    ).rejects.toThrow(/no LIVE user found/);
    expect(updates).toHaveLength(0);
  });

  it('refuses an empty identifier', async () => {
    const { client } = fakeClient({
      id: 'u-admin',
      email: 'admin@x.test',
      role: 'ADMIN',
    });

    await expect(
      resetAdminPassword(client, credentials, '   ', 'N3wPassw0rd!'),
    ).rejects.toThrow(/email or username is required/);
  });

  it('refuses an empty password and never touches the DB', async () => {
    const { client, updates } = fakeClient({
      id: 'u-admin',
      email: 'admin@x.test',
      role: 'ADMIN',
    });

    await expect(
      resetAdminPassword(client, credentials, 'admin@x.test', ''),
    ).rejects.toThrow(/must not be empty/);
    expect(updates).toHaveLength(0);
  });

  it('hashes with the app argon2id params and bumps sessionEpoch for a live ADMIN', async () => {
    const { client, updates } = fakeClient({
      id: 'u-admin',
      email: 'admin@x.test',
      role: 'ADMIN',
    });

    const result = await resetAdminPassword(
      client,
      credentials,
      'Admin@X.test', // mixed-case identifier — must normalize to match
      'N3wPassw0rd!',
    );

    expect(result).toEqual({ id: 'u-admin', email: 'admin@x.test' });
    expect(updates).toHaveLength(1);

    const [{ where, data }] = updates;
    expect(where).toEqual({ id: 'u-admin' });
    expect(data.sessionEpoch).toEqual({ increment: 1 });
    expect(data.passwordUpdatedAt).toBeInstanceOf(Date);

    // The stored hash carries the SAME argon2id cost params the app targets (encoded PHC string) —
    // interchangeable with a hash the app itself would produce.
    expect(data.passwordHash.startsWith('$argon2id$')).toBe(true);
    const encoded = /\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(data.passwordHash);
    expect(encoded).not.toBeNull();
    expect(Number(encoded![1])).toBe(ARGON2ID_PARAMS.memoryCost);
    expect(Number(encoded![2])).toBe(ARGON2ID_PARAMS.timeCost);
    expect(Number(encoded![3])).toBe(ARGON2ID_PARAMS.parallelism);

    // And it actually verifies via the app's own verify path (not a stubbed hash).
    const verified = await credentials.verify(
      data.passwordHash,
      'N3wPassw0rd!',
    );
    expect(verified.valid).toBe(true);
  });
});
