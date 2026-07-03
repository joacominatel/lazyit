import { Injectable } from '@nestjs/common';
import { randomBytes, randomInt } from 'node:crypto';
import { LocalCredentialService } from './local-credential.service';

/**
 * The Prisma-`User` field fragment written when a LOCAL credential is set (ADR-0086 §5). Spread into a
 * `create` (setup / first admin / provisioned user) or an `update` (admin reset) data object. NEVER
 * carries the plaintext — only the argon2id hash + bookkeeping.
 */
export interface LocalCredentialFields {
  passwordHash: string;
  passwordUpdatedAt: Date;
  mustChangePassword: boolean;
}

/**
 * LocalProvisioningService — the set-password PRIMITIVE for AUTH_MODE=local (ADR-0086 §5, F1c). The single
 * home for "turn a plaintext into the stored-credential fields" + "mint a temp-password", reused by:
 *   - `ConfigService.setup`   — the first ADMIN chooses their own password (mustChangePassword=false).
 *   - `UsersService.create`   — an admin provisions a user WITH a temp password (mustChangePassword=true).
 *   - `UsersService.requestPasswordReset` — an admin resets → a minted temp-password (mustChangePassword=true).
 *
 * It leans entirely on {@link LocalCredentialService.hash} for the argon2id hashing (one hashing seam,
 * INV-10-separated from any vault key material) and adds only the small provisioning-specific glue:
 * the field fragment + a policy-satisfying random temp-password generator. It NEVER reads the DB or bumps
 * `sessionEpoch` itself — the caller owns the row write (so the reset path can add `sessionEpoch: {increment:1}`
 * atomically with the field set, and create/setup can inline the fields into a fresh row).
 */
@Injectable()
export class LocalProvisioningService {
  constructor(private readonly credentials: LocalCredentialService) {}

  /**
   * Hash `plaintext` and build the credential field fragment to store on a User row. `mustChangePassword`
   * defaults to false (the owner set their own password); pass true for admin-provisioned / reset temp
   * credentials (one-time hand-off secret — the flag is stored now; enforcement is F4).
   */
  async credentialFields(
    plaintext: string,
    opts?: { mustChangePassword?: boolean },
  ): Promise<LocalCredentialFields> {
    const passwordHash = await this.credentials.hash(plaintext);
    return {
      passwordHash,
      passwordUpdatedAt: new Date(),
      mustChangePassword: opts?.mustChangePassword ?? false,
    };
  }

  /**
   * Generate a strong random one-time password for an admin reset / provisioning hand-off. Satisfies the
   * shared setup/temp password policy (Zitadel-default complexity: ≥8 chars with at least one upper, lower,
   * digit and symbol) by construction — one of each class, then filled with URL-safe base64 entropy and
   * shuffled. Uses the CSPRNG (`node:crypto`), never `Math.random`. Returned to the admin ONCE (shown once,
   * never persisted in plaintext).
   */
  generateTempPassword(): string {
    const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const lower = 'abcdefghijkmnpqrstuvwxyz';
    const digit = '23456789';
    const symbol = '!@#$%^&*-_=+';
    const pick = (set: string): string => set[randomInt(set.length)];

    // One of each required class guarantees the policy; the rest is high-entropy filler (~18 chars total).
    const required = [pick(upper), pick(lower), pick(digit), pick(symbol)];
    const filler = randomBytes(14)
      .toString('base64url')
      .replace(/[^A-Za-z0-9]/g, '')
      .slice(0, 14);

    const chars = [...required, ...filler.split('')];
    // Fisher-Yates shuffle with the CSPRNG so the required classes are not always at the front.
    for (let i = chars.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    return chars.join('');
  }
}
