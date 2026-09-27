import { parseAutoArgument, validModelId } from "./chat-settings";

/**
 * Slash commands for the AI chat composer (issue #1372). Typing `/` at the start of the composer opens a
 * palette of these; picking one runs it in the browser. A command is NEVER sent to the model.
 *
 * The registry is a plain array: a command plugs in by adding an entry and, if it needs more from the
 * chat, a member of {@link SlashCommandContext}. Labels and descriptions are localized under
 * `ai.commands.<name>.{label,description}`; this module only holds the pure rules.
 *
 * A command may take ONE argument (`/model gpt-4o`, `/auto on`): it declares `argument`, which says
 * whether a given word is one it understands. A message whose argument the command does not understand is
 * not a command — it is sent as a normal message, like any other text that merely starts with a slash.
 */

/** What a command can do to the chat. Extend it when a new command needs more. */
export interface SlashCommandContext {
  /** Copy the whole conversation to the clipboard as Markdown. */
  copyConversation: () => void | Promise<void>;
  /** Start a new chat. */
  newChat: () => void;
  /** Show the list of commands and shortcuts. */
  showHelp: () => void;
  /** `/model`: open the model picker (no id), or set the chat's model to `id`. */
  chooseModel: (id: string | null) => void;
  /** `/auto`: turn auto-approve on or off; `null` toggles it. */
  setAutoApprove: (on: boolean | null) => void;
}

export interface SlashCommand<C = SlashCommandContext> {
  /** What follows the slash: lower-case letters, digits and dashes. Also the i18n key. */
  name: string;
  /** Other spellings that match exactly (e.g. an es word), never shown. */
  aliases?: readonly string[];
  /** Whether it can run right now (e.g. `/copy` needs messages). Omitted means always. */
  enabled?: (ctx: C) => boolean;
  /**
   * The one argument this command accepts: `hint` is shown after the name (`[id]`, `on|off`) and
   * `accepts` checks a word. Without it the command takes no argument.
   */
  argument?: { hint: string; accepts: (value: string) => boolean };
  /** `argument` is the word after the name, or null when none was given. */
  run: (ctx: C, argument: string | null) => void | Promise<void>;
}

/** The built-in commands, in palette order. */
export const BUILTIN_SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "copy", aliases: ["copiar"], run: (ctx) => ctx.copyConversation() },
  { name: "new", aliases: ["nuevo", "clear"], run: (ctx) => ctx.newChat() },
  { name: "help", aliases: ["ayuda"], run: (ctx) => ctx.showHelp() },
  {
    name: "model",
    aliases: ["modelo"],
    argument: { hint: "[id]", accepts: (value) => validModelId(value) !== null },
    run: (ctx, argument) => ctx.chooseModel(argument === null ? null : validModelId(argument)),
  },
  {
    name: "auto",
    argument: { hint: "on|off", accepts: (value) => parseAutoArgument(value) !== null },
    run: (ctx, argument) => ctx.setAutoApprove(argument === null ? null : parseAutoArgument(argument)),
  },
];

/**
 * The palette's query when the composer text is a slash command in progress: it starts with `/` and has
 * no whitespace yet (`/co` → `"co"`, `/` → `""`). Anything else — no slash, a slash later on, a space or
 * a new line after the command — is a normal message and returns null.
 */
export function slashQuery(text: string): string | null {
  const match = /^\/([^\s/]*)$/.exec(text);
  return match ? match[1]!.toLowerCase() : null;
}

/** Folds case and accents so "ayúda" matches "ayuda". */
function fold(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

/**
 * The commands matching a query, best first: a name or alias starting with the query, then one
 * containing it, then a localized label containing it. Order within a rank follows the registry.
 * `labelOf` supplies the localized label (and description) searched in the last rank.
 */
export function filterSlashCommands<C>(
  commands: readonly SlashCommand<C>[],
  query: string,
  labelOf: (command: SlashCommand<C>) => string = () => "",
): SlashCommand<C>[] {
  const q = fold(query.trim());
  if (q === "") return [...commands];
  const ranked: { command: SlashCommand<C>; rank: number; index: number }[] = [];
  commands.forEach((command, index) => {
    const names = [command.name, ...(command.aliases ?? [])].map(fold);
    let rank = -1;
    if (names.some((n) => n.startsWith(q))) rank = 0;
    else if (names.some((n) => n.includes(q))) rank = 1;
    else if (fold(labelOf(command)).includes(q)) rank = 2;
    if (rank >= 0) ranked.push({ command, rank, index });
  });
  ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return ranked.map((r) => r.command);
}

function byName<C>(commands: readonly SlashCommand<C>[], raw: string): SlashCommand<C> | null {
  const name = fold(raw);
  return (
    commands.find((c) => fold(c.name) === name || (c.aliases ?? []).some((a) => fold(a) === name)) ??
    null
  );
}

/** The command a whole message names exactly (`/copy`, `/COPY `, an alias), or null. */
export function exactSlashCommand<C>(
  commands: readonly SlashCommand<C>[],
  text: string,
): SlashCommand<C> | null {
  const match = /^\/(\S+)$/.exec(text.trim());
  return match ? byName(commands, match[1]!) : null;
}

/**
 * The command a whole message runs, with its argument: `/copy` → copy with none, `/model gpt-4o` → model
 * with `"gpt-4o"`. An argument the command does not take or does not understand — or more than one word —
 * is no command at all: the message is sent as typed.
 */
export function matchSlashCommand<C>(
  commands: readonly SlashCommand<C>[],
  text: string,
): { command: SlashCommand<C>; argument: string | null } | null {
  const match = /^\/(\S+)(?:\s+(\S+))?$/.exec(text.trim());
  if (!match) return null;
  const command = byName(commands, match[1]!);
  if (!command) return null;
  const argument = match[2] ?? null;
  if (argument === null) return { command, argument };
  return command.argument?.accepts(argument) ? { command, argument } : null;
}

/** Moves the palette's highlighted row with wrap-around; an empty list has no row (-1). */
export function moveHighlight(current: number, delta: number, count: number): number {
  if (count <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : count - 1;
  return (((current + delta) % count) + count) % count;
}
