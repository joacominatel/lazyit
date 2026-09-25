import { Injectable, Logger } from '@nestjs/common';
import type { OAuthClient, Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { OAuthAuditService } from '../oauth-audit.service';
import { FixedWindowRateLimiter } from '../oauth-rate-limit';
import { cacheLifetimeMs } from './cache-lifetime';
import {
  CIMD_BUNDLED_RETRY_MS,
  CIMD_CACHE_MAX_TTL_MS,
  CIMD_FETCH_RATE_LIMIT,
} from './cimd.constants';
import {
  CimdRefusal,
  documentRedirectHosts,
  parseClientMetadataDocument,
  type CimdDocument,
} from './cimd-document';
import {
  fetchClientMetadataDocument,
  type CimdFetchOptions,
} from './cimd-fetcher';
import { parseClientIdUrl } from './client-id-url';
import { KNOWN_CLIENT_DOCUMENTS } from './known-clients';

/** Where the cached registration came from. */
export type CimdSource = 'network' | 'bundled';

/** Who triggered the resolution — recorded in the audit trail. */
export interface CimdResolveContext {
  userId: string;
  ip?: string | null;
}

/** `OAuthClient.metadata` of a CIMD / known row: the sanitized document plus lazyit's cache bookkeeping. */
interface CimdMetadata {
  document: CimdDocument;
  cache: { source: CimdSource; expiresAt: string };
}

/** When the cached registration of a row expires, or `null` when it carries no usable bookkeeping. */
function cacheExpiresAt(client: OAuthClient): number | null {
  const metadata = client.metadata as unknown;
  if (metadata === null || typeof metadata !== 'object') return null;
  const cache = (metadata as { cache?: unknown }).cache;
  if (cache === null || typeof cache !== 'object') return null;
  const expiresAt = (cache as { expiresAt?: unknown }).expiresAt;
  if (typeof expiresAt !== 'string') return null;
  const at = Date.parse(expiresAt);
  return Number.isNaN(at) ? null : at;
}

/**
 * CIMD — OAuth Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-document; ADR-0097
 * decision 8; mcp-and-oauth.md §4 F2 and §15). When an authorization request's `client_id` is an https URL,
 * this service turns it into an `OAuthClient` row:
 *
 *   1. The URL must be an acceptable Client Identifier URL ({@link parseClientIdUrl}); otherwise the client
 *      is unknown.
 *   2. A cached row whose lifetime has not lapsed is used as is.
 *   3. Otherwise the document is fetched through the egress guard ({@link fetchClientMetadataDocument} —
 *      INV-MCP-6 / INV-AI-7), validated ({@link parseClientMetadataDocument}) and cached on the row
 *      (`kind: 'cimd'`, `fetchedAt`) for the response's cache lifetime, clamped to lazyit's bounds.
 *      Errors and invalid documents are never cached.
 *   4. When the fetch fails for a NETWORK reason (see {@link CimdRefusal.networkFailure}) and the URL has a
 *      BUNDLED copy (Claude Code's), that copy is validated the same way and cached as `kind: 'known'` for
 *      a short retry interval, so an HTTPS instance without internet access can still connect it. An
 *      invalid or definitive answer from the host, or a URL without a bundled copy, is refused (the draft's
 *      "SHOULD abort"); a stale cached row is NOT used.
 *
 * Whether the resulting client may connect is NOT decided here: the caller applies the client allowlist
 * (`isClientAllowed`, ADR-0097 decision 13) to the row exactly as it does for a DCR client.
 *
 * Network fetches (cache misses) are rate limited per user, and each one is audited
 * (`CLIENT_METADATA_FETCHED` / `CLIENT_METADATA_REFUSED`). Only a signed-in user holding `ai:connect` on an
 * instance with MCP on ever reaches this service (the authorization endpoint checks those first).
 */
@Injectable()
export class CimdClientService {
  private readonly logger = new Logger(CimdClientService.name);
  private readonly fetchLimiter = new FixedWindowRateLimiter(
    CIMD_FETCH_RATE_LIMIT.max,
    CIMD_FETCH_RATE_LIMIT.windowMs,
  );
  /** Test seam for the egress guard's transport and resolver; empty in production. */
  fetchOptions: CimdFetchOptions = {};

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: OAuthAuditService,
  ) {}

  /** Resolve a Client Identifier URL to its (cached, refreshed or bundled) client row, or `null`. */
  async resolve(
    clientId: string,
    ctx: CimdResolveContext,
  ): Promise<OAuthClient | null> {
    const url = parseClientIdUrl(clientId);
    if (!url) return null;
    const now = Date.now();

    const existing = await this.prisma.oAuthClient.findUnique({
      where: { clientId },
    });
    // A row under an https id is only ever a CIMD or bundled one; anything else is not ours to serve.
    if (existing && existing.kind !== 'cimd' && existing.kind !== 'known') {
      return null;
    }
    if (existing) {
      const expiresAt = cacheExpiresAt(existing);
      if (
        expiresAt !== null &&
        expiresAt > now &&
        expiresAt <= now + CIMD_CACHE_MAX_TTL_MS
      ) {
        return existing;
      }
    }

    let document: CimdDocument;
    let lifetimeMs: number;
    try {
      if (!this.fetchLimiter.hit(ctx.userId, now)) {
        throw new CimdRefusal(
          'rate_limited',
          'Too many client metadata fetches; try again later',
          true,
        );
      }
      const fetched = await fetchClientMetadataDocument(url, this.fetchOptions);
      document = parseClientMetadataDocument(fetched.body, clientId);
      lifetimeMs = cacheLifetimeMs(fetched.headers, now);
    } catch (err) {
      if (!(err instanceof CimdRefusal)) throw err;
      return this.fallBack(clientId, url, existing, err, ctx, now);
    }

    const row = await this.store(
      clientId,
      'network',
      document,
      lifetimeMs,
      now,
    );
    await this.audit.record({
      action: 'CLIENT_METADATA_FETCHED',
      userId: ctx.userId,
      actorId: ctx.userId,
      clientId,
      ip: ctx.ip,
      detail: {
        host: url.host,
        source: 'network',
        ttlSeconds: Math.round(lifetimeMs / 1000),
        redirectHosts: documentRedirectHosts(document),
        redirectsChanged: existing
          ? !sameSet(existing.redirectUris, document.redirect_uris)
          : false,
      },
    });
    return row;
  }

  /**
   * The fetch failed. A NETWORK failure (unreachable, timeout, transient status, redirect, a non-JSON page,
   * the per-user limit) is served from the bundled copy when there is one; an answer from the client's
   * host that is definitive or invalid (404/410, a JSON document failing validation) is refused and
   * audited even for a bundled client — the host's word wins over the image's copy.
   */
  private async fallBack(
    clientId: string,
    url: URL,
    existing: OAuthClient | null,
    refusal: CimdRefusal,
    ctx: CimdResolveContext,
    now: number,
  ): Promise<OAuthClient | null> {
    const bundled = refusal.networkFailure
      ? KNOWN_CLIENT_DOCUMENTS.get(clientId)
      : undefined;
    if (bundled !== undefined) {
      const document = parseClientMetadataDocument(bundled, clientId);
      const row = await this.store(
        clientId,
        'bundled',
        document,
        CIMD_BUNDLED_RETRY_MS,
        now,
      );
      await this.audit.record({
        action: 'CLIENT_METADATA_FETCHED',
        userId: ctx.userId,
        actorId: ctx.userId,
        clientId,
        ip: ctx.ip,
        detail: {
          host: url.host,
          source: 'bundled',
          fetchFailure: refusal.reason,
          redirectHosts: documentRedirectHosts(document),
          redirectsChanged: existing
            ? !sameSet(existing.redirectUris, document.redirect_uris)
            : false,
        },
      });
      return row;
    }
    if (refusal.reason === 'rate_limited') {
      // Not audited: the refusal exists to bound work, and a row per refused attempt would defeat it.
      this.logger.warn(
        `CIMD fetch rate limit reached for user ${ctx.userId} (${url.host}).`,
      );
      return null;
    }
    await this.audit.record({
      action: 'CLIENT_METADATA_REFUSED',
      userId: ctx.userId,
      actorId: ctx.userId,
      clientId,
      ip: ctx.ip,
      detail: { host: url.host, reason: refusal.reason },
    });
    return null;
  }

  /** Create or refresh the row for a validated document. */
  private async store(
    clientId: string,
    source: CimdSource,
    document: CimdDocument,
    lifetimeMs: number,
    now: number,
  ): Promise<OAuthClient> {
    const metadata: CimdMetadata = {
      document,
      cache: {
        source,
        expiresAt: new Date(now + lifetimeMs).toISOString(),
      },
    };
    const data = {
      kind: source === 'network' ? 'cimd' : 'known',
      name: document.client_name,
      clientUri: document.client_uri,
      logoUri: null,
      redirectUris: document.redirect_uris,
      metadata: metadata as unknown as Prisma.InputJsonValue,
      fetchedAt: source === 'network' ? new Date(now) : null,
    };
    try {
      return await this.prisma.oAuthClient.upsert({
        where: { clientId },
        create: { clientId, ...data },
        update: data,
      });
    } catch (err) {
      // Only a unique-constraint race is recoverable: a concurrent first resolution of the same URL
      // created the row between our read and write. Anything else propagates.
      if ((err as { code?: unknown }).code !== 'P2002') throw err;
      const row = await this.prisma.oAuthClient.findUnique({
        where: { clientId },
      });
      if (row) return row;
      throw err;
    }
  }
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item) => b.includes(item));
}
