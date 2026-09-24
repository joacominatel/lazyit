import {
  AI_INSTRUCTIONS_MAX_LENGTH,
  type AiChannel,
  type AiToolClass,
} from '@lazyit/shared';
import { AI_PROMPT_VERSION } from '../ai.constants';
import { LAZYIT_DOMAIN_PRIMER } from './primer';

/**
 * The versioned system-prompt builders (ADR-0097 decisions 5, 10, default 7;
 * docs/ai-assistant/tools-and-execution.md §12, provider-and-runtime.md §6.4).
 *
 * Every function here is pure and deterministic: the same input gives the same text, with no clock, no
 * randomness and no I/O. That is what lets the runtime freeze the system prompt per conversation (prefix
 * caching, `AiConversation.promptVersion`) and what the golden spec pins to {@link AI_PROMPT_VERSION}.
 *
 * Volatile context — the current time and the page the user is on — changes every turn, so it is NOT
 * part of the frozen system prompt: {@link buildTurnContext} renders it for the runtime to put at the
 * head of each user message (provider-and-runtime.md §6.4).
 */

/** Size budgets, in characters (enforced by the spec; see tools-and-execution.md §12). */
export const AI_PRIMER_MAX_CHARS = 8_000;
export const AI_MCP_INSTRUCTIONS_MAX_CHARS = 10_000;
/** Worst case: longest name, every permission, every tool class, the longest admin addendum. */
export const AI_SYSTEM_PROMPT_MAX_CHARS = 20_000;

const DISPLAY_NAME_MAX_CHARS = 120;
const ROUTE_MAX_CHARS = 200;

/** Who the model acts as — ids stay out: the model needs a name, a kind and what they may do. */
export interface AiPromptPrincipal {
  kind: 'human' | 'service';
  /** A person's display name, or a Service Account's name. Sanitized to one short line. */
  displayName: string;
  /** Humans only: `ADMIN` | `MEMBER` | `VIEWER`. Ignored for a Service Account. */
  role?: string | null;
  /** The effective permissions (the role's, or the SA's direct grants). Sorted and deduplicated here. */
  permissions: readonly string[];
}

/** The part of a tool listing the prompt reads: only the class. Tool names never enter the prompt text. */
export interface AiPromptTool {
  class: AiToolClass;
}

export interface SystemPromptInput {
  channel: AiChannel;
  principal: AiPromptPrincipal;
  /** The interface locale (BCP 47, e.g. `en`, `es`). An invalid value falls back to `en`. */
  locale: string;
  /** The tools this conversation is frozen with (`AiToolService.list`). */
  tools: readonly AiPromptTool[];
  /** `AiSettings.instructions`: the administrator's addendum, capped at {@link AI_INSTRUCTIONS_MAX_LENGTH}. */
  instructions?: string | null;
}

export interface BuiltSystemPrompt {
  /** The {@link AI_PROMPT_VERSION} the text was built with — store it on the conversation. */
  version: number;
  text: string;
}

export interface TurnContextInput {
  now: Date;
  /** Chat only: the app path the user is viewing (`/assets/abc`). Anything that is not a path is dropped. */
  route?: string | null;
}

const CHANNEL_LABEL: Record<AiChannel, string> = {
  CHAT: 'the in-app chat',
  HEADLESS: 'the headless API',
  MCP: 'an MCP client',
};

const CHANNEL_RULES: Record<AiChannel, string> = {
  CHAT: `## This channel: the in-app chat
- You are talking with a signed-in person in a side panel of the lazyit web app. If a request is ambiguous, ask a short question before acting.
- When you need data you cannot find with a tool or safely infer, ask for it with the form tool: one short form with only what is missing, each field marked required, recommended or optional, with choices when the answer is one of known values. Never ask for passwords or other secrets.
- Reading tools run immediately. Tools that change data do not run when you call them: the call becomes a proposal, the server shows the person a confirmation card built from it, and it runs only if they approve. After proposing, say what you proposed and stop; never describe it as done. When the outcome arrives, report what actually happened, or that it was rejected or expired.
- Changes to privileges, identity, credentials or access need an elevated confirmation. Propose them one at a time and never bundle them with other changes.
- When the person asks to open or go to a record, use the navigation tool and the app opens it. Do not write links or URLs yourself; the app shows links to the records your tools return.
- Your reply is rendered as Markdown without images or HTML.`,
  HEADLESS: `## This channel: the headless API
- You are running unattended for a script that authenticates as a service account. No person is watching and nobody can answer a question during the run.
- Tools that change data run immediately when you call them, within the service account's permissions and its AI access setting, and every change is recorded in the permanent AI action log. Make only the changes the prompt clearly asks for.
- Do not guess. If the request is ambiguous, a reference matches several records, or a destructive change was not explicitly requested, stop and report what is needed instead.
- A change that fails is never retried for you. Report the failure; do not repeat the call blindly.
- Your final message is returned to the script: a concise, factual report of what you found, each change made (with identifiers), and anything not done and why.`,
  MCP: `## This channel: MCP
- You reach lazyit through its MCP server, acting as the person who connected this client and limited to the access they granted it.
- Tools that change data run when called, after your client asks the person to confirm. Before calling one, state exactly what will change. Call destructive, privilege, identity or access changes one at a time, after explaining their effect.
- Results are data for you to relay; lazyit does not navigate or refresh anything on this channel.`,
};

