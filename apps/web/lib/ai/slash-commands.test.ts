import { describe, expect, mock, test } from "bun:test";
import {
  BUILTIN_SLASH_COMMANDS,
  exactSlashCommand,
  filterSlashCommands,
  moveHighlight,
  slashQuery,
  type SlashCommand,
  type SlashCommandContext,
} from "./slash-commands";

const names = (commands: readonly { name: string }[]) => commands.map((c) => c.name);

describe("slashQuery", () => {
  test("a slash at the very start opens the palette with what follows it", () => {
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/co")).toBe("co");
    expect(slashQuery("/COPY")).toBe("copy");
  });

  test("anything else is a normal message", () => {
    expect(slashQuery("")).toBeNull();
    expect(slashQuery("copy")).toBeNull();
    expect(slashQuery(" /copy")).toBeNull();
    expect(slashQuery("/copy now")).toBeNull();
    expect(slashQuery("/copy\n")).toBeNull();
    expect(slashQuery("what is /etc/hosts")).toBeNull();
    expect(slashQuery("/etc/hosts")).toBeNull();
  });
});

describe("filterSlashCommands", () => {
  test("an empty query lists every command in registry order", () => {
    expect(names(filterSlashCommands(BUILTIN_SLASH_COMMANDS, ""))).toEqual(["copy", "new", "help"]);
  });

  test("a prefix of the name ranks first, then a substring, then the localized label", () => {
    const commands: SlashCommand<unknown>[] = [
      { name: "renew", run: () => {} },
      { name: "new", run: () => {} },
      { name: "copy", run: () => {} },
    ];
    const label = (c: SlashCommand<unknown>) => (c.name === "copy" ? "Copiar la conversación" : "");
    expect(names(filterSlashCommands(commands, "new"))).toEqual(["new", "renew"]);
    expect(names(filterSlashCommands(commands, "conversacion", label))).toEqual(["copy"]);
    expect(names(filterSlashCommands(commands, "zzz", label))).toEqual([]);
  });

  test("matches aliases and ignores case and accents", () => {
    expect(names(filterSlashCommands(BUILTIN_SLASH_COMMANDS, "AYU"))).toEqual(["help"]);
    expect(names(filterSlashCommands(BUILTIN_SLASH_COMMANDS, "copi"))).toEqual(["copy"]);
    expect(names(filterSlashCommands(BUILTIN_SLASH_COMMANDS, "ayúda"))).toEqual(["help"]);
  });
});

describe("exactSlashCommand", () => {
  test("a message that is exactly a command (or alias) names it", () => {
    expect(exactSlashCommand(BUILTIN_SLASH_COMMANDS, "/copy")?.name).toBe("copy");
    expect(exactSlashCommand(BUILTIN_SLASH_COMMANDS, "  /Copy  ")?.name).toBe("copy");
    expect(exactSlashCommand(BUILTIN_SLASH_COMMANDS, "/nuevo")?.name).toBe("new");
  });

  test("anything else is not a command, so it is sent as a message", () => {
    expect(exactSlashCommand(BUILTIN_SLASH_COMMANDS, "/cop")).toBeNull();
    expect(exactSlashCommand(BUILTIN_SLASH_COMMANDS, "/copy this")).toBeNull();
    expect(exactSlashCommand(BUILTIN_SLASH_COMMANDS, "copy")).toBeNull();
    expect(exactSlashCommand(BUILTIN_SLASH_COMMANDS, "/unknown")).toBeNull();
  });
});

describe("the built-in commands", () => {
  test("each runs its own action on the chat, and nothing else", () => {
    const ctx: SlashCommandContext = { copyConversation: mock(), newChat: mock(), showHelp: mock() };
    for (const command of BUILTIN_SLASH_COMMANDS) void command.run(ctx);
    expect(ctx.copyConversation).toHaveBeenCalledTimes(1);
    expect(ctx.newChat).toHaveBeenCalledTimes(1);
    expect(ctx.showHelp).toHaveBeenCalledTimes(1);
  });

  test("names are unique, lower-case and usable as message keys", () => {
    const all = BUILTIN_SLASH_COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]);
    expect(new Set(all).size).toBe(all.length);
    for (const c of BUILTIN_SLASH_COMMANDS) expect(c.name).toMatch(/^[a-z][a-z0-9-]*$/);
  });
});

describe("moveHighlight", () => {
  test("moves and wraps around; an empty list has no row", () => {
    expect(moveHighlight(0, 1, 3)).toBe(1);
    expect(moveHighlight(2, 1, 3)).toBe(0);
    expect(moveHighlight(0, -1, 3)).toBe(2);
    expect(moveHighlight(-1, 1, 3)).toBe(0);
    expect(moveHighlight(-1, -1, 3)).toBe(2);
    expect(moveHighlight(0, 1, 0)).toBe(-1);
  });
});
