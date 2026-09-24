import type { ToolAnnotations } from '@modelcontextprotocol/server';
import type { AiToolClass } from '@lazyit/shared';
import type { AiToolListing } from '../ai/core/tool-descriptor';

/** The classes MCP ever lists. `navigate` is chat-only (R4): it is never listed, whatever its channels. */
export function isMcpListable(toolClass: AiToolClass): boolean {
  return toolClass !== 'navigate';
}

/**
 * MCP tool annotations derived from the tool's class and registry flags (R4; mcp-and-oauth.md §5.3,
 * F12) — never hand-declared per tool. Every hint is set EXPLICITLY, because the spec's defaults are the
 * dangerous ones: an omitted `destructiveHint` means destructive and an omitted `openWorldHint` means
 * open-world.
 *
 * | class                         | readOnly | destructive | idempotent      | openWorld         |
 * | `read`                        | true     | false       | true            | false             |
 * | `write`, additive             | false    | false       | registry value  | `externalEffects` |
 * | `write`, `destructive: true`  | false    | true        | registry value  | `externalEffects` |
 * | `elevated`                    | false    | true        | registry value  | `externalEffects` |
 *
 * A read is idempotent by definition, and never open-world here: lazyit's reads never reach outside.
 * Clients treat annotations as untrusted hints (ChatGPT confirms every non-read-only tool, Claude Code
 * prompts per tool); the server re-checks everything on every call regardless.
 */
export function toMcpAnnotations(tool: AiToolListing): ToolAnnotations {
  if (tool.class === 'read') {
    return {
      title: tool.title,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    };
  }
  return {
    title: tool.title,
    readOnlyHint: false,
    destructiveHint:
      tool.class === 'elevated' || tool.annotations.destructiveHint,
    idempotentHint: tool.annotations.idempotentHint,
    openWorldHint: tool.annotations.openWorldHint,
  };
}
