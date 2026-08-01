/**
 * Agent configuration resolution (ADR-0074 §7). Three sources, precedence flags > env > file:
 *   1. CLI flags   — `--url`, `--token` / `--token-file`, `--interval`
 *   2. environment — `LAZYIT_URL`, `LAZYIT_TOKEN`, `LAZYIT_INTERVAL`
 *   3. config file — `/etc/lazyit-agent/config` (simple `KEY=VALUE`, written by install.sh, chmod 600)
 *
 * URL + token are required to actually report; the binary errors loudly if either is missing.
 *
 * The file also carries the HOST'S OWN LIMITS on any server policy (#1140) — `LAZYIT_COLLECT_*=false`,
 * `LAZYIT_MIN_INTERVAL`, `LAZYIT_SOFTWARE_MAX` and the `LAZYIT_EXCLUDE_*` glob lists. They are read
 * here into {@link AgentConfig.localLimits} and can only ever RESTRICT what the server asks for; see
 * `localLimitsFrom` for why nothing in that shape is able to widen anything.
 *
 * ...and, since #1137, how the agent gets OUT of the host: `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`
 * and `LAZYIT_CA_FILE`, read from the same file into {@link AgentConfig.network} because a systemd
 * unit's environment is almost empty and a host-wide proxy variable never reaches the timer.
 */
import { parseArgs } from "node:util";
import type { AgentLocalLimits } from "@lazyit/shared";
import { type AgentNetwork, networkFrom } from "./net";
import { localLimitsFrom } from "./policy";

const CONFIG_FILE = "/etc/lazyit-agent/config";

/**
 * The local-veto keys (#1140), listed so they resolve from the environment even when the config file
 * does not mention them — otherwise a limit could only ever be set by editing a file, which is the
 * one thing containerised and image-baked installs cannot do.
 */
const LOCAL_LIMIT_KEYS = [
  "LAZYIT_COLLECT_HARDWARE",
  "LAZYIT_COLLECT_DISKS",
  "LAZYIT_COLLECT_NICS",
  "LAZYIT_COLLECT_SOFTWARE",
  "LAZYIT_COLLECT_CONTAINERS",
  "LAZYIT_MIN_INTERVAL",
  "LAZYIT_SOFTWARE_MAX",
  "LAZYIT_EXCLUDE_NICS",
  "LAZYIT_EXCLUDE_MOUNTPOINTS",
  "LAZYIT_EXCLUDE_SOFTWARE",
] as const;

export interface AgentConfig {
  url?: string;
  token?: string;
  /**
   * LEGACY cadence hint, and still not read by the binary. It was the systemd timer's
   * `OnUnitActiveSec` before #1140 inverted the schedule: the timer now ticks at a fixed
   * {@link AGENT_POLICY_TICK_SECONDS} and CADENCE is the server's, enforced locally by the due gate.
   * Kept so an existing `/etc/lazyit-agent/config` neither breaks nor silently changes meaning — it
   * is explicitly NOT read as a local floor, because install.sh wrote it on every host that exists.
   * An operator who wants a floor sets `LAZYIT_MIN_INTERVAL`.
   */
  interval?: string;
  /**
   * What this HOST refuses to do, whatever the server's policy says (#1140). Empty on every existing
   * install — the keys are new and absent — so an upgrade changes nothing until an operator opts in.
   */
  localLimits: AgentLocalLimits;
  /**
   * Egress proxy + private CA (#1137). Empty on every existing install for the same reason: the keys
   * are new, so a host that sets none of them makes exactly the direct, system-trust request it
   * always made.
   */
  network: AgentNetwork;
  /** The subcommand: `report` (the default, what the timer runs), `show` or `test`. */
  command: string;
  /** `report --once`: collect + POST once, then exit (what the timer runs). The only mode today. */
  once: boolean;
  help: boolean;
  /**
   * Skip the due gate and report unconditionally (`--force`). What `install.sh` and a human debugging
   * a host run: waiting up to an interval to find out whether the token works would make the install
   * experience strictly worse than it was before the schedule was inverted.
   */
  force: boolean;
}

