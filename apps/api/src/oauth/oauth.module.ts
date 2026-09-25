import { Module } from '@nestjs/common';
import { AuthorizeController } from './authorize.controller';
import { AuthorizationService } from './authorization.service';
import { CimdClientService } from './cimd/cimd-client.service';
import { ClientRegistrationService } from './client-registration.service';
import { GrantsController } from './grants.controller';
import { GrantsService } from './grants.service';
import { MetadataController } from './metadata.controller';
import { OAuthAuditService } from './oauth-audit.service';
import { OAuthPolicyService } from './oauth-policy.service';
import {
  ConsentDecisionRateLimitGuard,
  RegisterRateLimitGuard,
  RevokeRateLimitGuard,
  TokenRateLimitGuard,
} from './oauth-rate-limit';
import { OAuthSubjectService } from './oauth-subject.service';
import { OAuthTokenService } from './oauth-token.service';
import { OAuthSweeper } from './oauth.sweeper';
import { PersonalTokensController } from './personal-tokens/personal-tokens.controller';
import { PersonalTokensService } from './personal-tokens/personal-tokens.service';
import { RegisterController } from './register.controller';
import { RevokeController } from './revoke.controller';
import { TokenController } from './token.controller';

/**
 * lazyit's OAuth 2.1 authorization server for MCP clients (ADR-0097 decision 8;
 * docs/ai-assistant/mcp-and-oauth.md §5; synthesis §4.7–4.8): discovery metadata, the consent
 * validate/decision API, the token, registration and revocation endpoints, connected apps, the audit
 * trail and the sweeper. No OIDC surface anywhere (INV-AI-13).
 *
 * Exported for the MCP resource server (W3-2) and the sibling units: {@link OAuthTokenService}
 * (`verifyAccessToken`, `revokeGrant`), {@link OAuthPolicyService} (issuer, MCP switch, client
 * allowlist), {@link OAuthAuditService} and {@link PersonalTokensService} (`verify`, the `lan` personal
 * tokens of `personal-tokens/`, W3-4). CIMD (`cimd/`, W3-3) resolves https `client_id`s for the
 * authorization endpoint ({@link CimdClientService}).
 *
 * `PrismaService`, `PermissionResolverService`, `LocalCredentialService` and `PrincipalLoaderService`
 * come from the global Prisma and Auth modules.
 */
@Module({
  controllers: [
    MetadataController,
    AuthorizeController,
    TokenController,
    RegisterController,
    RevokeController,
    GrantsController,
    PersonalTokensController,
  ],
  providers: [
    OAuthPolicyService,
    OAuthSubjectService,
    OAuthAuditService,
    OAuthTokenService,
    AuthorizationService,
    CimdClientService,
    ClientRegistrationService,
    GrantsService,
    OAuthSweeper,
    RegisterRateLimitGuard,
    TokenRateLimitGuard,
    RevokeRateLimitGuard,
    ConsentDecisionRateLimitGuard,
    PersonalTokensService,
  ],
  exports: [
    OAuthTokenService,
    OAuthPolicyService,
    OAuthAuditService,
    PersonalTokensService,
  ],
})
export class OAuthModule {}
