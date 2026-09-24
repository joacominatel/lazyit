import { Module } from '@nestjs/common';
import { ALL_TOOLSETS } from '../tools';
import { AiActionLogService } from './action-log.service';
import { AiToolService } from './ai-tool.service';
import { AiToolDispatcher } from './tool-dispatcher';
import { AiToolExecutor } from './tool-executor';
import { AI_TOOLSETS, AiToolRegistry } from './tool-registry';

/**
 * The AI core (ADR-0097; synthesis §5): the tool registry, the in-process dispatcher, the executor, the
 * `AiActionLog` writer and the {@link AiToolService} façade (reads, ledger-backed writes, and the
 * propose / approve / reject lifecycle). Every channel — the runtime (chat, headless) and `/mcp` — reaches
 * tools only through the exports below.
 *
 * `PrincipalLoaderService` and `PermissionResolverService` come from the global AuthModule, `PrismaService`
 * from the global PrismaModule. The settings port (`AI_SETTINGS_READER`) is resolved lazily, so core does
 * not import the settings module.
 */
@Module({
  providers: [
    { provide: AI_TOOLSETS, useValue: ALL_TOOLSETS },
    AiToolDispatcher,
    AiToolRegistry,
    AiToolExecutor,
    AiActionLogService,
    AiToolService,
  ],
  exports: [AiToolService, AiToolExecutor, AiToolRegistry],
})
export class AiCoreModule {}
