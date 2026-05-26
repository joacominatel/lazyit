import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves the `X-User-Id` auth-shim actor (ADR-0022) — the single, shared implementation behind
 * AccessGrant's `grantedById`, AssetAssignment's `assignedById` / `releasedById` and AssetHistory's
 * `performedById` (the third caller anticipated by [[0024-asset-assignment-actor-shim]]).
 *
 * - `undefined` / empty → `undefined` (system / unknown actor; the optional FK stays null).
 * - A present value must be a **valid live user**, else `400` — soft-deleted users are filtered out
 *   by the soft-delete extension (ADR-0032), so they 400 too. When real auth lands the id comes from
 *   the JWT and this resolution is unchanged.
 */
@Injectable()
export class ActorService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(actorId?: string): Promise<string | undefined> {
    if (actorId === undefined || actorId === '') return undefined;
    if (!UUID_REGEX.test(actorId)) {
      throw new BadRequestException('X-User-Id is not a valid user id');
    }
    const user = await this.prisma.user.findFirst({
      where: { id: actorId },
      select: { id: true },
    });
    if (!user) {
      throw new BadRequestException(
        'X-User-Id does not reference a valid user',
      );
    }
    return user.id;
  }
}
