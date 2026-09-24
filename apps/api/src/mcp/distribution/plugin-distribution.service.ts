import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AiMcpAuthMode } from '@lazyit/shared';
import { AiToolRegistry } from '../../ai/core/tool-registry';
import { isShimMode } from '../../ai/settings/ai-settings.service';
import { resolveMcpAuthMode } from '../../ai/status/ai-status.service';
import { resolveOAuthServerConfig } from '../../oauth/oauth-config';
import { OAuthPolicyService } from '../../oauth/oauth-policy.service';
import {
  type ResetLinkOriginHeaders,
  resolveResetLinkOrigin,
} from '../../users/reset-link-origin';
import {
  PLUGIN_RENDER_REVISION,
  type PluginToolEntry,
  type RenderedPluginArchive,
  normalizeOrigin,
  renderMarketplace,
  renderPluginArchive,
} from './plugin-renderer';

/** The authenticated download, with the auth mode it was rendered for. */
export interface AuthenticatedPlugin extends RenderedPluginArchive {
  auth: AiMcpAuthMode;
}

/**
 * Bound on cached renders. Public and pinned-origin renders are one entry each; the rest are `lan`
 * renders keyed by the requester's `Host` (authenticated only), so the bound caps what a header can grow.
 */
const CACHE_MAX_ENTRIES = 16;

/**
 * Claude Code plugin distribution (ADR-0097 decision 10, R8; mcp-and-oauth.md §5.5). Three surfaces:
 *
 *   - AUTHENTICATED download (`plugin.zip`): a human session holding `ai:connect` (the controller's guards)
 *     while MCP is enabled. On an HTTPS instance it is the OAuth variant; on `lan` it declares the
 *     personal-token `userConfig`. It carries the generated tool index.
 *   - PUBLIC marketplace (`marketplace.json`) and PUBLIC archive (`lazyit-plugin.zip`): only when MCP is
 *     enabled on an instance with a pinned HTTPS origin (the OAuth issuer) — Claude Code's `archive`
 *     source is HTTPS-only, and on `lan` no anonymous response is ever built from `Host`. The public
 *     archive leaves the tool index out (§5.5, "What is public").
 *
 * Everything answers 404 while MCP is off or in shim mode: off by default = no new surface (INV-AI-12).
 * Renders are deterministic and cached per process; the registry is fixed after boot, so the key is the
 * render revision (prompt + template version), the variant and the origin.
 */
@Injectable()
export class PluginDistributionService {
  private readonly cache = new Map<string, Promise<RenderedPluginArchive>>();

  constructor(
    private readonly policy: OAuthPolicyService,
    private readonly registry: AiToolRegistry,
  ) {}

  /** The public origin, or 404 when there is no public marketplace on this instance. */
  async requirePublicOrigin(): Promise<string> {
    if (isShimMode()) throw new NotFoundException();
    const config = resolveOAuthServerConfig(process.env);
    if (!config) throw new NotFoundException();
    await this.requireMcpEnabled();
    return config.issuer;
  }

  /** The public archive (no tool index, OAuth variant). */
  async publicArchive(): Promise<RenderedPluginArchive> {
    const origin = await this.requirePublicOrigin();
    return this.render(origin, 'oauth', false);
  }

  /** The public `marketplace.json`, pinned to the public archive's digest. */
  async publicMarketplace(): Promise<{
    body: Record<string, unknown>;
    sha256: string;
  }> {
    const origin = await this.requirePublicOrigin();
    const archive = await this.render(origin, 'oauth', false);
    return {
      body: renderMarketplace(origin, archive.sha256),
      sha256: archive.sha256,
    };
  }

  /**
   * The authenticated archive for the caller (the controller has already checked the session,
   * `ai:connect` and that the caller is a human).
   */
  async authenticatedArchive(
    headers: ResetLinkOriginHeaders,
  ): Promise<AuthenticatedPlugin> {
    if (isShimMode()) throw new NotFoundException();
    await this.requireMcpEnabled();
    const auth = resolveMcpAuthMode();
    const origin = this.authenticatedOrigin(auth, headers);
    const archive = await this.render(origin, auth, true);
    return { ...archive, auth };
  }

  /**
   * The origin the authenticated plugin points at. OAuth: the pinned issuer only. `lan`: the pinned
   * `WEB_ORIGIN` when set, else — with `AUTH_TRUST_HOST=true`, ADR-0087's host-agnostic LAN mode — the
   * address the requester reached the instance at. That header-derived origin shapes only the caller's
   * own `no-store` response (the #1268 reasoning in `reset-link-origin.ts`), never an anonymous one.
   */
  private authenticatedOrigin(
    auth: AiMcpAuthMode,
    headers: ResetLinkOriginHeaders,
  ): string {
    if (auth === 'oauth') {
      const config = resolveOAuthServerConfig(process.env);
      if (!config) throw new NotFoundException();
      return config.issuer;
    }
    const raw = resolveResetLinkOrigin(process.env, headers);
    if (raw) {
      try {
        return normalizeOrigin(raw);
      } catch {
        // fall through: an unusable origin is reported like a missing one
      }
    }
    throw new ConflictException({
      message:
        'The instance origin is unknown: set WEB_ORIGIN, or AUTH_TRUST_HOST=true on a LAN instance.',
      code: 'ORIGIN_UNKNOWN',
    });
  }

  private async requireMcpEnabled(): Promise<void> {
    const settings = await this.policy.mcpSettings();
    if (!settings.mcpEnabled) throw new NotFoundException();
  }

  private toolEntries(): PluginToolEntry[] {
    return this.registry.all().map((tool) => ({
      name: tool.descriptor.name,
      title: tool.descriptor.title,
      description: tool.descriptor.description,
      class: tool.descriptor.class,
      permissions: tool.permissions,
      channels: tool.channels,
    }));
  }

  private render(
    origin: string,
    auth: AiMcpAuthMode,
    withToolIndex: boolean,
  ): Promise<RenderedPluginArchive> {
    const key = `${PLUGIN_RENDER_REVISION}|${auth}|${withToolIndex ? 'tools' : 'public'}|${origin}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const pending = renderPluginArchive({
      origin,
      auth,
      tools: withToolIndex ? this.toolEntries() : null,
    });
    // A failed render is not cached; the next request retries.
    pending.catch(() => this.cache.delete(key));
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, pending);
    return pending;
  }
}
