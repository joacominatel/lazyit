#!/usr/bin/env bun
/**
 * lazyit server reporting agent (ADR-0074 §7) — a Bun single-file executable, Linux-only collector.
 *
 * It reads its config (flags > env > /etc/lazyit-agent/config), gathers best-effort host facts,
 * validates the result against the SAME `AgentReportSchema` the API enforces (imported from
 * `@lazyit/shared` — zero drift, the whole point), then POSTs it to `${url}/api/infra/report` with the
 * Service Account bearer token. Default mode (`report --once`) does one collect + POST and exits — the
 * systemd timer (install.sh) owns scheduling, so there is no long-lived process.
 */
import { AgentReportSchema, type AgentReport } from "@lazyit/shared";
import { loadConfig } from "./config";
import { collectHost, collectSoftware, readMachineId } from "./collect";

// ponytail: keep in sync with package.json `version` (a 1-line bump); not worth a JSON-import build dep.
const AGENT_VERSION = "0.1.0";

const HELP = `lazyit-agent ${AGENT_VERSION} — server reporting agent (Linux)

Usage:
  lazyit-agent [report] [--once] [--url <url>] [--token <token>] [--interval <dur>]

Collects host inventory and reports it to your lazyit instance. Config resolves from
flags > env (LAZYIT_URL / LAZYIT_TOKEN) > /etc/lazyit-agent/config. URL + token are required.

Options:
  --url <url>        Your lazyit instance base URL (e.g. https://lazyit.example.com)
  --token <token>    Service Account token holding the infra:report permission
  --interval <dur>   Reporting cadence (used by the systemd timer, not the binary)
  --once             Collect + report once, then exit (the default behaviour)
  -h, --help         Show this help
`;

/** Build + validate the report. Throws (caught by main) if collection produced something invalid. */
async function buildReport(): Promise<AgentReport> {
  const machineId = await readMachineId();
  if (!machineId) {
    throw new Error(
      "could not read /etc/machine-id (the dedup key) — is this a systemd Linux host?",
    );
  }

  const [host, software] = await Promise.all([collectHost(), collectSoftware()]);

  const report: AgentReport = {
    agentVersion: AGENT_VERSION,
    // Stable per install, scoped to this machine-id (ADR-0074 §2).
    reportingSource: `agent:${machineId.slice(0, 12)}`,
    externalId: machineId,
    reportedAt: new Date().toISOString(),
    host,
    ...(software ? { software } : {}),
  };

  // Validate against the shared contract BEFORE sending: a failure here is an agent bug, not a server
  // problem, so fail loudly rather than POST garbage the API would 400.
  const parsed = AgentReportSchema.safeParse(report);
  if (!parsed.success) {
    throw new Error(
      `internal: collected an invalid report — ${JSON.stringify(parsed.error.issues)}`,
    );
  }
  return parsed.data;
}

/** Format the GiB string for the success summary (memory is reported in bytes). */
function gib(bytes: number | undefined): string {
  return bytes ? `${(bytes / 1024 ** 3).toFixed(1)} GiB` : "?";
}

async function report(url: string, token: string): Promise<void> {
  const payload = await buildReport();
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
    });
  } catch (err) {
    throw new Error(`could not reach ${base}/api/infra/report — ${(err as Error).message}`);
  }

  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 500);
    throw new Error(`report rejected — ${res.status} ${res.statusText}${body ? `\n${body}` : ""}`);
  }

  const ack = (await res.json().catch(() => null)) as
    | { nodeId?: string; state?: string }
    | null;
  const { hostname, cpu, memoryBytes } = payload.host;
  const where = ack?.nodeId ? ` → node ${ack.nodeId} [${ack.state ?? "?"}]` : "";
  console.log(
    `lazyit-agent: reported ${hostname} (cpu: ${cpu?.model ?? "?"}, mem: ${gib(memoryBytes)})${where}`,
  );
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

  await report(cfg.url, cfg.token);
}

main().catch((err: unknown) => {
  console.error(`lazyit-agent: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
