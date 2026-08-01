import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config";

/** A scratch directory per test — nothing here ever touches the real /etc/lazyit-agent. */
function scratch(): { dir: string; cleanup: () => void } {
  const dir = join(tmpdir(), `lazyit-config-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** `loadConfig` with every ambient source neutralised, so a test asserts only what it passes in. */
function load(argv: string[], over: Parameters<typeof loadConfig>[1] = {}) {
  return loadConfig(argv, { env: {}, configFile: "/nonexistent/lazyit-agent/config", ...over });
}

describe("commands — report is still the default, show and test are new (#1137)", () => {
  test("no positional means report, exactly as before", async () => {
    expect((await load([])).command).toBe("report");
  });

  test("show and test are recognised commands", async () => {
    expect((await load(["show"])).command).toBe("show");
    expect((await load(["test"])).command).toBe("test");
  });
});

describe("--token-file — keeping the token out of argv and out of shell history (#1137)", () => {
  test("the token is read from the named file", async () => {
    const { dir, cleanup } = scratch();
    try {
      const file = join(dir, "token");
      writeFileSync(file, "lzit_sa_from_file");
      expect((await load(["--token-file", file])).token).toBe("lzit_sa_from_file");
    } finally {
      cleanup();
    }
  });

  test("a trailing newline is stripped — `echo token > file` must just work", async () => {
    const { dir, cleanup } = scratch();
    try {
      const file = join(dir, "token");
      writeFileSync(file, "lzit_sa_newline\n");
      expect((await load(["--token-file", file])).token).toBe("lzit_sa_newline");
    } finally {
      cleanup();
    }
  });

  test("`--token-file -` reads stdin", async () => {
    const cfg = await load(["--token-file", "-"], {
      readStdin: async () => "lzit_sa_from_stdin\n",
    });
    expect(cfg.token).toBe("lzit_sa_from_stdin");
  });

  test("a token file that cannot be read fails LOUDLY, never silently falling back", async () => {
    await expect(
      load(["--token-file", "/nonexistent/token"], { env: { LAZYIT_TOKEN: "lzit_sa_env" } }),
    ).rejects.toThrow(/token file/i);
  });

  test("an EMPTY token file is an error, not an empty token the API would 401 on", async () => {
    const { dir, cleanup } = scratch();
    try {
      const file = join(dir, "token");
      writeFileSync(file, "\n  \n");
      await expect(load(["--token-file", file])).rejects.toThrow(/empty/i);
    } finally {
      cleanup();
    }
  });

  test("passing both --token and --token-file is refused rather than silently ranked", async () => {
    const { dir, cleanup } = scratch();
    try {
      const file = join(dir, "token");
      writeFileSync(file, "lzit_sa_from_file");
      await expect(load(["--token", "lzit_sa_flag", "--token-file", file])).rejects.toThrow(
        /--token and --token-file/,
      );
    } finally {
      cleanup();
    }
  });

  test("--token-file outranks the environment and the config file", async () => {
    const { dir, cleanup } = scratch();
    try {
      const file = join(dir, "token");
      const config = join(dir, "config");
      writeFileSync(file, "lzit_sa_from_file");
      writeFileSync(config, "LAZYIT_TOKEN=lzit_sa_from_config\n");
      const cfg = await load(["--token-file", file], {
        env: { LAZYIT_TOKEN: "lzit_sa_env" },
        configFile: config,
      });
      expect(cfg.token).toBe("lzit_sa_from_file");
    } finally {
      cleanup();
    }
  });
});

describe("network settings — proxy and CA reach the agent from its own config file (#1137)", () => {
  test("the config file supplies the proxy and the CA the unit's environment does not have", async () => {
    const { dir, cleanup } = scratch();
    try {
      const config = join(dir, "config");
      writeFileSync(
        config,
        [
          "LAZYIT_URL=https://lazyit.corp",
          "LAZYIT_TOKEN=lzit_sa_x",
          "HTTPS_PROXY=http://proxy.corp:3128",
          "NO_PROXY=.internal",
          "LAZYIT_CA_FILE=/etc/pki/corp-root.pem",
        ].join("\n"),
      );
      const cfg = await load([], { configFile: config });
      expect(cfg.network).toEqual({
        httpsProxy: "http://proxy.corp:3128",
        noProxy: ".internal",
        caFile: "/etc/pki/corp-root.pem",
      });
    } finally {
      cleanup();
    }
  });

  test("a host with nothing configured gets no proxy and no CA override", async () => {
    expect((await load([])).network).toEqual({});
  });

  test("the local-veto keys are untouched by any of this", async () => {
    const { dir, cleanup } = scratch();
    try {
      const config = join(dir, "config");
      writeFileSync(config, "LAZYIT_COLLECT_SOFTWARE=false\nHTTPS_PROXY=http://p:1\n");
      const cfg = await load([], { configFile: config });
      expect(cfg.localLimits).toEqual({ collect: { software: false } });
    } finally {
      cleanup();
    }
  });
});
