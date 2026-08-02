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

  test("install.ps1 does not start with a UTF-8 byte-order mark either", async () => {
    // Belt and braces beside the rule above, which already forbids a BOM (it is non-ASCII). Naming
    // the three bytes makes a future "fix" that adds a BOM INSTEAD of staying ASCII fail with its
    // reason spelled out, rather than as a bare non-ASCII hit at line 1, column 1.
    const bytes = new Uint8Array(await Bun.file(join(PUBLIC_DIR, "install.ps1")).arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2]]).not.toEqual([0xef, 0xbb, 0xbf]);
  });
});
