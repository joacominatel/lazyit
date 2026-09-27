import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  isClientAllowed,
  isRegistrableRedirectUri,
  redirectHost,
} from './client-policy';
import { mintClientId } from './oauth-crypto';
import { sanitizeClientName, sanitizeClientUri } from './client-display';
import { OAuthProtocolError } from './oauth-errors';
import { OAuthAuditService } from './oauth-audit.service';
import { OAuthPolicyService } from './oauth-policy.service';
import {
  DCR_MAX_PENDING_REGISTRATIONS,
  DCR_MAX_REDIRECT_URIS,
  DCR_UNUSED_CLIENT_TTL_MS,
} from './oauth.constants';

/** The RFC 7591 §3.2.1 response. A public client: no `client_secret`, auth method `none`. */
export interface ClientRegistrationResponse {
  client_id: string;
  client_id_issued_at: number;
  client_name: string;
  client_uri?: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: 'none';
}

const SUPPORTED_GRANT_TYPES = ['authorization_code', 'refresh_token'];
const invalidMetadata = (description: string) =>
  new OAuthProtocolError('invalid_client_metadata', description);
const invalidRedirect = (description: string) =>
  new OAuthProtocolError('invalid_redirect_uri', description);

function optionalStringArray(value: unknown, field: string): string[] | null {
  if (value === undefined) return null;
  if (
    !Array.isArray(value) ||
    value.length > 10 ||
    !value.every((item) => typeof item === 'string' && item.length <= 64)
  ) {
    throw invalidMetadata(`${field} must be an array of strings`);
  }
  return value as string[];
}

/**
 * Dynamic Client Registration (RFC 7591) for PUBLIC clients only (ADR-0097 decision 8; mcp-and-oauth.md
 * §4 F2). DCR is deprecated by the MCP spec but every current client still uses it.
 *
 * A registration is never trusted: its name is self-declared (the consent page says so), and it is
 * admitted only when EVERY redirect URI passes the client allowlist (decision 13): a listed pattern, or
 * — for https only — the "any HTTPS client" toggle. Plain http off loopback and browser-interpreted
 * schemes (`javascript:`, `data:` …) are refused outright; a private-use scheme (`cursor://…`) needs an
 * explicit entry. `client_name` never takes part in the decision.
 */
@Injectable()
export class ClientRegistrationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: OAuthPolicyService,
    private readonly audit: OAuthAuditService,
  ) {}

  async register(
    body: unknown,
    ctx: { ip?: string | null } = {},
  ): Promise<ClientRegistrationResponse> {
    const { settings } = await this.policy.requireEnabled();
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw invalidMetadata('The registration request must be a JSON object');
    }
    const request = body as Record<string, unknown>;

    const redirectUris = request.redirect_uris;
    if (
      !Array.isArray(redirectUris) ||
      redirectUris.length === 0 ||
      redirectUris.length > DCR_MAX_REDIRECT_URIS ||
      !redirectUris.every((uri) => typeof uri === 'string')
    ) {
      throw invalidRedirect(
        `redirect_uris must list between 1 and ${DCR_MAX_REDIRECT_URIS} URIs`,
      );
    }
    const uris = [...new Set(redirectUris)];
    const refused = uris.find((uri) => !isRegistrableRedirectUri(uri));
    if (refused !== undefined) {
      throw invalidRedirect(
        'Redirect URIs must be https://, http:// on a loopback address, or a private-use app scheme',
      );
    }

    const authMethod = request.token_endpoint_auth_method;
    if (authMethod !== undefined && authMethod !== 'none') {
      throw invalidMetadata(
        'Only public clients are supported (token_endpoint_auth_method "none")',
      );
    }
    const grantTypes = optionalStringArray(request.grant_types, 'grant_types');
    if (
      grantTypes !== null &&
      (!grantTypes.includes('authorization_code') ||
        grantTypes.some((type) => !SUPPORTED_GRANT_TYPES.includes(type)))
    ) {
      throw invalidMetadata(
        'grant_types must be authorization_code, optionally with refresh_token',
      );
    }
    const responseTypes = optionalStringArray(
      request.response_types,
      'response_types',
    );
    if (
      responseTypes !== null &&
      (responseTypes.length === 0 ||
        responseTypes.some((type) => type !== 'code'))
    ) {
      throw invalidMetadata('response_types must be ["code"]');
    }

    const candidate = { kind: 'dcr', clientId: '', redirectUris: uris };
    if (!isClientAllowed(candidate, settings)) {
      throw invalidRedirect(
        "A redirect URI is not on this instance's MCP client allowlist. Ask an administrator to add the client in Settings → AI.",
      );
    }

    const pending = await this.prisma.oAuthClient.count({
      where: {
        kind: 'dcr',
        createdAt: { gt: new Date(Date.now() - DCR_UNUSED_CLIENT_TTL_MS) },
        lastUsedAt: null,
      },
    });
    if (pending >= DCR_MAX_PENDING_REGISTRATIONS) {
      throw new HttpException(
        {
          error: 'temporarily_unavailable',
          error_description: 'Too many pending registrations. Try again later.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const name = sanitizeClientName(request.client_name);
    const clientUri = sanitizeClientUri(request.client_uri);
    const clientId = mintClientId();
    const metadata: Prisma.InputJsonValue = {
      client_name: name,
      client_uri: clientUri,
      redirect_uris: uris,
      grant_types: SUPPORTED_GRANT_TYPES,
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(typeof request.application_type === 'string' &&
      ['native', 'web'].includes(request.application_type)
        ? { application_type: request.application_type }
        : {}),
      ...(typeof request.software_id === 'string'
        ? { software_id: request.software_id.slice(0, 200) }
        : {}),
      ...(typeof request.software_version === 'string'
        ? { software_version: request.software_version.slice(0, 64) }
        : {}),
    };

    const created = await this.prisma.oAuthClient.create({
      data: {
        clientId,
        kind: 'dcr',
        name,
        clientUri,
        logoUri: null,
        redirectUris: uris,
        metadata,
      },
    });
    await this.audit.record({
      action: 'CLIENT_REGISTERED',
      clientId,
      ip: ctx.ip,
      detail: { name, redirectHosts: uris.map(redirectHost) },
    });

    return {
      client_id: clientId,
      client_id_issued_at: Math.floor(created.createdAt.getTime() / 1000),
      client_name: name,
      ...(clientUri ? { client_uri: clientUri } : {}),
      redirect_uris: uris,
      grant_types: SUPPORTED_GRANT_TYPES,
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }
}
