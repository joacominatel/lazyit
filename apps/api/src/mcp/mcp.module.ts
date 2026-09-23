import { Module } from '@nestjs/common';

/**
 * The MCP resource server at `/mcp` and the Claude Code skill/plugin distribution (ADR-0097;
 * docs/ai-assistant/_synthesis.md §4.7–§4.9). Tools are reached only through the AI core's
 * `AiToolService`.
 *
 * Pre-created empty by the AI core unit (synthesis §10) so its units (W3-2, W3-5) fill it without touching
 * `app.module.ts`. It registers no route until then.
 */
@Module({})
export class McpModule {}
