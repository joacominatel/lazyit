import { Injectable, NotFoundException } from '@nestjs/common';
import {
  AI_SETTINGS_DEFAULTS,
  McpClientAllowlistAddedReadSchema,
  resolveMcpClientAllowlist,
} from '@lazyit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { MCP_CLIENT_ALLOWLIST_DEFAULTS } from './client-allowlist.defaults';
import type { ClientTrustPolicy } from './client-policy';
import {
  type OAuthServerConfig,
  resolveOAuthServerConfig,
} from './oauth-config';

/** What the authorization server needs from `ai_settings`. */
export interface OAuthMcpSettings extends ClientTrustPolicy {
  mcpEnabled: boolean;
}

/**
 * The gates in front of every authorization-server endpoint:
 *   - the pinned HTTPS issuer (`resolveOAuthServerConfig`) — absent on `lan`, `http://` origins and shim;
 *   - the instance MCP switch (`ai_settings.mcpEnabled`, off by default, an absent row reads as off);
 *   - the client allowlist overlay, resolved against the curated defaults.
 *
 * The settings row is read directly (a narrow `select` of the four MCP columns) rather than through the
 * `AI_SETTINGS_READER` port: the port's `getSettings()` does not return the effective allowlist, and the
 * authorization server must not depend on the provider configuration being readable. The read is
 * tolerant: an admin entry this build cannot parse is dropped (`McpClientAllowlistAddedReadSchema`).
 */
@Injectable()
export class OAuthPolicyService {
  constructor(private readonly prisma: PrismaService) {}

  /** The issuer + canonical resource, or `null` when this instance has no authorization server. */
  config(): OAuthServerConfig | null {
    return resolveOAuthServerConfig(process.env);
  }

  /** The configuration, or a 404 — the AS endpoints do not exist on a non-HTTPS instance. */
  requireConfig(): OAuthServerConfig {
    const config = this.config();
    if (!config) throw new NotFoundException();
    return config;
  }

  /** The MCP switch and the effective client trust policy. */
  async mcpSettings(): Promise<OAuthMcpSettings> {
    const row = await this.prisma.aiSettings.findUnique({
      where: { id: 'singleton' },
      select: {
        mcpEnabled: true,
        mcpClientAllowlistAdded: true,
        mcpClientAllowlistRemovedDefaults: true,
        mcpAllowAnyHttpsClient: true,
      },
    });
    const added = McpClientAllowlistAddedReadSchema.safeParse(
      row?.mcpClientAllowlistAdded ?? [],
    );
    return {
      mcpEnabled: row?.mcpEnabled ?? AI_SETTINGS_DEFAULTS.mcpEnabled,
      allowlist: resolveMcpClientAllowlist(
        MCP_CLIENT_ALLOWLIST_DEFAULTS,
        added.success ? added.data : [],
        row?.mcpClientAllowlistRemovedDefaults ?? [],
      ),
      allowAnyHttpsClient:
        row?.mcpAllowAnyHttpsClient ??
        AI_SETTINGS_DEFAULTS.mcpAllowAnyHttpsClient,
    };
  }

  /**
   * The configuration and settings of an ENABLED authorization server, or a 404: with no HTTPS issuer
   * or with MCP switched off, the protocol endpoints do not exist (off by default = no new anonymous
   * surface, INV-AI-12).
   */
  async requireEnabled(): Promise<{
    config: OAuthServerConfig;
    settings: OAuthMcpSettings;
  }> {
    const config = this.requireConfig();
    const settings = await this.mcpSettings();
    if (!settings.mcpEnabled) throw new NotFoundException();
    return { config, settings };
  }
}
