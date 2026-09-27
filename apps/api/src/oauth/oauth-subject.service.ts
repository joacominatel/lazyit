import { Injectable } from '@nestjs/common';
import type { User } from '../../generated/prisma/client';
import { PermissionResolverService } from '../auth/permission-resolver.service';
import { PrismaService } from '../prisma/prisma.service';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a user may hold or obtain an MCP delegation RIGHT NOW (INV-AI-1, INV-AI-9): live (not
 * soft-deleted — the extension hides those), active, not directory-only, not owing a forced password
 * change, and holding `ai:connect` through their role's DB rows (never a token claim). Evaluated at
 * consent, at code exchange and at every refresh.
 */
@Injectable()
export class OAuthSubjectService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionResolverService,
  ) {}

  async holdsConnect(user: Pick<User, 'role'>): Promise<boolean> {
    const granted = await this.permissions.resolve(user.role);
    return granted.has('ai:connect');
  }

  /** The account-state gates alone (no permission read). */
  isUsable(user: User): boolean {
    return user.isActive && !user.directoryOnly && !user.mustChangePassword;
  }

  /** Re-load the user DB-first and apply every gate; `null` when any fails. */
  async loadEligible(userId: string): Promise<User | null> {
    if (!UUID_REGEX.test(userId)) return null;
    const user = await this.prisma.user.findFirst({ where: { id: userId } });
    if (!user || !this.isUsable(user)) return null;
    return (await this.holdsConnect(user)) ? user : null;
  }
}