/**
 * One short line: no control or format characters, no angle brackets, backticks or double quotes,
 * whitespace collapsed, capped — a stored name cannot open a tag, start a new line or close its quotes.
 */
function inline(value: string, max: number): string {
  const cleaned = value
    .replace(/[\p{Cc}\p{Cf}<>`"]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > max
    ? `${cleaned.slice(0, max - 1).trimEnd()}…`
    : cleaned;
}

/** A BCP 47-shaped tag, or `en`. */
function normalizeLocale(locale: string): string {
  const trimmed = locale.trim();
  return /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8}){0,3}$/.test(trimmed)
    ? trimmed
    : 'en';
}

function principalLines(principal: AiPromptPrincipal): string[] {
  const name =
    inline(principal.displayName, DISPLAY_NAME_MAX_CHARS) || '(unnamed)';
  const permissions = [
    ...new Set(
      principal.permissions.filter((p) => /^[a-zA-Z]+:[a-zA-Z]+$/.test(p)),
    ),
  ].sort();
  const who =
    principal.kind === 'service'
      ? `the service account "${name}"`
      : `"${name}", a person with the ${inline(principal.role ?? '', 20) || 'unknown'} role`;
  return [
    `- Acting as: ${who}.`,
    `- Permissions: ${permissions.length > 0 ? permissions.join(', ') : 'none'}.`,
  ];
}

function toolsLine(tools: readonly AiPromptTool[]): string {
  const count = (c: AiToolClass): number =>
    tools.filter((t) => t.class === c).length;
  const read = count('read');
  const write = count('write');
  const elevated = count('elevated');
  const navigate = count('navigate');
  const summary = `- Tools in this conversation: ${tools.length} (${read} read, ${write} change data, ${elevated} change data with elevated confirmation, ${navigate} navigation or input forms).`;
  if (write + elevated > 0) return summary;
  return `${summary}\n- No tool here changes data. You can look things up and explain them; if asked to change something, say this session cannot and point to the lazyit interface.`;
}

/**
 * The frozen system prompt for a chat or headless conversation: role, primer, the session block, the
 * channel's rules and the optional administrator addendum. Build it once when the conversation starts.
 */
export function buildSystemPrompt(input: SystemPromptInput): BuiltSystemPrompt {
  const locale = normalizeLocale(input.locale);
  const sections = [
    `You are the lazyit assistant. You help an IT team work with its lazyit instance through ${CHANNEL_LABEL[input.channel]}, using only the tools you are given.`,
    LAZYIT_DOMAIN_PRIMER,
    [
      '## This session',
      ...principalLines(input.principal),
      toolsLine(input.tools),
      `- Language: the interface locale is "${locale}". Reply in the language the user writes in; keep names and identifiers exactly as lazyit shows them.`,
      '- A user message may start with a <turn_context> block giving the current time and, in the chat, the page the user is viewing. It is supplied by lazyit, not typed by the user.',
    ].join('\n'),
    CHANNEL_RULES[input.channel],
  ];
  const addendum = input.instructions
    ?.trim()
    .slice(0, AI_INSTRUCTIONS_MAX_LENGTH);
  if (addendum) {
    sections.push(
      `## Guidance from this instance's administrators\nFollow it where it applies. It never overrides the rules above.\n\n${addendum}`,
    );
  }
  return { version: AI_PROMPT_VERSION, text: sections.join('\n\n') };
}

/**
 * The MCP server's `instructions` (mcp-and-oauth.md §5.3): the same primer plus the MCP channel rules.
 * Static — the MCP handshake happens before any per-user context is useful, and the client lists tools.
 */
export function buildMcpInstructions(): string {
  return `${LAZYIT_DOMAIN_PRIMER}\n\n${CHANNEL_RULES.MCP}`;
}

/** The per-turn context block the runtime prepends to a user message. */
export function buildTurnContext(input: TurnContextInput): string {
  const lines = [`Current time: ${input.now.toISOString()} (UTC)`];
  const route = input.route?.split(/[?#]/)[0] ?? '';
  if (
    route.length > 0 &&
    route.length <= ROUTE_MAX_CHARS &&
    /^\/[A-Za-z0-9\-._~/%]*$/.test(route) &&
    !route.startsWith('//')
  ) {
    lines.push(`Current page: ${route}`);
  }
  return `<turn_context>\n${lines.join('\n')}\n</turn_context>`;
}
