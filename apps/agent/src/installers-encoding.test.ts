import { describe, expect, test } from "bun:test";
import { join } from "node:path";

/**
 * The installers served from `apps/web/public/` must be PURE ASCII (#1166).
 *
 * WHY THIS IS A TEST AND NOT A COMMENT ASKING NICELY. `install.ps1` shipped as UTF-8 with no
 * byte-order mark and 45 lines carrying non-ASCII characters. Windows PowerShell 5.1 — the shell
 * that ships with Windows, and the one a fresh host has — decodes a `.ps1` as ANSI unless a BOM says
 * otherwise, so every em dash (U+2014, bytes E2 80 94) came back through Windows-1252 as three
 * characters ending in U+201D, a right double quotation mark. A stray smart quote inside the token
 * stream derails the parser: the real report from the first Windows host was nine cascading parse
 * errors pointing at comment text. The script failed before it did anything at all. PowerShell 7
 * reads UTF-8 by default and parses the same bytes fine, which is exactly why this survived review.
 *
 * WHY ASCII AND NOT A BOM. A BOM would also satisfy PowerShell 5.1. ASCII is chosen because these
 * files are downloaded over HTTP, piped through `irm | iex` and `curl | sh`, saved by browsers,
 * copied between machines and re-encoded by editors on the way. ASCII removes the dependency
 * instead of betting on three leading bytes surviving every transport.
 *
 * WHY `install.sh` IS COVERED TOO. POSIX `sh` does not care about the encoding, so a non-ASCII byte
 * there is not a bug the way it is in `install.ps1`. It is covered anyway for one concrete reason:
 * `install.ps1` was written as the Windows sibling of `install.sh` and shares whole paragraphs of
 * its prose with it. Every em dash left in `install.sh` is a live source of the next em dash pasted
 * into `install.ps1`. One rule over both files is cheaper to hold than two different ones, and the
 * only cost is typing a hyphen.
 *
 * This file is the encoding half of the installer contract; the behavioural half lives in
 * `install-ps1.test.ts` and `install-sh.test.ts` beside it. Note that the rule applies to the
 * SHIPPED SCRIPTS, not to this test — TypeScript sources are UTF-8 everywhere and stay that way.
 */
const PUBLIC_DIR = join(import.meta.dir, "..", "..", "web", "public");
const INSTALLERS = ["install.ps1", "install.sh"] as const;

/** Every non-ASCII code point in `text`, located so a failure names what to rewrite and where. */
function findNonAscii(text: string): string[] {
  const offenders: string[] = [];
  text.split("\n").forEach((line, index) => {
    [...line].forEach((char, column) => {
      const code = char.codePointAt(0) ?? 0;
      if (code > 0x7f) {
        const point = `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
        offenders.push(`line ${index + 1}, col ${column + 1}: ${JSON.stringify(char)} (${point})`);
      }
    });
  });
  return offenders;
}

describe("the public installers are pure ASCII, so PowerShell 5.1 can parse one of them", () => {
  for (const name of INSTALLERS) {
    test(`${name} carries no byte outside \\x00-\\x7F`, async () => {
      const text = await Bun.file(join(PUBLIC_DIR, name)).text();
      const offenders = findNonAscii(text);
      expect(
        offenders,
        `${name} must be pure ASCII (#1166: Windows PowerShell 5.1 decodes a BOM-less .ps1 as ANSI ` +
          `and turns every non-ASCII character into a cascading parse error). Rewrite the offenders ` +
          `below — do not delete the prose: U+2014 em dash -> "-", U+00A7 section sign -> ` +
          `"section", U+2192 arrow -> "->", curly quotes -> straight quotes.\n  ` +
          offenders.join("\n  "),
      ).toEqual([]);
    });
  }

  /*
   * THE ASCII RULE ABOVE CANNOT SEE A BOM. This is the whole reason the next check reads BYTES
   * rather than characters. `Bun.file().text()` decodes UTF-8 and strips a leading U+FEFF as part of
   * decoding, so the byte-order mark never reaches `findNonAscii`: given a file whose bytes begin
   * EF BB BF 23, `.text()` returns a string whose FIRST code point is U+0023 ('#'), with no U+FEFF
   * anywhere in it, and the rule above passes with zero offenders. A BOM is invisible to that rule,
   * not caught by it.
   *
   * BOTH installers are checked, and `install.sh` is the one that needs it more even though it never
   * had the #1166 bug. What a BOM does there, measured rather than assumed:
   *
   *   - `execve("./install.sh")` fails with ENOEXEC ("Exec format error"), because the kernel looks
   *     for `#!` at OFFSET 0 and finds EF BB BF. Anything that execs the script directly - a
   *     supervisor, a config-management tool, a language runtime's exec - stops there.
   *   - Run through a shell instead (`./install.sh` from bash, or the documented `curl ... | sh`),
   *     it does NOT stop. The shell retries an ENOEXEC file with `sh`, and `sh` no longer sees the
   *     shebang line as a comment - the BOM is now the first character of the word - so it tries to
   *     run it: `sh: line 1: <BOM>#!/bin/sh: No such file or directory`. Then it CARRIES ON and
   *     installs, because `set -eu` is on a later line and is not in effect yet.
   *
   * So the everyday shape of this is not a clean failure: it is a one-liner that prints a "No such
   * file or directory" naming /bin/sh and then installs software as root anyway. `install.ps1` gets
   * off lighter - a BOM makes PowerShell 5.1 read it as UTF-8, which is the direction #1166 wanted.
   * Notepad has defaulted to "UTF-8 with BOM" for years and these files are edited by Windows
   * people, so this is one save away at any time.
   */
  for (const name of INSTALLERS) {
    test(`${name} does not start with a UTF-8 byte-order mark`, async () => {
      const bytes = new Uint8Array(await Bun.file(join(PUBLIC_DIR, name)).arrayBuffer());
      expect(
        [bytes[0], bytes[1], bytes[2]],
        `${name} starts with a UTF-8 byte-order mark (EF BB BF). Save it as UTF-8 WITHOUT a BOM ` +
          `(#1166 chose ASCII over a BOM deliberately). The pure-ASCII rule above cannot catch this ` +
          `for you: Bun strips the BOM while decoding, so it never appears in the text that rule ` +
          `inspects. On install.sh it breaks the shebang: execve fails with ENOEXEC, and through a ` +
          `shell it prints "line 1: <BOM>#!/bin/sh: No such file or directory" and installs anyway.`,
      ).not.toEqual([0xef, 0xbb, 0xbf]);
    });
  }
});
