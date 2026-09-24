import { Injectable } from '@nestjs/common';
import type { DelegatedIdentity } from '../../auth/delegated-identity';
import { PermissionResolverService } from '../../auth/permission-resolver.service';
import { PrincipalLoaderService } from '../../auth/principal-loader.service';

/**
 * Whether the caller of an open event stream would still be let in (checked on every heartbeat): the
 * principal re-loaded as the auth guard loads it — a human at the stream's `sessionEpoch` (a logout, a
 * password change or a deactivation fails it), a Service Account not revoked, inactive or expired — and
 * still holding `ai:use`. The run's own guardrails (the per-SA AI access setting, `infra:report`) are the
 * runtime's; a run they stop ends with `run.finished`, which closes the stream anyway.
 */
@Injectable()
export class AiStreamPrincipalCheck {
  constructor(
    private readonly loader: PrincipalLoaderService,
    private readonly permissions: PermissionResolverService,
  ) {}

  async stillAllowed(identity: DelegatedIdentity): Promise<boolean> {
    if (identity.kind === 'human') {
      const loaded = await this.loader.loadHuman(
        identity.userId,
        identity.sessionEpoch,
      );
      if (!loaded.ok) return false;
      const granted = await this.permissions.resolve(
        loaded.principal.user.role,
      );
      return granted.has('ai:use');
    }
    const loaded = await this.loader.loadServiceAccount(
      identity.serviceAccountId,
    );
    return loaded.ok && loaded.principal.permissions.has('ai:use');
  }
}
