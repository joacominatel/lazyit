/**
 * Slash commands for the AI chat composer (issue #1372). Typing `/` at the start of the composer opens a
 * palette of these; picking one runs it in the browser. A command is NEVER sent to the model.
 *
 * The registry is a plain array so later commands (`/model`, `/auto`) plug in by adding an entry and, if
 * they need more from the chat, a member of {@link SlashCommandContext}. Labels and descriptions are
 * localized under `ai.commands.<name>.{label,description}`; this module only holds the pure rules.
 */

/** What a command can do to the chat. Extend it when a new command needs more. */
export interface SlashCommandContext {
  /** Copy the whole conversation to the clipboard as Markdown. */
  copyConversation: () => void | Promise<void>;
  /** Start a new chat. */
  newChat: () => void;
  /** Show the list of commands and shortcuts. */
  showHelp: () => void;
}

export interface SlashCommand<C = SlashCommandContext> {
  /** What follows the slash: lower-case letters, digits and dashes. Also the i18n key. */
  name: string;
  /** Other spellings that match exactly (e.g. an es word), never shown. */
  aliases?: readonly string[];
  /** Whether it can run right now (e.g. `/copy` needs messages). Omitted means always. */
  enabled?: (ctx: C) => boolean;
  run: (ctx: C) => void | Promise<void>;
}

/** The built-in commands, in palette order. */
export const BUILTIN_SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "copy", aliases: ["copiar"], run: (ctx) => ctx.copyConversation() },
  { name: "new", aliases: ["nuevo", "clear"], run: (ctx) => ctx.newChat() },
  { name: "help", aliases: ["ayuda"], run: (ctx) => ctx.showHelp() },
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

/** The command a whole message names exactly (`/copy`, `/COPY `, an alias), or null. */
export function exactSlashCommand<C>(
  commands: readonly SlashCommand<C>[],
  text: string,
): SlashCommand<C> | null {
  const match = /^\/(\S+)$/.exec(text.trim());
  if (!match) return null;
  const name = fold(match[1]!);
  return (
    commands.find((c) => fold(c.name) === name || (c.aliases ?? []).some((a) => fold(a) === name)) ??
    null
  );
}

/** Moves the palette's highlighted row with wrap-around; an empty list has no row (-1). */
export function moveHighlight(current: number, delta: number, count: number): number {
  if (count <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : count - 1;
  return (((current + delta) % count) + count) % count;
}
