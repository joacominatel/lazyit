import { Module } from '@nestjs/common';
import { AiCoreModule } from '../ai/core/ai-core.module';
import { AiPromptModule } from '../ai/prompt/ai-prompt.module';
import { AiRunPrincipals } from '../ai/runtime/principal-context';
import { NotificationsModule } from '../notifications/notifications.module';
import { OAuthModule } from '../oauth/oauth.module';
import { McpAuthGuard } from './mcp-auth.guard';
import { McpConnectionNoticeService } from './mcp-connection-notice.service';
import { McpExposedTokenService } from './mcp-exposed-token.service';
import { McpInvocationSweeper } from './mcp-invocation.sweeper';
import { McpRateLimiter } from './mcp-rate-limit';
import { McpServerFactory } from './mcp-server.factory';
import { McpController } from './mcp.controller';
import { McpDistributionModule } from './distribution/mcp-distribution.module';

/**
 * The MCP resource server at `/mcp` and the Claude Code skill/plugin distribution (ADR-0097 decisions
 * 9–10; docs/ai-assistant/_synthesis.md §4.7–§4.9; mcp-and-oauth.md §5.3–§5.5, §13–§14). Tools are reached
 * only through the AI core's `AiToolService`.
 *
 *   - `McpController` — `/mcp`, the SDK v2 stateless handler inside Nest;
 *   - `McpAuthGuard` — OAuth access tokens (HTTPS), personal tokens (`lan`), Service Accounts holding
 *     `ai:connect`; the RFC 6750/9728 challenge; 404 while MCP is off;
 *   - `McpServerFactory` — the per-caller server: listing under the scope ceiling, annotations, results;
 *   - `McpRateLimiter`, `McpConnectionNoticeService` (the first-use security notice) and
 *     `McpInvocationSweeper` (interrupted MCP writes → `OUTCOME_UNKNOWN`).
 *
 * `AiRunPrincipals` is provided here for its read-tolerant per-SA AI access lookup (stateless; its
 * collaborators are global). `McpDistributionModule` (`distribution/`, W3-5) serves the Claude Code plugin.
 */
@Module({
  imports: [
    AiCoreModule,
    AiPromptModule,
    OAuthModule,
    NotificationsModule,
    McpDistributionModule,
  ],
  controllers: [McpController],
  providers: [
    McpAuthGuard,
    McpServerFactory,
    McpRateLimiter,
    McpConnectionNoticeService,
    McpExposedTokenService,
    McpInvocationSweeper,
    AiRunPrincipals,
  ],
})
export class McpModule {}
