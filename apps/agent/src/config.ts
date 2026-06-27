/**
 * Agent configuration resolution (ADR-0074 §7). Three sources, precedence flags > env > file:
 *   1. CLI flags   — `--url`, `--token`, `--interval`
 *   2. environment — `LAZYIT_URL`, `LAZYIT_TOKEN`, `LAZYIT_INTERVAL`
 *   3. config file — `/etc/lazyit-agent/config` (simple `KEY=VALUE`, written by install.sh, chmod 600)
 *
 * URL + token are required to actually report; the binary errors loudly if either is missing.
 */
import { parseArgs } from "node:util";

const CONFIG_FILE = "/etc/lazyit-agent/config";

export interface AgentConfig {
  url?: string;
  token?: string;
  /**
   * Reporting cadence. The binary is a oneshot (`report --once`) — scheduling is owned by the systemd
   * timer (ADR-0074 §7), so this is read for completeness/forward-compat but the binary never loops on
   * it. // ponytail: a daemon mode would consume this; inventory never needs sub-minute reporting.
   */
  interval?: string;
  /** The subcommand (only `report` exists today); defaults to `report`. */
  command: string;
  /** `report --once`: collect + POST once, then exit (what the timer runs). The only mode today. */
  once: boolean;
  help: boolean;
}

/** Parse a tiny `KEY=VALUE` file (comments with `#`, optional surrounding quotes). Missing file → {}. */
async function readConfigFile(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let text: string;
  try {
    text = await Bun.file(CONFIG_FILE).text();
  } catch {
    return out; // no file is the normal case before install.sh has run
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      val.length >= 2 &&
      ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'")))
    ) {
      val = val.slice(1, -1);
    }
    if (key) out[key] = val;
  }
  return out;
}

export async function loadConfig(argv: string[]): Promise<AgentConfig> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false, // tolerate unknown flags rather than crash a scheduled run
    options: {
      url: { type: "string" },
      token: { type: "string" },
      interval: { type: "string" },
      once: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const file = await readConfigFile();
  const pick = (flag: unknown, envKey: string, fileKey: string): string | undefined => {
    const f = typeof flag === "string" ? flag : undefined;
    return f ?? process.env[envKey] ?? file[fileKey];
  };

  return {
    url: pick(values.url, "LAZYIT_URL", "LAZYIT_URL"),
    token: pick(values.token, "LAZYIT_TOKEN", "LAZYIT_TOKEN"),
    interval: pick(values.interval, "LAZYIT_INTERVAL", "LAZYIT_INTERVAL"),
    command: positionals[0] ?? "report",
    once: Boolean(values.once),
    help: Boolean(values.help),
  };
}
