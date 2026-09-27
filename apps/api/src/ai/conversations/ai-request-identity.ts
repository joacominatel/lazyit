import { ForbiddenException } from '@nestjs/common';
import type { AiConversationChannel } from '@lazyit/shared';
import type { DelegatedIdentity } from '../../auth/delegated-identity';
import type { Principal } from '../../auth/principal';

/**
 * The delegated identity an AI HTTP request acts as (ADR-0097; synthesis §1, §4.7), derived from the
 * principal the global `JwtAuthGuard` loaded for THIS request — never from anything the client sends.
 *
 * - A human carries the `sessionEpoch` of the row the guard just re-read (it equals the session token's
 *   epoch, or the guard would have refused the token), so a logout or password change after the request
 *   refuses the run's later steps and tool calls.
 * - A Service Account carries its id.
 *
 * No principal (shim mode, anonymous) is 403: the AI is never anonymous.
 */
export function aiIdentityOf(principal: Principal | undefined): {
  identity: DelegatedIdentity;
  channel: AiConversationChannel;
} {
  if (principal?.kind === 'human') {
    return {
      identity: {
        kind: 'human',
        userId: principal.user.id,
        sessionEpoch: principal.user.sessionEpoch,
      },
      channel: 'CHAT',
    };
  }
  if (principal?.kind === 'service') {
    return {
      identity: {
        kind: 'service',
        serviceAccountId: principal.serviceAccount.id,
      },
      channel: 'HEADLESS',
    };
  }
  throw new ForbiddenException({
    code: 'FORBIDDEN',
    message: 'Authentication required',
  });
}

/**
 * The human identity of an in-app chat request. The chat (`/ai/conversations`) is the human channel: a
 * Service Account is refused with 403 and uses `POST /ai/runs` instead.
 */
export function aiHumanIdentityOf(
  principal: Principal | undefined,
): Extract<DelegatedIdentity, { kind: 'human' }> {
  const { identity } = aiIdentityOf(principal);
  if (identity.kind !== 'human') {
    throw new ForbiddenException({
      code: 'FORBIDDEN',
      message:
        'The in-app chat is for signed-in users; a Service Account uses POST /ai/runs',
    });
  }
  return identity;
}

/** The owner filter of a conversation or run for an identity (owner-only reads, ADR-0097 default 3). */
export function ownerWhere(identity: DelegatedIdentity): {
  userId?: string;
  serviceAccountId?: string;
} {
  return identity.kind === 'human'
    ? { userId: identity.userId }
    : { serviceAccountId: identity.serviceAccountId };
}
