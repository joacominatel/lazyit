import { Injectable } from '@nestjs/common';
import type { User } from '../../generated/prisma/client';

/**
 * Resolves the actor id from a User entity (ADR-0038). The guard (JwtAuthGuard) already
 * validates and resolves the User, so this service simply extracts the id.
 *
 * The old X-User-Id shim logic (UUID validation + DB lookup) has moved into JwtAuthGuard, which
 * runs in AUTH_MODE=shim and sets request.user before the controller is reached. Services receive
 * a `user?: User` and delegate to this method to obtain `string | undefined` for FK writes.
 *
 * `undefined` → system/unknown actor; the optional FK stays null (ADR-0022 / ADR-0024).
 */
@Injectable()
export class ActorService {
  resolve(user?: User): string | undefined {
    return user?.id;
  }
}
