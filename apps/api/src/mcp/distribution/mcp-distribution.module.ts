import { Module } from '@nestjs/common';
import { AiCoreModule } from '../../ai/core/ai-core.module';
import { OAuthModule } from '../../oauth/oauth.module';
import { PluginDistributionController } from './plugin-distribution.controller';
import { PluginDistributionService } from './plugin-distribution.service';

/**
 * The Claude Code skill/plugin distribution (W3-5; ADR-0097 decision 10; mcp-and-oauth.md §5.5), imported
 * by `McpModule`. It reads the live tool registry (`AiCoreModule`) and the MCP switch through the
 * authorization server's policy (`OAuthModule`).
 */
@Module({
  imports: [AiCoreModule, OAuthModule],
  controllers: [PluginDistributionController],
  providers: [PluginDistributionService],
})
export class McpDistributionModule {}
