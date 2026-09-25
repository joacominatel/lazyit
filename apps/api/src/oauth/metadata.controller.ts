import { Controller, Get, Header } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { OAUTH_SCOPES } from '@lazyit/shared';
import { Public } from '../auth/public.decorator';
import type { OAuthServerConfig } from './oauth-config';
import { OAuthPolicyService } from './oauth-policy.service';

/** RFC 8414 Authorization Server Metadata. OAuth only — no OIDC fields, no `openid-configuration`. */
export function buildAuthorizationServerMetadata(config: OAuthServerConfig) {
  const { issuer } = config;
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [...OAUTH_SCOPES],
    authorization_response_iss_parameter_supported: true,
    // CIMD (W3-3): an https `client_id` is fetched as a Client ID Metadata Document. Claude picks CIMD only
    // when this is true AND "none" is an accepted token endpoint auth method (above).
    client_id_metadata_document_supported: true,
  };
}

/** RFC 9728 Protected Resource Metadata for the one resource, `{issuer}/mcp`. */
export function buildProtectedResourceMetadata(config: OAuthServerConfig) {
  return {
    resource: config.resource,
    authorization_servers: [config.issuer],
    scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'lazyit',
  };
}

/**
 * The discovery documents (ADR-0097 decision 8; mcp-and-oauth.md §5.1). Public paths — Caddy routes
 * `/.well-known/oauth-*` to the API unprefixed. Both answer 404 when the instance has no HTTPS issuer
 * (`lan`, shim) or MCP is switched off, so an instance that never enables MCP exposes nothing new.
 *
 * The issuer has no path, so the RFC 8414 document lives only at the root well-known URI; the RFC 9728
 * document is served at the path-inserted URI for `/mcp` and at the root alias.
 */
@ApiExcludeController()
@Public()
@Controller('.well-known')
export class MetadataController {
  constructor(private readonly policy: OAuthPolicyService) {}

  @Get('oauth-authorization-server')
  @Header('Cache-Control', 'no-cache')
  async authorizationServer() {
    const { config } = await this.policy.requireEnabled();
    return buildAuthorizationServerMetadata(config);
  }

  @Get(['oauth-protected-resource', 'oauth-protected-resource/mcp'])
  @Header('Cache-Control', 'no-cache')
  async protectedResource() {
    const { config } = await this.policy.requireEnabled();
    return buildProtectedResourceMetadata(config);
  }
}
