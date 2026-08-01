#!/usr/bin/env bun
/**
 * lazyit server reporting agent (ADR-0074 §7) — a Bun single-file executable, Linux-only collector.
 *
 * It reads its config (flags > env > /etc/lazyit-agent/config), gathers best-effort host facts,
 * validates the result against the SAME `AgentReportSchema` the API enforces (imported from
 * `@lazyit/shared` — zero drift, the whole point), then POSTs it to `${url}/api/infra/report` with the
 * Service Account bearer token. Default mode (`report --once`) does one collect + POST and exits —
 * there is no long-lived process.
 *
 * SCHEDULING IS NOW SPLIT (#1140). The systemd timer (install.sh) owns only the TICK — a fixed
 * `AGENT_POLICY_TICK_SECONDS` on every platform, never rewritten — while the CADENCE belongs to the
 * server and is enforced right here: a tick that arrives inside the interval exits without collecting
 * anything. That inversion is what lets an operator move a fleet from 5 minutes to 24 hours from the
 * lazyit UI with no unit file mutated, no `daemon-reload`, and identical semantics under launchd and
 * Windows Task Scheduler. `--force` skips the gate (what install.sh and a human debugging a host run).
 */
import {
  AgentPolicySchema,
  AGENT_POLICY_TICK_SECONDS,
  agentPolicyDue,
  applyAgentPolicyVeto,
  AgentReportSchema,
  type AgentPolicy,
  type AgentReport,
} from "@lazyit/shared";
import { loadConfig } from "./config";
import {
  buildDiagnostics,
  collectHost,
  collectSoftware,
  readMachineId,
} from "./collect";
import {
  loadCachedPolicy,
  loadState,
  writeCachedPolicy,
  writeState,
  type AgentState,
} from "./policy";
import {
  serverUnderstandsSoftwareDelta,
  softwareWireFields,
} from "./software-delta";

// Build-time version stamp (ADR-0083 mechanism, issue #907): the compile scripts bake `APP_VERSION`
// via `bun build --define` (git describe → env). A plain `bun run`/an unstamped compile falls back to
// "dev", which the server treats as "don't warn" (never nag a dev build). Mirrors GET /instance/version.
const AGENT_VERSION = process.env.APP_VERSION || "dev";

const HELP = `lazyit-agent ${AGENT_VERSION} — server reporting agent (Linux)

Usage:
  lazyit-agent [report] [--once] [--force] [--url <url>] [--token <token>]

Collects host inventory and reports it to your lazyit instance. Config resolves from
flags > env (LAZYIT_URL / LAZYIT_TOKEN) > /etc/lazyit-agent/config. URL + token are required.

The scheduler ticks every ${AGENT_POLICY_TICK_SECONDS / 60} minutes on every platform; the REPORTING CADENCE is set
centrally in lazyit and enforced here, so a tick inside the interval exits without
reporting. Use --force to report anyway.

Options:
  --url <url>        Your lazyit instance base URL (e.g. https://lazyit.example.com)
  --token <token>    Service Account token holding the infra:report permission
  --interval <dur>   Legacy; ignored. Cadence is set in lazyit, not on the host.
  --once             Collect + report once, then exit (the default behaviour)
  --force            Report even if the interval has not elapsed
  -h, --help         Show this help

Local limits (/etc/lazyit-agent/config) — these VETO the server's policy, never widen it:
  LAZYIT_COLLECT_HARDWARE|DISKS|NICS|SOFTWARE|CONTAINERS=false
  LAZYIT_MIN_INTERVAL=<seconds>     never report more often than this
  LAZYIT_SOFTWARE_MAX=<n>           never report more packages than this
  LAZYIT_EXCLUDE_NICS|MOUNTPOINTS|SOFTWARE=<comma-separated globs>
`;

/**
 * Build + validate the report. Throws (caught by main) if collection produced something invalid.
 *
 * `cachedSoftwareHash` is the fingerprint of the list the server is believed to hold (#1142); when it
 * matches what was just collected AND `serverUnderstandsDelta` says the server can read an omission,
 * the list is omitted and only the fingerprint travels. Both conditions, never just the first: an
 * older server strips `softwareState` instead of rejecting it and would read the omission as "no
 * software". The returned `softwareHash` is what to persist AFTER the server accepts the report —
 * see {@link report}.
 */
