import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { AiToolRegistryError, validateToolsets } from './boot-validation';
import { AiToolDispatcher } from './tool-dispatcher';
import type { AiToolset, RegisteredAiTool } from './tool-descriptor';

/** DI token for the toolsets the registry serves (`ai/tools/index.ts` in the app; fixtures in tests). */
export const AI_TOOLSETS = Symbol('AI_TOOLSETS');

/**
 * The ONE tool catalog every channel serves (R4). Built and validated at boot: `validateToolsets` checks
 * every descriptor and binding (`boot-validation.ts`), then every binding is resolved against the running
 * application — a controller that is not registered, or is request-scoped, fails the boot too. The API
 * refuses to start rather than serve a bad catalog.
 */
@Injectable()
export class AiToolRegistry implements OnModuleInit {
  private tools = new Map<string, RegisteredAiTool>();

  constructor(
    @Inject(AI_TOOLSETS) private readonly toolsets: readonly AiToolset[],
    private readonly dispatcher: AiToolDispatcher,
  ) {}

  onModuleInit(): void {
    const registered = validateToolsets(this.toolsets);
    const problems: string[] = [];
    for (const tool of registered) {
      for (const ref of tool.descriptor.bindings) {
        try {
          this.dispatcher.resolve(ref);
        } catch (err) {
          problems.push(
            `tool ${tool.descriptor.name}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
    if (problems.length > 0) {
      throw new AiToolRegistryError(problems);
    }
    // Deterministic order (MCP `tools/list` SHOULD be stable).
    this.tools = new Map(
      [...registered]
        .sort((a, b) => a.descriptor.name.localeCompare(b.descriptor.name))
        .map((tool) => [tool.descriptor.name, tool]),
    );
  }

  /** A registered tool by name. */
  get(name: string): RegisteredAiTool | undefined {
    return this.tools.get(name);
  }

  /** Every registered tool, ordered by name. */
  all(): readonly RegisteredAiTool[] {
    return [...this.tools.values()];
  }
}
