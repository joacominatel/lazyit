import {
  MCP_CLIENT_ALLOWLIST_CURATED_DEFAULTS,
  McpClientAllowlistEntrySchema,
  type McpClientAllowlistEntry,
} from '@lazyit/shared';

/**
 * The CURATED DEFAULT MCP client allowlist (ADR-0097 decision 13), as the authorization server matches
 * it. The data lives in `@lazyit/shared` (`MCP_CLIENT_ALLOWLIST_CURATED_DEFAULTS`) so Settings → AI can
 * list the same entries; this module strips the display metadata (`verification`, `source`) and keeps
 * only `{ id, label, match }`. See the shared constant for the matching rules and what is not seeded.
 */
export const MCP_CLIENT_ALLOWLIST_DEFAULTS: readonly McpClientAllowlistEntry[] =
  Object.freeze(
    MCP_CLIENT_ALLOWLIST_CURATED_DEFAULTS.map((entry) =>
      McpClientAllowlistEntrySchema.parse(entry),
    ),
  );