async function buildReport(
  policy: AgentPolicy,
  cachedSoftwareHash: string | undefined,
  serverUnderstandsDelta: boolean,
): Promise<{ report: AgentReport; softwareHash: string | undefined }> {
  const startedAt = Date.now();
  const machineId = await readMachineId();
  if (!machineId) {
    throw new Error(
      "could not read /etc/machine-id (the dedup key) — is this a systemd Linux host?",
    );
  }

  // Every collector that degrades files a note here (#1138). They are gathered rather than logged so
  // they reach the SERVER: a warning in the host's own journal answers nobody's question about why an
  // inventory row looks empty — the operator is looking at the fleet, not at 40 journals.
  const warnings: string[] = [];
  const warn = (message: string) => {
    warnings.push(message);
  };

  const [host, collected] = await Promise.all([
    collectHost(warn, policy),
    collectSoftware(warn, policy),
  ]);
  // The delta (#1142): what this report SAYS about software, and what to remember if it lands.
  const { fields: software, cache: softwareHash } = softwareWireFields(
    collected,
    cachedSoftwareHash,
    serverUnderstandsDelta,
  );

  const report: AgentReport = {
    agentVersion: AGENT_VERSION,
    // Stable per install, scoped to this machine-id (ADR-0074 §2).
    reportingSource: `agent:${machineId.slice(0, 12)}`,
    externalId: machineId,
    reportedAt: new Date().toISOString(),
    host,
    ...software,
    diagnostics: buildDiagnostics(
      warnings,
      process.getuid?.() === 0,
      Date.now() - startedAt,
    ),
    // THE ECHO (#1140) — the generation this run actually collected under, which is what turns "we
    // pushed a policy" into "we can see this host running it". The local veto never changes the
    // revision, so this states "I have generation N", NOT "I obeyed all of it": a host that vetoes
    // software collection still echoes N, and that is correct — the veto is the host's answer to the
    // policy, not a different policy. Absent from a cache-less run only in the sense that the
    // built-in default carries revision 0, which is exactly what a never-configured instance serves.
    policyRevision: policy.revision,
  };

  // Validate against the shared contract BEFORE sending: a failure here is an agent bug, not a server
  // problem, so fail loudly rather than POST garbage the API would 400.
  const parsed = AgentReportSchema.safeParse(report);
  if (!parsed.success) {
    throw new Error(
      `internal: collected an invalid report — ${JSON.stringify(parsed.error.issues)}`,
    );
  }
  return { report: parsed.data, softwareHash };
}

/** Format the GiB string for the success summary (memory is reported in bytes). */
function gib(bytes: number | undefined): string {
  return bytes ? `${(bytes / 1024 ** 3).toFixed(1)} GiB` : "?";
}

/**
 * Budget for the whole POST (#1133). A black-holed TCP connection — a firewall that DROPs instead
 * of REJECTing is the everyday cause — otherwise hangs until systemd's default TimeoutStartSec
 * kills the unit, which is both slow and opaque. Bounding it here turns that into a clean, logged
 * "could not reach" the operator can act on, and the timer simply retries next tick.
 */
const REPORT_TIMEOUT_MS = 30_000;

