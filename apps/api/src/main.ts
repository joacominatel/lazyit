import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { validateBootConfig } from './auth/boot-config';
import { loadBootstrapOidcFile } from './auth/bootstrap-file';
import { addStandardErrorResponses } from './common/openapi-errors';
import { parseTrustProxy } from './common/trust-proxy';

async function bootstrap() {
  // Zero-touch bootstrap (ADR-0043 Phase 3): back-fill OIDC_* / ZITADEL_MGMT_PROJECT_ID from the
  // sidecar's oidc-client.json (mounted read-only) for any var the operator did not set, BEFORE
  // validation — so OIDC-mode boot sees the merged env and the bundled-Zitadel flow needs no
  // hand-copied creds. Explicit env always wins; an absent file leaves the env-only path unchanged.
  loadBootstrapOidcFile();
  // Fail-loud config (ops-boot integrity): validate before NestFactory.create so a misconfigured
  // server refuses to start with a CRITICAL log, instead of booting half-wired. See boot-config.ts.
  validateBootConfig();

  // Typed as NestExpressApplication so `app.set('trust proxy', …)` (SEC-010) is available — it
  // configures the underlying Express instance and is not on the platform-agnostic INestApplication.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });
  // Route Nest's own logs through Pino (structured logging — ADR-0031). bufferLogs holds the
  // bootstrap logs until the Pino logger is attached, so nothing is lost or double-formatted.
  app.useLogger(app.get(Logger));
  // Ensure PrismaService.onModuleDestroy runs on SIGTERM/SIGINT (graceful $disconnect).
  app.enableShutdownHooks();

  // Trust proxy (SEC-010): when the API sits behind the Caddy reverse proxy, `req.ip` must be the
  // VERIFIED client — not the client-controllable leftmost X-Forwarded-For token. Express only
  // honours X-Forwarded-For when `trust proxy` is set; with `trust proxy` = N it trusts the N
  // rightmost (proxy-appended) hops and resolves `req.ip` to the first address LEFT of them. Caddy
  // sets a trustworthy client IP (it has `trusted_proxies` for the private Docker network, so a
  // forged XFF from the public client is dropped — see infra/caddy/Caddyfile). TRUST_PROXY is the
  // hop count (Caddy = "1"); when unset (dev, no proxy) we leave it OFF so `req.ip` stays the socket
  // address and a spoofed XFF is ignored entirely — preserving the existing dev behaviour.
  const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
  app.set('trust proxy', trustProxy);

  // CORS for the web app. Origin is read from WEB_ORIGIN (default: the Next.js dev server)
  // so it is never hardcoded. credentials:true is set ahead of cookie/session auth (deferred,
  // ADR-0016); with credentials the origin must be explicit, never "*". allowedHeaders is left
  // unset so cors reflects the requested headers (covers Content-Type, Authorization, …).
  // exposedHeaders surfaces X-Request-Id (ADR-0031) to the browser so the client can quote it in
  // error UX — cross-origin responses hide non-safelisted headers from JS unless exposed.
  app.enableCors({
    origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    exposedHeaders: ['X-Request-Id'],
    credentials: true,
  });

  // OpenAPI: schemas come from the zod DTOs; cleanupOpenApiDoc is required for correct output.
  // Swagger UI at /api/docs, raw OpenAPI JSON at /api/docs-json. See ADR-0018.
  //
  // SEC-009: mount Swagger ONLY when NODE_ENV !== 'production'. Now that every non-@Public() route
  // requires a Bearer JWT (DEF-001 resolved, ADR-0038), the anonymous OpenAPI doc would be the one
  // public surface enumerating the full authenticated attack surface. Not serving it in production
  // (belt) — combined with Caddy no longer proxying /api/docs* to the public origin (suspenders) —
  // keeps it reachable only on the internal network and in local dev (DX unchanged where
  // NODE_ENV !== production).
  if (process.env.NODE_ENV !== 'production') {
    // addBearerAuth() surfaces the Authorization: Bearer <token> scheme in the Swagger UI (ADR-0038).
    const config = new DocumentBuilder()
      .setTitle('lazyit API')
      .setDescription(
        'Self-hosted IT asset, access, ticket and knowledge-base API.',
      )
      .setVersion('0.1')
      // addBearerAuth() only DEFINES the scheme; addSecurityRequirements applies it GLOBALLY so every
      // operation documents the Authorization: Bearer requirement (ADR-0038). This replaces the
      // inconsistent per-controller @ApiBearerAuth() decorators — one source, applied everywhere. The
      // few @Public() routes (health probes) inherit it as harmless doc-only noise.
      .addBearerAuth()
      .addSecurityRequirements('bearer')
      .build();
    // cleanupOpenApiDoc renders the zod DTOs correctly; then add the standard error contract once,
    // globally (ApiError schema + 400/401/403/404/409/500 per operation) — ADR-0018.
    const document = addStandardErrorResponses(
      cleanupOpenApiDoc(SwaggerModule.createDocument(app, config)),
    );
    SwaggerModule.setup('api/docs', app, document);
  }

  await app.listen(process.env.PORT ?? 3001);
}

// Only boot when run as the entry point (e.g. `nest start`); importing this module (config specs)
// must not start the server. Under ts-jest (CommonJS) `require.main` is the jest runner, not main.ts.
if (require.main === module) {
  void bootstrap();
}
