import { createHmac } from 'node:crypto';
import { hash as argon2Hash } from '@node-rs/argon2';
import { ARGON2ID_PARAMS, SESSION_TOKEN_ALG } from '@lazyit/shared';
import { LocalCredentialService } from './local-credential.service';

/**
 * LocalCredentialService unit tests (ADR-0086 §3/§4) — REAL argon2 + REAL node:crypto HMAC (no mocks),
 * because the security guarantees under test ARE the crypto: PHC params, fail-closed verify, rehash
 * detection, and the HS256 alg-pin on the session token. Slow-ish (argon2 is memory-hard) but few cases.
 */

const b64url = (obj: unknown): string =>
  Buffer.from(JSON.stringify(obj)).toString('base64url');

/** Decode a JWT segment (0=header, 1=payload) into a typed record of claims for assertions. */
function decodeSeg(token: string, index: 0 | 1): Record<string, unknown> {
  return JSON.parse(
    Buffer.from(token.split('.')[index], 'base64url').toString(),
  ) as Record<string, unknown>;
}

/** Forge a compact JWS with an arbitrary header/payload signed HS256 with `secret` (for the alg-pin tests). */
function forgeToken(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  secret: string,
): string {
  const input = `${b64url(header)}.${b64url(payload)}`;
  const sig = createHmac('sha256', secret).update(input).digest('base64url');
  return `${input}.${sig}`;
}

