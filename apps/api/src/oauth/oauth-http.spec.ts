jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PrismaService } from '../prisma/prisma.service';
import { ClientRegistrationService } from './client-registration.service';
import {
  MetadataController,
  buildAuthorizationServerMetadata,
  buildProtectedResourceMetadata,
} from './metadata.controller';
import { OAuthPolicyService } from './oauth-policy.service';
import {
  RegisterRateLimitGuard,
  RevokeRateLimitGuard,
  TokenRateLimitGuard,
} from './oauth-rate-limit';
import { OAuthTokenService } from './oauth-token.service';
import { RegisterController } from './register.controller';
import { RevokeController } from './revoke.controller';
import { TokenController } from './token.controller';

/**
 * The public protocol surface over real HTTP (Express + Nest routing): the well-known paths, the
 * form-encoded token endpoint, `no-store`, OAuth error bodies, and 404 when the server is disabled.
 */

const ISSUER = 'https://lazyit.example.com';
const CONFIG = { issuer: ISSUER, resource: `${ISSUER}/mcp` };

describe('OAuth authorization server — HTTP surface', () => {
  let app: INestApplication<App>;
  let mcpEnabled: boolean;
  let tokenService: {
    exchangeAuthorizationCode: jest.Mock;
    refresh: jest.Mock;
    revokeByToken: jest.Mock;
  };
  const savedOrigin = process.env.WEB_ORIGIN;
  const savedMode = process.env.AUTH_MODE;

  beforeEach(async () => {
    process.env.WEB_ORIGIN = ISSUER;
    process.env.AUTH_MODE = 'local';
    mcpEnabled = true;
    tokenService = {
      exchangeAuthorizationCode: jest.fn().mockResolvedValue({
        access_token: 'lzit_oat_x',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'lzit_ort_x',
        scope: 'lazyit.read',
      }),
      refresh: jest.fn(),
      revokeByToken: jest.fn().mockResolvedValue(undefined),
    };
    const prisma = {
      aiSettings: {
        findUnique: jest.fn(() =>
          Promise.resolve({
            mcpEnabled,
            mcpClientAllowlistAdded: [],
            mcpClientAllowlistRemovedDefaults: [],
            mcpAllowAnyHttpsClient: false,
          }),
        ),
      },
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [
        MetadataController,
        TokenController,
        RegisterController,
        RevokeController,
      ],
      providers: [
        OAuthPolicyService,
        { provide: PrismaService, useValue: prisma },
        { provide: OAuthTokenService, useValue: tokenService },
        {
          provide: ClientRegistrationService,
          useValue: { register: jest.fn() },
        },
        RegisterRateLimitGuard,
        TokenRateLimitGuard,
        RevokeRateLimitGuard,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    process.env.WEB_ORIGIN = savedOrigin;
    process.env.AUTH_MODE = savedMode;
  });

  it('serves RFC 8414 metadata at /.well-known/oauth-authorization-server', async () => {
    const response = await request(app.getHttpServer())
      .get('/.well-known/oauth-authorization-server')
      .expect(200);
    expect(response.body).toEqual(buildAuthorizationServerMetadata(CONFIG));
    expect(response.body).toMatchObject({
      issuer: ISSUER,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      authorization_response_iss_parameter_supported: true,
      scopes_supported: ['lazyit.read', 'lazyit.write', 'lazyit.admin'],
    });
  });

  it('serves RFC 9728 metadata at the path-inserted URI for /mcp and at the root alias', async () => {
    for (const path of [
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-protected-resource',
    ]) {
      const response = await request(app.getHttpServer()).get(path).expect(200);
      expect(response.body).toEqual(buildProtectedResourceMetadata(CONFIG));
      expect(
        (response.body as { authorization_servers: string[] })
          .authorization_servers,
      ).toEqual([ISSUER]);
    }
  });

  it('exposes no OIDC surface: no openid-configuration, no id_token, no openid scope', async () => {
    await request(app.getHttpServer())
      .get('/.well-known/openid-configuration')
      .expect(404);
    const metadata = JSON.stringify(buildAuthorizationServerMetadata(CONFIG));
    expect(metadata).not.toMatch(/openid|id_token|userinfo|jwks/i);
  });

  it('answers 404 everywhere while MCP is switched off', async () => {
    mcpEnabled = false;
    const server = app.getHttpServer();
    await request(server)
      .get('/.well-known/oauth-authorization-server')
      .expect(404);
    await request(server)
      .get('/.well-known/oauth-protected-resource/mcp')
      .expect(404);
    await request(server)
      .post('/oauth/token')
      .type('form')
      .send({ grant_type: 'authorization_code' })
      .expect(404);
  });

  it('answers 404 on a plain-HTTP lan instance (no pinned HTTPS issuer)', async () => {
    delete process.env.WEB_ORIGIN;
    await request(app.getHttpServer())
      .get('/.well-known/oauth-authorization-server')
      .expect(404);
    await request(app.getHttpServer())
      .post('/oauth/token')
      .type('form')
      .send({ grant_type: 'authorization_code' })
      .expect(404);
  });

  it('accepts a form-encoded token request and answers no-store with status 200', async () => {
    const response = await request(app.getHttpServer())
      .post('/oauth/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        code: 'abc',
        code_verifier: 'v'.repeat(43),
        client_id: 'lzc_x',
        redirect_uri: 'http://localhost:1/callback',
      })
      .expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(tokenService.exchangeAuthorizationCode).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'abc', client_id: 'lzc_x' }),
      expect.anything(),
    );
  });

  it('answers OAuth-shaped errors: unsupported grant, duplicated parameter', async () => {
    const server = app.getHttpServer();
    const unsupported = await request(server)
      .post('/oauth/token')
      .type('form')
      .send({ grant_type: 'client_credentials' })
      .expect(400);
    expect(unsupported.body).toEqual({ error: 'unsupported_grant_type' });
    expect(unsupported.headers['cache-control']).toBe('no-store');

    const duplicated = await request(server)
      .post('/oauth/token')
      .type('form')
      .send('grant_type=authorization_code&code=a&code=b')
      .expect(400);
    expect(duplicated.body).toMatchObject({ error: 'invalid_request' });
  });

  it('revocation answers 200 with no body', async () => {
    await request(app.getHttpServer())
      .post('/oauth/revoke')
      .type('form')
      .send({ token: 'lzit_ort_x', client_id: 'lzc_x' })
      .expect(200);
    expect(tokenService.revokeByToken).toHaveBeenCalled();
  });

  it('rate-limits the token endpoint per IP', async () => {
    const server = app.getHttpServer();
    let last = 0;
    for (let i = 0; i < 61; i += 1) {
      last = (
        await request(server)
          .post('/oauth/token')
          .type('form')
          .send({ grant_type: 'nope' })
      ).status;
    }
    expect(last).toBe(429);
  });
});
