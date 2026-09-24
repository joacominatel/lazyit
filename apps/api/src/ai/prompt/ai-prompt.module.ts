import { Injectable, Module } from '@nestjs/common';
import {
  buildMcpInstructions,
  buildSystemPrompt,
  buildTurnContext,
  type BuiltSystemPrompt,
  type SystemPromptInput,
  type TurnContextInput,
} from './system-prompt';

/**
 * The injectable face of the prompt builders, so the runtime (W2-3) and `/mcp` (W3-2) can take it by
 * DI and tests can mock it. Stateless: every method delegates to a pure function in `system-prompt.ts`,
 * which other code (the skill renderer, W3-5) may also import directly with `LAZYIT_DOMAIN_PRIMER`.
 */
@Injectable()
export class AiPromptService {
  systemPrompt(input: SystemPromptInput): BuiltSystemPrompt {
    return buildSystemPrompt(input);
  }

  turnContext(input: TurnContextInput): string {
    return buildTurnContext(input);
  }

  mcpInstructions(): string {
    return buildMcpInstructions();
  }
}

/**
 * The domain primer (`LAZYIT_DOMAIN_PRIMER`) and the system-prompt builder, shared by the runtime, the
 * MCP `instructions` and the skill (ADR-0097; docs/ai-assistant/tools-and-execution.md §12).
 */
@Module({
  providers: [AiPromptService],
  exports: [AiPromptService],
})
export class AiPromptModule {}
