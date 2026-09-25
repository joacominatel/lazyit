import { randomUUID } from 'node:crypto';
import { Injectable, Logger, type Type } from '@nestjs/common';
import type { AiActionPreview, AiToolResult } from '@lazyit/shared';
import { mapToolError } from './error-mapper';
import { runInAiInvocation } from './invocation-context';
import { resolveReference } from './reference-resolver';
import { callKindOf, errorResult, successResult } from './result-shaper';
import { messagePhrase, phrase } from './sentences';
import { AiToolDispatcher } from './tool-dispatcher';
import type {
  AiExecutionContext,
  AiToolRuntime,
  HttpShape,
  RegisteredAiTool,
} from './tool-descriptor';

/** A tool called a handler it did not declare in `bindings` — a bug in the tool, never a user error. */
export class AiToolBindingError extends Error {
  constructor(tool: string, handler: string) {
    super(`AI tool ${tool} called ${handler}, which is not in its bindings`);
    this.name = 'AiToolBindingError';
  }
}

export type AiToolInputCheck =
  | { ok: true; input: unknown }
  | { ok: false; result: AiToolResult };

/**
 * Executes one registered tool (tools-and-execution.md §8.2). No policy lives here — who may call what,
 * through which channel, is the {@link AiToolService}'s job; this is the mechanism:
 *   1. validate the input with the tool's zod schema — BEFORE anything is dispatched. The AI SDK's
 *      `jsonSchema()` does not validate tool input (W1-B spike finding 2), so this is the only validation;
 *   2. run the tool inside the AsyncLocalStorage invocation context (the history writers stamp
 *      `aiInvocationId` from it);
 *   3. every `rt.call` goes through the {@link AiToolDispatcher}: Nest's own guards and pipes, as the
 *      delegated principal;
 *   4. shape the outcome into an `AiToolResult` (truncated once), mapping exceptions to tool errors.
 *
 * Exported for the approval path, which executes an approved write through `execute` after its own
 * checks. Channels call the {@link AiToolService}, never this directly.
 */
@Injectable()
export class AiToolExecutor {
  private readonly logger = new Logger(AiToolExecutor.name);

  constructor(private readonly dispatcher: AiToolDispatcher) {}

  /**
   * Parse `rawInput` with the tool's schema, after the tool's own `normalizeInput` when it has one; an
   * invalid input becomes an `INVALID_INPUT` result.
   */
  validate(tool: RegisteredAiTool, rawInput: unknown): AiToolInputCheck {
    const { descriptor } = tool;
    const parsed = descriptor.input.safeParse(
      descriptor.normalizeInput
        ? descriptor.normalizeInput(rawInput)
        : rawInput,
    );
    if (parsed.success) {
      return { ok: true, input: parsed.data };
    }
    const message = parsed.error.issues
      .slice(0, 5)
      .map((issue) =>
        issue.path.length > 0
          ? `${issue.path.map(String).join('.')}: ${issue.message}`
          : issue.message,
      )
      .join('; ');
    return {
      ok: false,
      result: errorResult(callKindOf(tool.descriptor.class), {
        code: 'INVALID_INPUT',
        ...messagePhrase(phrase('refusal.invalidInput', { detail: message })),
      }),
    };
  }

  /** Validate, then run the tool as `ctx.identity`. Never throws: every failure is a result. */
  async execute(
    tool: RegisteredAiTool,
    rawInput: unknown,
    ctx: AiExecutionContext,
    options: { invocationId?: string } = {},
  ): Promise<AiToolResult> {
    const checked = this.validate(tool, rawInput);
    if (!checked.ok) {
      return checked.result;
    }
    const invocationId = options.invocationId ?? randomUUID();
    const rt = this.runtime(tool, ctx, invocationId);
    try {
      const output = await runInAiInvocation(
        {
          invocationId,
          channel: ctx.channel,
          conversationId: ctx.conversationId,
          runId: ctx.runId,
        },
        () => tool.descriptor.run(checked.input, rt),
      );
      return successResult(tool.descriptor.class, output);
    } catch (err) {
      return this.failure(tool, err);
    }
  }

  /**
   * Build the server-side preview of a write (synthesis §4.3) for an already-validated input. Runs
   * through the same dispatcher, so reading the target is authorized exactly like the route.
   */
  async preview(
    tool: RegisteredAiTool,
    input: unknown,
    ctx: AiExecutionContext,
    invocationId: string,
  ): Promise<AiActionPreview> {
    const descriptor = tool.descriptor;
    if (typeof descriptor.preview !== 'function') {
      throw new Error(`AI tool ${descriptor.name} has no preview`);
    }
    const toolClass = descriptor.class;
    if (toolClass !== 'write' && toolClass !== 'elevated') {
      throw new Error(`AI tool ${descriptor.name} is not a write`);
    }
    const rt = this.runtime(tool, ctx, invocationId);
    const preview = await runInAiInvocation(
      {
        invocationId,
        channel: ctx.channel,
        conversationId: ctx.conversationId,
        runId: ctx.runId,
      },
      () => descriptor.preview!(input, rt),
    );
    // The class is a floor (synthesis §4.1): a preview may escalate to `elevated`, never below the class.
    return {
      ...preview,
      toolName: descriptor.name,
      class: toolClass,
      elevated: preview.elevated || toolClass === 'elevated',
    };
  }

  private runtime(
    tool: RegisteredAiTool,
    ctx: AiExecutionContext,
    invocationId: string,
  ): AiToolRuntime {
    const dispatcher = this.dispatcher;
    const bindings = tool.descriptor.bindings;
    return {
      ctx: Object.freeze({ ...ctx, invocationId }),
      call<C, M extends keyof C & string>(
        controller: Type<C>,
        method: M,
        shape?: HttpShape,
      ) {
        const ref = bindings.find(
          (b) => b.controller === controller && b.method === method,
        );
        if (!ref) {
          return Promise.reject(
            new AiToolBindingError(
              tool.descriptor.name,
              `${controller.name}.${method}`,
            ),
          );
        }
        return dispatcher.dispatch(ref, ctx.identity, shape) as never;
      },
      resolve: resolveReference,
    };
  }

  private failure(tool: RegisteredAiTool, err: unknown): AiToolResult {
    const mapped = mapToolError(err);
    if (mapped.code === 'INTERNAL') {
      this.logger.error(
        `AI tool ${tool.descriptor.name} failed: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
    }
    return errorResult(callKindOf(tool.descriptor.class), mapped);
  }
}
