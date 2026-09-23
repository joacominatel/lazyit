import { Module } from '@nestjs/common';

/**
 * lazyit's OAuth 2.1 authorization server for MCP clients (ADR-0097; docs/ai-assistant/_synthesis.md
 * §4.8, R7): metadata, authorize/consent, token, dynamic registration, revocation, grants, CIMD and the
 * `lan`-only personal tokens.
 *
 * Pre-created empty by the AI core unit (synthesis §10) so its units (W2-4, W3-3, W3-4) fill it without
 * touching `app.module.ts`. It registers no route until then.
 */
@Module({})
export class OAuthModule {}
