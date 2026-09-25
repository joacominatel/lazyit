/**
 * Wires the OAuth authorization server's real services over {@link FakeOAuthPrisma} for Jest: the
 * policy, subject, audit, token, authorization, registration and grants services exactly as the module
 * builds them, with only the permission resolver and the password verifier stubbed.
 */

/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/require-await -- test wiring over an untyped fake */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Permission } from '@lazyit/shared';
import { PrincipalLoaderService } from '../../src/auth/principal-loader.service';
import type { HumanPrincipal } from '../../src/auth/principal';
import { PasswordStepUpVerifier } from '../../src/auth/local/password-step-up.verifier';
import { AuthorizationService } from '../../src/oauth/authorization.service';
import { CimdClientService } from '../../src/oauth/cimd/cimd-client.service';
import { ClientRegistrationService } from '../../src/oauth/client-registration.service';
import { GrantsService } from '../../src/oauth/grants.service';
import { OAuthAuditService } from '../../src/oauth/oauth-audit.service';
import { OAuthPolicyService } from '../../src/oauth/oauth-policy.service';
import { OAuthSubjectService } from '../../src/oauth/oauth-subject.service';
import { OAuthTokenService } from '../../src/oauth/oauth-token.service';
import { FakeOAuthPrisma } from './fake-oauth-prisma';

export const ISSUER = 'https://lazyit.example.com';
export const RESOURCE = `${ISSUER}/mcp`;
export const PASSWORD = 'correct horse battery staple';

export interface Harness {
  prisma: FakeOAuthPrisma;
  policy: OAuthPolicyService;
  subjects: OAuthSubjectService;
  tokens: OAuthTokenService;
  authorization: AuthorizationService;
  registrations: ClientRegistrationService;
  grants: GrantsService;
  /** CIMD resolution; its `fetchOptions` default to a transport that fails, so no test reaches the network. */
  cimd: CimdClientService;
  /** Permissions per role; MEMBER holds ai:connect unless a test removes it. */
  rolePermissions: Map<string, Set<Permission>>;
  credentials: { verify: jest.Mock };
  /** The shared password step-up primitive (SEC-082) over {@link credentials}. */
  stepUp: PasswordStepUpVerifier;
}

export function buildHarness(): Harness {
  const prisma = new FakeOAuthPrisma();
  const rolePermissions = new Map<string, Set<Permission>>([
    ['ADMIN', new Set<Permission>(['ai:connect', 'settings:manage'])],
    ['MEMBER', new Set<Permission>(['ai:connect'])],
    ['VIEWER', new Set<Permission>()],
  ]);
  const permissions = {
    resolve: jest.fn(
      async (role: string) => rolePermissions.get(role) ?? new Set(),
    ),
  };
  const credentials = {
    verify: jest.fn(async (hash: string | null, password: string) => ({
      valid: hash === 'argon2-hash' && password === PASSWORD,
      needsRehash: false,
    })),
  };
  const db = prisma as any;
  const policy = new OAuthPolicyService(db);
  const subjects = new OAuthSubjectService(db, permissions as any);
  const audit = new OAuthAuditService(db);
  const tokens = new OAuthTokenService(
    db,
    policy,
    subjects,
    new PrincipalLoaderService(db),
    audit,
  );
  const cimd = new CimdClientService(db, audit);
  cimd.fetchOptions = {
    lookup: async () => [{ address: '93.184.215.14', family: 4 }],
    transport: async () => {
      throw new Error('network disabled in tests');
    },
  };
  const stepUp = new PasswordStepUpVerifier(credentials as any);
  const authorization = new AuthorizationService(
    db,
    policy,
    subjects,
    stepUp,
    audit,
    cimd,
  );
  const registrations = new ClientRegistrationService(db, policy, audit);
  const grants = new GrantsService(db, permissions as any, tokens, policy);
  return {
    prisma,
    policy,
    subjects,
    tokens,
    authorization,
    registrations,
    grants,
    cimd,
    rolePermissions,
    credentials,
    stepUp,
  };
}

/** Point the environment at an HTTPS local-mode instance (the only kind with an authorization server). */
export function useHttpsInstance(): void {
  process.env.WEB_ORIGIN = ISSUER;
  process.env.AUTH_MODE = 'local';
}

export function enableMcp(
  h: Harness,
  overrides: Record<string, unknown> = {},
): void {
  h.prisma.tables.aiSettings = [
    {
      id: 'singleton',
      mcpEnabled: true,
      mcpClientAllowlistAdded: [],
      mcpClientAllowlistRemovedDefaults: [],
      mcpAllowAnyHttpsClient: false,
      ...overrides,
    },
  ];
}

export function seedUser(
  h: Harness,
  overrides: Record<string, unknown> = {},
): any {
  const user = {
    id: randomUUID(),
    email: `user-${Math.random().toString(36).slice(2)}@example.com`,
    role: 'MEMBER',
    isActive: true,
    directoryOnly: false,
    mustChangePassword: false,
    sessionEpoch: 0,
    mcpCredentialEpoch: 0,
    passwordHash: 'argon2-hash',
    deletedAt: null,
    ...overrides,
  };
  h.prisma.tables.user.push(user);
  return user;
}

export function human(user: any): HumanPrincipal {
  return { kind: 'human', user };
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export const CLAUDE_CODE_REDIRECT = 'http://localhost:53682/callback';

/** Register a DCR client (default: Claude Code's loopback redirect, allowlisted by default). */
export async function registerClient(
  h: Harness,
  redirectUris: string[] = [CLAUDE_CODE_REDIRECT],
  clientName = 'Claude Code',
): Promise<string> {
  const response = await h.registrations.register({
    client_name: clientName,
    redirect_uris: redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_method: 'none',
  });
  return response.client_id;
}

export interface AuthorizeOptions {
  clientId: string;
  redirectUri?: string;
  scope?: string;
  grantScopes?: string[];
  password?: string;
  resource?: string;
}

/** Run consent (approve) and return the issued code, the verifier and the redirect. */
export async function authorize(
  h: Harness,
  user: any,
  options: AuthorizeOptions,
): Promise<{
  code: string;
  verifier: string;
  redirectTo: string;
  redirectUri: string;
}> {
  const { verifier, challenge } = pkcePair();
  const redirectUri = options.redirectUri ?? CLAUDE_CODE_REDIRECT;
  const params = {
    response_type: 'code',
    client_id: options.clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz',
    scope: options.scope ?? 'lazyit.read lazyit.write',
    resource: options.resource ?? RESOURCE,
  };
  const { redirectTo } = await h.authorization.decision(human(user), {
    params,
    decision: 'approve',
    scopes: options.grantScopes ?? ['lazyit.read', 'lazyit.write'],
    ...(options.password ? { password: options.password } : {}),
  });
  const code = new URL(redirectTo).searchParams.get('code');
  if (!code) throw new Error(`no code in ${redirectTo}`);
  return { code, verifier, redirectTo, redirectUri };
}

/** Full flow: register, consent, exchange. */
export async function connect(
  h: Harness,
  user: any,
  options: Partial<AuthorizeOptions> = {},
) {
  const clientId = options.clientId ?? (await registerClient(h));
  const { code, verifier, redirectUri } = await authorize(h, user, {
    ...options,
    clientId,
  });
  const tokens = await h.tokens.exchangeAuthorizationCode({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: clientId,
    redirect_uri: redirectUri,
    resource: RESOURCE,
  });
  return { clientId, tokens };
}
