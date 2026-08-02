import { describe, expect, test } from "bun:test";
import { defaultConfigFile, defaultStateDir } from "./paths";

/**
 * Issue #1144. The config path was hard-coded to `/etc/lazyit-agent/config` and the state directory
 * to `/var/lib/lazyit-agent`, which is correct on Linux and meaningless on Windows — a binary looking
 * for its token there would report "missing URL and/or token" on a host `install.ps1` had just
 * configured correctly.
 *
 * These tests run on whatever platform CI happens to be, so they assert the branch that platform
 * actually takes. That is deliberately weaker than testing both, and it is the honest limit: the
 * functions read `process.platform`, which no test may lie about without lying about what the
 * compiled artifact does. The WINDOWS branch is covered instead by `install-ps1.test.ts`, which pins
 * the literal path the installer writes — and if the two ever disagreed, the installer would be
 * writing a file the binary does not read, which is the failure worth catching.
 */
describe("platform paths", () => {
  const windows = process.platform === "win32";

  test("the config file is the platform's, not Linux's everywhere", () => {
    expect(defaultConfigFile()).toBe(
      windows ? "C:\\ProgramData\\lazyit-agent\\config" : "/etc/lazyit-agent/config",
    );
  });

  test("the state directory is the platform's too", () => {
    expect(defaultStateDir()).toBe(
      windows ? "C:\\ProgramData\\lazyit-agent\\state" : "/var/lib/lazyit-agent",
    );
  });

  test("%ProgramData% is honoured when Windows sets it somewhere else", () => {
    // A redirected ProgramData is rare but real (an imaged fleet, a non-C: system drive). The
    // environment is read rather than assumed, with `C:\ProgramData` only as the fallback.
    const env = { ProgramData: "D:\\ProgramData\\" } as unknown as NodeJS.ProcessEnv;
    expect(defaultConfigFile(env)).toBe(
      windows ? "D:\\ProgramData\\lazyit-agent\\config" : "/etc/lazyit-agent/config",
    );
  });
});
