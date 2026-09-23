import type {
  AiCallKind,
  AiToolClass,
  AiToolErrorCode,
  AiToolResult,
} from '@lazyit/shared';
import { AI_TOOL_RESULT_MAX_CHARS } from '../ai.constants';
import type { AiToolRunOutput } from './tool-descriptor';

/** The call kind a tool class produces (R3). */
export function callKindOf(toolClass: AiToolClass): AiCallKind {
  if (toolClass === 'navigate') return 'navigate';
  if (toolClass === 'read') return 'read';
  return 'mutation';
}

const TAG = /<\/?untrusted_content>/gi;

/**
 * Wrap other-authored free text (a note, an excerpt, a description) in `<untrusted_content>` delimiters —
 * defence in depth for the model, which is told such text is data, never instructions (INV-AI-4). Any
 * delimiter already inside the text is neutralized so content cannot close the wrapper early.
 */
export function untrusted(text: string | null | undefined): string | null {
  if (text === null || text === undefined || text.length === 0) return null;
  const neutralized = text.replace(TAG, (tag) => tag.replace('<', '&lt;'));
  return `<untrusted_content>${neutralized}</untrusted_content>`;
}

/**
 * A successful result. Truncated ONCE, here, at write time (synthesis §4.3): past
 * {@link AI_TOOL_RESULT_MAX_CHARS} serialized characters the data is replaced by its serialized prefix
 * and `truncated` records how much was shown. Tools should paginate so this is a backstop.
 */
export function successResult(
  toolClass: AiToolClass,
  output: AiToolRunOutput,
): AiToolResult {
  const kind = callKindOf(toolClass);
  const serialized = JSON.stringify(output.data ?? null);
  const overLimit = serialized.length > AI_TOOL_RESULT_MAX_CHARS;
  return {
    ok: true,
    kind,
    data: overLimit
      ? serialized.slice(0, AI_TOOL_RESULT_MAX_CHARS)
      : (output.data ?? null),
    ...(output.summary !== undefined ? { summary: output.summary } : {}),
    mutated: kind === 'mutation',
    ...(overLimit
      ? {
          truncated: {
            shown: AI_TOOL_RESULT_MAX_CHARS,
            total: serialized.length,
          },
        }
      : output.truncated
        ? { truncated: output.truncated }
        : {}),
    entityRefs: output.entityRefs ?? [],
  };
}

/** A failed result. A failure never mutated anything. */
export function errorResult(
  kind: AiCallKind,
  error: { code: AiToolErrorCode; status?: number; message: string },
): AiToolResult {
  return {
    ok: false,
    kind,
    error: {
      code: error.code,
      ...(error.status !== undefined ? { status: error.status } : {}),
      message: error.message,
    },
    mutated: false,
    entityRefs: [],
  };
}
