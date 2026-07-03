import { LocalCredentialService } from './local-credential.service';
import { LocalProvisioningService } from './local-provisioning.service';
import { SetupPasswordSchema } from '@lazyit/shared';

/**
 * LocalProvisioningService (ADR-0086 §5, F1c) — the set-password primitive. These tests exercise the REAL
 * LocalCredentialService (argon2id) since the hashing is the point; the argon2 cost is a few ms per hash.
 */
describe('LocalProvisioningService', () => {
  let credentials: LocalCredentialService;
  let service: LocalProvisioningService;

  beforeEach(() => {
    credentials = new LocalCredentialService();
    service = new LocalProvisioningService(credentials);
  });

  describe('credentialFields', () => {
    it('hashes the plaintext to a verifiable argon2id PHC hash and stamps passwordUpdatedAt', async () => {
      const before = Date.now();
      const fields = await service.credentialFields('S3cure-Pass!');

      expect(fields.passwordHash).toMatch(/^\$argon2id\$/);
      // The hash verifies against the original plaintext and NOT against a different one (fail-closed).
      await expect(
        credentials.verify(fields.passwordHash, 'S3cure-Pass!'),
      ).resolves.toEqual({ valid: true, needsRehash: false });
      await expect(
        credentials.verify(fields.passwordHash, 'wrong'),
      ).resolves.toEqual({ valid: false, needsRehash: false });

      expect(fields.passwordUpdatedAt.getTime()).toBeGreaterThanOrEqual(before);
      // Default: the owner set their own password → not a forced-change credential.
      expect(fields.mustChangePassword).toBe(false);
    });

    it('sets mustChangePassword when the caller asks (admin-provisioned / reset temp credential)', async () => {
      const fields = await service.credentialFields('S3cure-Pass!', {
        mustChangePassword: true,
      });
      expect(fields.mustChangePassword).toBe(true);
    });

    it('produces a DIFFERENT hash for the same password (per-hash random salt)', async () => {
      const a = await service.credentialFields('same-password-1A!');
      const b = await service.credentialFields('same-password-1A!');
      expect(a.passwordHash).not.toEqual(b.passwordHash);
    });
  });

  describe('generateTempPassword', () => {
    it('satisfies the setup/temp password policy (upper+lower+digit+symbol, >=8) every time', () => {
      for (let i = 0; i < 50; i++) {
        const temp = service.generateTempPassword();
        expect(temp.length).toBeGreaterThanOrEqual(8);
        // The shared policy is the single source of truth — parse against it directly.
        expect(SetupPasswordSchema.safeParse(temp).success).toBe(true);
      }
    });

    it('is non-deterministic (CSPRNG)', () => {
      const seen = new Set<string>();
      for (let i = 0; i < 20; i++) {
        seen.add(service.generateTempPassword());
      }
      expect(seen.size).toBe(20);
    });
  });
});
