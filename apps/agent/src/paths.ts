/**
 * Where the agent's files live, per platform (#1144).
 *
 * Until Windows existed these were two string constants, one in `config.ts` and one in `policy.ts`,
 * both hard-coded to a Linux FHS path. A second OS makes that a bug rather than a simplification: a
 * Windows host has no `/etc` and no `/var/lib`, and a binary that looked for its token there would
 * report "missing URL and/or token" on a machine the installer had just configured correctly.
 *
 * THE LAYOUTS ARE NOT SYMMETRICAL, on purpose. Linux keeps the FHS split it has always had —
 * configuration in `/etc`, mutable state in `/var/lib` — because that is what an operator, a backup
 * policy and every systemd sandbox directive already expect, and moving it would break every existing
 * install for nothing. Windows puts both under ONE directory in `%ProgramData%`, which is the
 * platform's own convention for machine-scoped application data and means `install.ps1` has exactly
 * one ACL to set: the directory holds a live Service Account token, and one inherited ACL restricted
 * to SYSTEM + Administrators is far harder to get wrong than two.
 *
 * `%ProgramData%` is read from the environment with a literal fallback. A service started by Task
 * Scheduler as SYSTEM does get the variable, but a hand-run from a stripped environment might not,
 * and defaulting to `C:\ProgramData` — which is where it points on every supported Windows — beats
 * resolving to `undefined\lazyit-agent`.
 */

/** Is this process the Windows build? Duplicated from the collector dispatcher to avoid a cycle. */
const IS_WINDOWS = process.platform === "win32";

/** `%ProgramData%\lazyit-agent` — config AND state, under one inherited ACL. */
function windowsRoot(env: NodeJS.ProcessEnv): string {
  const programData = env.ProgramData?.trim() || env.PROGRAMDATA?.trim() || "C:\\ProgramData";
  return `${programData.replace(/[\\/]+$/, "")}\\lazyit-agent`;
}

/**
 * The config file: instance URL, SA token, this host's local vetoes, its proxy and its CA.
 *
 * `--config` overrides it (see `loadConfig`), which is what makes a non-standard install — a
 * container, an image-baked deployment, a test — possible without patching the binary.
 */
export function defaultConfigFile(env: NodeJS.ProcessEnv = process.env): string {
  return IS_WINDOWS ? `${windowsRoot(env)}\\config` : "/etc/lazyit-agent/config";
}

/** Where the cached policy and the last-success clock live (#1140). */
export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return IS_WINDOWS ? `${windowsRoot(env)}\\state` : "/var/lib/lazyit-agent";
}

/** The path separator for the two state files. Kept here so `policy.ts` never branches. */
export const PATH_SEPARATOR = IS_WINDOWS ? "\\" : "/";
