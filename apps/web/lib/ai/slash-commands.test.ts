import { describe, expect, mock, test } from "bun:test";
import {
  BUILTIN_SLASH_COMMANDS,
  exactSlashCommand,
  filterSlashCommands,
  matchSlashCommand,
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
    expect(names(filterSlashCommands(BUILTIN_SLASH_COMMANDS, ""))).toEqual([
      "copy",
      "new",
      "help",
      "model",
      "auto",
    ]);
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

describe("matchSlashCommand", () => {
  const match = (text: string) => {
    const m = matchSlashCommand(BUILTIN_SLASH_COMMANDS, text);
    return m && { name: m.command.name, argument: m.argument };
  };

  test("a command alone runs without an argument", () => {
    expect(match("/copy")).toEqual({ name: "copy", argument: null });
    expect(match(" /modelo ")).toEqual({ name: "model", argument: null });
    expect(match("/auto")).toEqual({ name: "auto", argument: null });
  });

  test("a command with an argument it understands runs with it", () => {
    expect(match("/model gpt-4o-mini")).toEqual({ name: "model", argument: "gpt-4o-mini" });
    expect(match("/model  models/gemini-2.5-pro")).toEqual({ name: "model", argument: "models/gemini-2.5-pro" });
    expect(match("/auto on")).toEqual({ name: "auto", argument: "on" });
    expect(match("/AUTO Off")).toEqual({ name: "auto", argument: "Off" });
  });

  test("an argument the command does not take or understand is a normal message", () => {
    expect(match("/copy this")).toBeNull();
    expect(match("/auto maybe")).toBeNull();
    expect(match("/model ../../admin")).toBeNull();
    expect(match("/model is wrong here")).toBeNull();
    expect(match("/unknown on")).toBeNull();
  });
});

describe("the built-in commands", () => {
  function context(): SlashCommandContext {
    return {
      copyConversation: mock(),
      newChat: mock(),
      showHelp: mock(),
      chooseModel: mock(),
      setAutoApprove: mock(),
    };
  }

  test("each runs its own action on the chat, and nothing else", () => {
    const ctx = context();
    for (const command of BUILTIN_SLASH_COMMANDS) void command.run(ctx, null);
    expect(ctx.copyConversation).toHaveBeenCalledTimes(1);
    expect(ctx.newChat).toHaveBeenCalledTimes(1);
    expect(ctx.showHelp).toHaveBeenCalledTimes(1);
    expect(ctx.chooseModel).toHaveBeenCalledWith(null);
    expect(ctx.setAutoApprove).toHaveBeenCalledWith(null);
  });

  test("/model sets the typed id and /auto on|off sets the mode", () => {
    const ctx = context();
    const byName = (name: string) => BUILTIN_SLASH_COMMANDS.find((c) => c.name === name)!;
    void byName("model").run(ctx, " claude-sonnet-4-5 ");
    void byName("auto").run(ctx, "on");
    void byName("auto").run(ctx, "desactivar");
    expect(ctx.chooseModel).toHaveBeenCalledWith("claude-sonnet-4-5");
    expect(ctx.setAutoApprove).toHaveBeenNthCalledWith(1, true);
    expect(ctx.setAutoApprove).toHaveBeenNthCalledWith(2, false);
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