/** Seams so the resolver is testable without an `/etc` to write to or a real stdin to feed. */
export interface LoadConfigOptions {
  env?: Record<string, string | undefined>;
  configFile?: string;
  readStdin?: () => Promise<string>;
}

/** Parse a tiny `KEY=VALUE` file (comments with `#`, optional surrounding quotes). Missing file → {}. */
async function readConfigFile(path: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let text: string;
  try {
    text = await Bun.file(path).text();
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

/**
 * The token, out of a file or stdin rather than out of argv (#1137).
 *
 * `--token <value>` puts the Service Account token in root's shell history and, for the lifetime of
 * the process, in `ps` output for every user on the box. The window is short and the token is narrow
 * (`infra:report` only), but it costs one flag to close and it is the first thing a reviewer asks
 * about. `-` reads stdin, so `... --token-file -` fed by a secret store never touches the disk either.
 *
 * Every failure here is LOUD. A token file that cannot be read, or that is empty, must not fall
 * through to the environment or the config file: the operator asked for a specific credential, and
 * quietly reporting under a different one is exactly the surprise this flag exists to avoid.
 */
async function readTokenFile(path: string, readStdin: () => Promise<string>): Promise<string> {
  let raw: string;
  try {
    raw = path === "-" ? await readStdin() : await Bun.file(path).text();
  } catch (err) {
    throw new Error(
      `could not read the token file ${path === "-" ? "from stdin" : path} — ${(err as Error).message}`,
    );
  }
  const token = raw.trim();
  if (!token) {
    throw new Error(
      `the token file ${path === "-" ? "on stdin" : path} is empty — nothing to authenticate with`,
    );
  }
  return token;
}

export async function loadConfig(
  argv: string[],
  options: LoadConfigOptions = {},
): Promise<AgentConfig> {
  const env = options.env ?? process.env;
  const configFile = options.configFile ?? CONFIG_FILE;
  const readStdin = options.readStdin ?? (() => Bun.stdin.text());

  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false, // tolerate unknown flags rather than crash a scheduled run
    options: {
      url: { type: "string" },
      token: { type: "string" },
      "token-file": { type: "string" },
      interval: { type: "string" },
      once: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const file = await readConfigFile(configFile);
  const pick = (flag: unknown, envKey: string, fileKey: string): string | undefined => {
    const f = typeof flag === "string" ? flag : undefined;
    return f ?? env[envKey] ?? file[fileKey];
  };

  const tokenFile = typeof values["token-file"] === "string" ? values["token-file"] : undefined;
  if (tokenFile !== undefined && typeof values.token === "string") {
    throw new Error(
      "--token and --token-file are mutually exclusive — pass one, so it is unambiguous which credential this host uses",
    );
  }
  const token =
    tokenFile !== undefined
      ? await readTokenFile(tokenFile, readStdin)
      : pick(values.token, "LAZYIT_TOKEN", "LAZYIT_TOKEN");

  // The veto keys follow the same env-over-file precedence as everything else, so a limit can be set
  // in the unit's environment without editing the config file (containerised and image-baked installs).
  const limitSource: Record<string, string> = { ...file };
  for (const key of Object.keys(file)) {
    const fromEnv = env[key];
    if (fromEnv !== undefined) limitSource[key] = fromEnv;
  }
  for (const key of LOCAL_LIMIT_KEYS) {
    const fromEnv = env[key];
    if (fromEnv !== undefined) limitSource[key] = fromEnv;
  }

  return {
    url: pick(values.url, "LAZYIT_URL", "LAZYIT_URL"),
    ...(token !== undefined ? { token } : {}),
    interval: pick(values.interval, "LAZYIT_INTERVAL", "LAZYIT_INTERVAL"),
    localLimits: localLimitsFrom(limitSource),
    network: networkFrom(file, env),
    command: positionals[0] ?? "report",
    once: Boolean(values.once),
    force: Boolean(values.force),
    help: Boolean(values.help),
  };
}
