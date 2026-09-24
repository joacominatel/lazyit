import { Inject, Injectable } from '@nestjs/common';
import {
  AI_PROVIDER_DESCRIPTORS,
  type AiMcpAuthMode,
  type AiStatus,
  type Permission,
} from '@lazyit/shared';
import { PermissionResolverService } from '../../auth/permission-resolver.service';
import {
  isHumanPrincipal,
  isServicePrincipal,
  type Principal,
} from '../../auth/principal';
import {
  AI_SETTINGS_READER,
  type AiSettingsReader,
} from '../core/ports/ai-settings.port';
import { isShimMode } from '../settings/ai-settings.service';

/**
 * How `/mcp` authenticates on this instance (synthesis §4.5, §4.8; mcp-and-oauth.md §5.1): OAuth 2.1 only
 * when the public origin is PINNED to https (`WEB_ORIGIN`) — the issuer is pinned configuration, never
 * derived from `Host`; anything else (the plain-HTTP `lan` posture of ADR-0087) uses personal tokens.
 */
export function resolveMcpAuthMode(
  env: NodeJS.ProcessEnv = process.env,
): AiMcpAuthMode {
  const origin = env.WEB_ORIGIN?.trim();
  return origin && /^https:\/\//i.test(origin) ? 'oauth' : 'personal-token';
}

/**
 * `GET /ai/status` (synthesis §4.5) — per caller, no secrets:
 *   - `chat.available` = enabled ∧ the caller holds `ai:use` ∧ the provider is usable — the reader's
 *     `resolveProviderConfig()` resolves (known provider, a model, a stored key that DECRYPTS) and a
 *     provider that needs a key has one;
 *   - `mcp.available`  = the MCP switch ∧ the caller holds `ai:connect`;
 *   - neither is ever available in shim mode (security.md §12 G1);
 *   - `configRevision` = the settings row's `updatedAt` (`"0"` while none exists), so other shells notice
 *     an enable or disable;
 *   - `retentionDays` only while the chat is available to this caller.
 * Permissions are resolved DB-first (the role matrix for a human, the direct grants for a service account).
 */
@Injectable()
export class AiStatusService {
  constructor(
    @Inject(AI_SETTINGS_READER) private readonly settings: AiSettingsReader,
    private readonly permissions: PermissionResolverService,
  ) {}

  async getStatus(principal: Principal | undefined): Promise<AiStatus> {
    const settings = await this.settings.getSettings();
    const configRevision = settings.updatedAt ?? '0';
    const auth = resolveMcpAuthMode();
    if (isShimMode() || !principal) {
      return {
        chat: { available: false },
        mcp: { available: false, auth },
        configRevision,
        retentionDays: null,
      };
    }

    const held = await this.heldPermissions(principal);
    const chatAvailable =
      settings.enabled && held.has('ai:use') && (await this.providerUsable());
    const mcpAvailable = settings.mcpEnabled && held.has('ai:connect');

    return {
      chat: { available: chatAvailable },
      mcp: { available: mcpAvailable, auth },
      configRevision,
      retentionDays: chatAvailable ? settings.retentionDays : null,
    };
  }

  /**
   * The same check the runtime's model call makes (review F4): `resolveProviderConfig()` is null when the
   * stored key does not decrypt (AI_SECRET_KEY changed or removed), the provider is unknown, or the model
   * is missing; a provider that needs a key must also have one.
   */
  private async providerUsable(): Promise<boolean> {
    const config = await this.settings.resolveProviderConfig();
    if (!config) return false;
    return (
      config.apiKey !== null ||
      !AI_PROVIDER_DESCRIPTORS[config.provider].requiresApiKey
    );
  }

  private async heldPermissions(
    principal: Principal,
  ): Promise<ReadonlySet<Permission>> {
    if (isServicePrincipal(principal)) return principal.permissions;
    if (isHumanPrincipal(principal)) {
      return this.permissions.resolve(principal.user.role);
    }
    return new Set();
  }
}