async function report(
  url: string,
  token: string,
  policy: AgentPolicy,
  state: AgentState,
): Promise<void> {
  const { report: payload, softwareHash } = await buildReport(
    policy,
    state.softwareHash,
    // THE HANDSHAKE (#1142) — evidence a PREVIOUS ack gave us, never an assumption. Without it the
    // whole package list rides this report, which is what the agent did before the delta existed.
    state.softwareDelta === true,
  );
  const base = url.replace(/\/+$/, "");

  let res: Response;
  try {
    res = await fetch(`${base}/api/infra/report`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`could not reach ${base}/api/infra/report — ${(err as Error).message}`);
  }

  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 500);
    throw new Error(`report rejected — ${res.status} ${res.statusText}${body ? `\n${body}` : ""}`);
  }

  const ack = (await res.json().catch(() => null)) as
    | {
        nodeId?: string;
        state?: string;
        policy?: unknown;
        softwareResend?: unknown;
        softwareDelta?: unknown;
      }
    | null;
  const { hostname, cpu, memoryBytes } = payload.host;
  const where = ack?.nodeId ? ` → node ${ack.nodeId} [${ack.state ?? "?"}]` : "";
  console.log(
    `lazyit-agent: reported ${hostname} (cpu: ${cpu?.model ?? "?"}, mem: ${gib(memoryBytes)})${where}`,
  );
  // The same degradation notes that ride to the server, echoed locally: an operator running the agent
  // by hand after an install should see WHY a fact is missing without going to the UI (#1138).
  for (const warning of payload.diagnostics?.warnings ?? []) {
    console.warn(`lazyit-agent: ${warning}`);
  }

  // THE RESEND REQUEST (#1142). The server could not corroborate an `unchanged` claim — its stored
  // list is missing, or fingerprinted differently, or the claim reached it carrying no fingerprint at
  // all — so it kept what it had and asked for everything. That last case is why this build must
  // handle the request even though it always sends a fingerprint: one that outgrows
  // `AGENT_SOFTWARE_HASH_MAX` is dropped by `buildReport`'s own parse while the state survives.
  // Answering is simply forgetting: with no cached fingerprint the next run sends the whole list.
  const resend = ack?.softwareResend === true;
  if (resend) {
    console.log(
      "lazyit-agent: the server asked for the full software list — the next report will send it",
    );
  }

  // THE CAPABILITY (#1142). Re-read from EVERY ack rather than latched once, so it heals in both
  // directions: an upgraded instance starts advertising it and the next run starts saving payload, and
  // an instance rolled back below #1142 stops advertising it and the next run goes back to sending the
  // whole list. Absent means not proven — a pre-#1142 server, or an ack that could not be parsed.
  const understandsDelta = serverUnderstandsSoftwareDelta(ack);

  // The report SUCCEEDED, so this is the instant the cadence gate measures from, and the instant the
  // software fingerprint is worth keeping. It describes what a #1142 server now holds; against a server
  // that has not proved the capability nothing is ever omitted, so an inaccurate cache costs nothing. Both are written
  // before the policy, and independently of it: a host whose policy cache could not be written must
  // still not re-report on the next 5-minute tick.
  await writeState({
    lastSuccessMs: Date.now(),
    ...(softwareHash !== undefined && !resend ? { softwareHash } : {}),
    ...(understandsDelta ? { softwareDelta: true } : {}),
  }).catch((err: unknown) => {
    console.warn(
      `lazyit-agent: could not record the report time (${(err as Error).message}) — the next tick will report again`,
    );
  });

  // THE PICKUP (#1140). The ack's policy is cached VERBATIM and applied by the NEXT run, never this
  // one. The one-tick delay is the feature: a policy is only ever applied by a run that started
  // cleanly with it already on disk, so a bad policy cannot brick a fleet mid-collection and a
  // rollback lands one tick after it is saved. An ack with no policy (a server that predates this)
  // leaves the cache exactly as it was.
  if (ack?.policy !== undefined) {
    const parsed = AgentPolicySchema.safeParse(ack.policy);
    if (!parsed.success) {
      // The report direction degrades on purpose; THIS direction must not. A policy this build
      // cannot fully validate is one it must not write to disk and act on as root next tick.
      console.warn(
        "lazyit-agent: the server sent a policy this build does not understand — keeping the cached one. Upgrade the agent.",
      );
    } else {
      // Written on EVERY report, not only when the revision moved: the write is a few hundred bytes
      // once per interval, and rewriting unconditionally is what lets a deleted or corrupted cache
      // heal itself on the next check-in instead of leaving the host silently on the defaults.
      await writeCachedPolicy(parsed.data).then(
        () => {
          if (parsed.data.revision !== policy.revision) {
            console.log(
              `lazyit-agent: agent policy v${parsed.data.revision} cached — it applies from the next run`,
            );
          }
        },
        (err: unknown) =>
          console.warn(
            `lazyit-agent: could not cache the agent policy (${(err as Error).message}) — this host keeps running v${policy.revision}`,
          ),
      );
    }
  }
}

async function main(): Promise<void> {
  const cfg = await loadConfig(Bun.argv.slice(2));

  if (cfg.help) {
    console.log(HELP);
    return;
  }
  if (cfg.command !== "report") {
    throw new Error(`unknown command "${cfg.command}" — try: lazyit-agent report --once`);
  }
  if (!cfg.url || !cfg.token) {
    throw new Error(
      "missing URL and/or token — pass --url/--token, set LAZYIT_URL/LAZYIT_TOKEN, or write /etc/lazyit-agent/config",
    );
  }

  // THE INTERVAL INVERSION (#1140). Load the policy the LAST run cached, intersect it with whatever
  // this host's own config file refuses to do, and only then decide whether this tick reports.
  //
  // The veto is applied BEFORE the due gate on purpose: `minIntervalSeconds` is one of the limits,
  // so a host that refuses to report more than hourly must have that respected by the gate itself,
  // not merely by what it collects.
  const cached = await loadCachedPolicy();
  const policy = applyAgentPolicyVeto(cached, cfg.localLimits);
  // Read ONCE and carried into the report: the same file holds the cadence clock and the software
  // fingerprint (#1142), and re-reading it after the due gate would only invite the two to disagree.
  const state = await loadState();

  if (!cfg.force) {
    const machineId = (await readMachineId()) ?? "";
    const { lastSuccessMs } = state;
    if (
      !agentPolicyDue({
        nowMs: Date.now(),
        lastSuccessMs,
        policy,
        machineId,
      })
    ) {
      // A NO-OP tick, and the reason it is safe for the scheduler to fire every few minutes on
      // every platform. Deliberately quiet at log level `log`, not `warn`: this is the normal
      // outcome of most ticks and journald should not read it as a problem.
      const waited = lastSuccessMs !== undefined ? Math.round((Date.now() - lastSuccessMs) / 60_000) : 0;
      console.log(
        `lazyit-agent: not due yet (policy v${policy.revision} reports every ${Math.round(policy.intervalSeconds / 60)} min; last report ${waited} min ago) — nothing to do`,
      );
      return;
    }
  }

  await report(cfg.url, cfg.token, policy, state);
}

main().catch((err: unknown) => {
  console.error(`lazyit-agent: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
