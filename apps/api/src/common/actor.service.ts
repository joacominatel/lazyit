import { Injectable } from '@nestjs/common';
import type { User } from '../../generated/prisma/client';
import type { Principal } from '../auth/principal';

/**
 * The actor attribution for an audited write (ADR-0048). EXACTLY ONE of the two ids is set (or neither,
 * for a system/unknown actor) — the DB CHECK on every audit-bearing table enforces at-most-one. Spread
 * the matching pair onto the audit/log/ledger row:
 *   - a HUMAN write → `{ userId: <User.id> }`           (the existing `performedById` / `grantedById` / …)
 *   - a SERVICE-ACCOUNT write → `{ serviceAccountId: <id> }` (the new SA actor column on that table)
 *   - system/unknown → both undefined (both FKs stay null)
 */
export interface ActorAttribution {
  userId?: string;
  serviceAccountId?: string;
}

/**
 * Resolves the actor of a write (ADR-0038, extended for service accounts by ADR-0048). The guard
 * ({@link JwtAuthGuard}) already validated and resolved the caller, so this service simply reads it.
 *
 * Two resolvers:
 *   - {@link resolve} — the legacy User → `string | undefined` extractor. Kept UNCHANGED so every
 *     existing human-only call site (`performedById`, `grantedById`, …) keeps working.
 *   - {@link resolveActor} — the unified PRINCIPAL → {@link ActorAttribution} resolver (ADR-0048). Use
 *     it on any audited write that a service account can also perform, then spread the result so the
 *     row is attributed to the right column (`userId` vs `serviceAccountId`) — never a fake userId.
 *
 * `undefined` / empty → system/unknown actor; the optional FK stays null (ADR-0022 / ADR-0024).
 */
@Injectable()
export class ActorService {
  /** Legacy human-actor id extractor (unchanged). `undefined` → system/unknown actor. */
  resolve(user?: User): string | undefined {
    return user?.id;
  }

  /**
   * Resolve the unified principal to the right actor column (ADR-0048). A human → `{ userId }`; a
   * service account → `{ serviceAccountId }`; anonymous/system → `{}`. Spread onto the audit row; the
   * DB at-most-one-actor CHECK guarantees the two columns can never both be set.
   */
  resolveActor(principal?: Principal): ActorAttribution {
    if (!principal) {
      return {};
    }
    if (principal.kind === 'service') {
      return { serviceAccountId: principal.serviceAccount.id };
    }
    return { userId: principal.user.id };
  }
}
