import { Module } from '@nestjs/common';
import { ALL_TOOLSETS } from '../tools';
import { AiToolService } from './ai-tool.service';
import { AiToolDispatcher } from './tool-dispatcher';
import { AiToolExecutor } from './tool-executor';
import { AI_TOOLSETS, AiToolRegistry } from './tool-registry';

/**
 * The AI core (ADR-0097; synthesis §5): the tool registry, the in-process dispatcher, the executor and
 * the {@link AiToolService} façade. Every channel — the runtime (chat, headless) and `/mcp` — reaches
 * tools only through the exports below.
 *
 * `PrincipalLoaderService` and `PermissionResolverService` come from the global AuthModule.
 */
@Module({
  providers: [
    { provide: AI_TOOLSETS, useValue: ALL_TOOLSETS },
    AiToolDispatcher,
    AiToolRegistry,
    AiToolExecutor,
    AiToolService,
  ],
  exports: [AiToolService, AiToolExecutor, AiToolRegistry],
})
export class AiCoreModule {}