describe('LocalCredentialService', () => {
  let service: LocalCredentialService;
  const SECRET = 'test-session-signing-secret-0123456789abcdef';

  beforeAll(() => {
    process.env.SESSION_SIGNING_SECRET = SECRET;
  });

  beforeEach(() => {
    service = new LocalCredentialService();
  });

  describe('hash / verify', () => {
    it('hashes to a PHC argon2id string with the pinned OWASP params', async () => {
      const hash = await service.hash('correct horse battery staple');
      expect(hash.startsWith('$argon2id$')).toBe(true);
      expect(hash).toContain(
        `m=${ARGON2ID_PARAMS.memoryCost},t=${ARGON2ID_PARAMS.timeCost},p=${ARGON2ID_PARAMS.parallelism}`,
      );
    });

    it('verifies the correct password and rejects a wrong one', async () => {
      const hash = await service.hash('s3cret-pw');
      await expect(service.verify(hash, 's3cret-pw')).resolves.toEqual({
        valid: true,
        needsRehash: false,
      });
      const bad = await service.verify(hash, 'not-the-pw');
      expect(bad.valid).toBe(false);
    });

    it('FAILS CLOSED on a null stored hash — never authenticates, even with an empty password', async () => {
      await expect(service.verify(null, 'anything')).resolves.toEqual({
        valid: false,
        needsRehash: false,
      });
      await expect(service.verify(null, '')).resolves.toEqual({
        valid: false,
        needsRehash: false,
      });
      await expect(service.verify(undefined, 'x')).resolves.toEqual({
        valid: false,
        needsRehash: false,
      });
      await expect(service.verify('', 'x')).resolves.toEqual({
        valid: false,
        needsRehash: false,
      });
    });

    it('fails closed (never throws) on a malformed stored hash', async () => {
      await expect(
        service.verify('not-a-valid-phc-string', 'pw'),
      ).resolves.toEqual({ valid: false, needsRehash: false });
    });

    it('rejects an over-length password before hashing (anti-DoS)', async () => {
      const huge = 'a'.repeat(2000);
      await expect(service.hash(huge)).rejects.toThrow(/maximum length/);
    });

    it('never verifies an over-length password (anti-DoS)', async () => {
      const hash = await service.hash('short');
      const res = await service.verify(hash, 'a'.repeat(2000));
      expect(res.valid).toBe(false);
    });
  });

  describe('rehash-on-login detection', () => {
    it('flags a below-target hash (weaker params) as needing a rehash on a valid match', async () => {
      // A REAL argon2id hash produced with WEAKER params than the current target (m=4096 < 19456, t=1<2).
      const weak = await argon2Hash('pw', {
        algorithm: 2,
        memoryCost: 4096,
        timeCost: 1,
        parallelism: 1,
      });
      const res = await service.verify(weak, 'pw');
      expect(res).toEqual({ valid: true, needsRehash: true });
    });

    it('does not flag a current-target hash', async () => {
      const hash = await service.hash('pw');
      const res = await service.verify(hash, 'pw');
      expect(res.needsRehash).toBe(false);
    });

    it('never flags needsRehash when the password does not match', async () => {
      const weak = await argon2Hash('pw', {
        algorithm: 2,
        memoryCost: 4096,
        timeCost: 1,
        parallelism: 1,
      });
      const res = await service.verify(weak, 'wrong');
      expect(res).toEqual({ valid: false, needsRehash: false });
    });
  });

  describe('session token (mint / verify)', () => {
    it('round-trips sub + epoch and carries nothing authorization-bearing', async () => {
      const token = await service.mintSession({
        id: '11111111-1111-1111-1111-111111111111',
        sessionEpoch: 7,
      });
      const claims = await service.verifySession(token);
      expect(claims).toEqual({
        sub: '11111111-1111-1111-1111-111111111111',
        epoch: 7,
      });
      // Decode the payload and assert no role/permissions leaked into the token.
      const payload = decodeSeg(token, 1);
      expect(payload.role).toBeUndefined();
      expect(payload.permissions).toBeUndefined();
      expect(payload.sub).toBe('11111111-1111-1111-1111-111111111111');
      expect(payload.epoch).toBe(7);
      expect(typeof payload.iat).toBe('number');
      expect(typeof payload.exp).toBe('number');
    });

    it('mints an HS256-headed token', async () => {
      const token = await service.mintSession({ id: 'u', sessionEpoch: 0 });
      const header = decodeSeg(token, 0);
      expect(header.alg).toBe(SESSION_TOKEN_ALG); // 'HS256'
    });

    it('REJECTS an alg:none token (no signature) — alg-pin', async () => {
      const forged =
        b64url({ alg: 'none', typ: 'JWT' }) +
        '.' +
        b64url({ sub: 'attacker', epoch: 0 }) +
        '.';
      await expect(service.verifySession(forged)).rejects.toThrow();
    });

    it('REJECTS an RS256-headed token — alg-confusion pin', async () => {
      const forged =
        b64url({ alg: 'RS256', typ: 'JWT' }) +
        '.' +
        b64url({ sub: 'attacker', epoch: 0 }) +
        '.bogus-signature';
      await expect(service.verifySession(forged)).rejects.toThrow();
    });

    it('REJECTS a token signed with a DIFFERENT secret (bad signature)', async () => {
      const now = Math.floor(Date.now() / 1000);
      const token = forgeToken(
        { alg: 'HS256', typ: 'JWT' },
        { sub: 'attacker', epoch: 0, iat: now, exp: now + 3600 },
        'a-completely-different-secret-key-32chars!!',
      );
      await expect(service.verifySession(token)).rejects.toThrow();
    });

    it('REJECTS an expired token', async () => {
      const past = Math.floor(Date.now() / 1000) - 60;
      const token = forgeToken(
        { alg: 'HS256', typ: 'JWT' },
        {
          sub: '11111111-1111-1111-1111-111111111111',
          epoch: 0,
          iat: past - 60,
          exp: past,
        },
        SECRET,
      );
      await expect(service.verifySession(token)).rejects.toThrow(/expired/);
    });

    it('REJECTS a token missing the epoch claim', async () => {
      const now = Math.floor(Date.now() / 1000);
      const token = forgeToken(
        { alg: 'HS256', typ: 'JWT' },
        {
          sub: '11111111-1111-1111-1111-111111111111',
          iat: now,
          exp: now + 3600,
        },
        SECRET,
      );
      await expect(service.verifySession(token)).rejects.toThrow(/epoch/);
    });

    it('throws when the signing secret is unset/too short (fail-loud)', async () => {
      const prev = process.env.SESSION_SIGNING_SECRET;
      process.env.SESSION_SIGNING_SECRET = 'too-short';
      try {
        await expect(
          service.mintSession({ id: 'u', sessionEpoch: 0 }),
        ).rejects.toThrow(/SESSION_SIGNING_SECRET/);
      } finally {
        process.env.SESSION_SIGNING_SECRET = prev;
      }
    });
  });
});
