/**
 * Linux host fact collection (ADR-0074 §7). Every fact is BEST-EFFORT: a missing tool, missing file
 * or missing privilege is silently omitted, never fatal — a partial report is valid (ADR-0074 §2/§3).
 * The only hard requirements are `hostname` (always available) and `/etc/machine-id` (the dedup key,
 * handled by the caller). Linux-only by design; the wire contract stays OS-neutral for future targets.
 */
import { $ } from "bun";
import { hostname as osHostname } from "node:os";
import type { AgentReport } from "@lazyit/shared";

type Host = AgentReport["host"];
type Software = NonNullable<AgentReport["software"]>;

/** Run a command, returning stdout on success or null on ANY failure (missing binary, non-zero, …). */
async function run(...args: string[]): Promise<string | null> {
  try {
    const res = await $`${args}`.quiet().nothrow();
    return res.exitCode === 0 ? res.stdout.toString() : null;
  } catch {
    return null;
  }
}

/** Read a file as text, or null if it does not exist / is unreadable. */
async function readText(path: string): Promise<string | null> {
  try {
    return await Bun.file(path).text();
  } catch {
    return null;
  }
}

/** Drop undefined/null/empty-string values; return undefined if nothing survives (omit the key). */
function clean<T extends Record<string, unknown>>(obj: T): T | undefined {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && v !== "") out[k] = v;
  }
  return Object.keys(out).length ? (out as T) : undefined;
}

/** Parse a `KEY=VALUE` blob (os-release style), stripping surrounding quotes. */
function parseKeyVal(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const eq = raw.indexOf("=");
    if (eq === -1) continue;
    const key = raw.slice(0, eq).trim();
    out[key] = raw.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/** `/etc/machine-id` (the stable per-OS-install dedup key), falling back to the D-Bus location. */
export async function readMachineId(): Promise<string | null> {
  const id =
    (await readText("/etc/machine-id")) ?? (await readText("/var/lib/dbus/machine-id"));
  const trimmed = id?.trim();
  return trimmed ? trimmed : null;
}

function collectOs(osRelease: string | null, kernel: string | null): Host["os"] {
  const kv = osRelease ? parseKeyVal(osRelease) : {};
  return clean({
    name: kv.NAME,
    version: kv.VERSION_ID,
    kernel: kernel?.trim(),
  });
}

function collectCpu(cpuinfo: string | null): Host["cpu"] {
  if (!cpuinfo) return undefined;
  const model = cpuinfo.match(/^model name\s*:\s*(.+)$/m)?.[1]?.trim();
  const cores = cpuinfo.match(/^processor\s*:/gm)?.length;
  return clean({ model, cores });
}

function collectMemoryBytes(meminfo: string | null): number | undefined {
  const kb = meminfo?.match(/^MemTotal:\s*(\d+)\s*kB/m)?.[1];
  return kb ? Number(kb) * 1024 : undefined;
}

interface LsblkDevice {
  name?: string;
  size?: number | string;
  type?: string;
  mountpoint?: string | null;
  children?: LsblkDevice[];
}

async function collectDisks(): Promise<Host["disks"]> {
  const out = await run("lsblk", "-bJ", "-o", "NAME,SIZE,TYPE,MOUNTPOINT");
  if (!out) return undefined;
  let parsed: { blockdevices?: LsblkDevice[] };
  try {
    parsed = JSON.parse(out);
  } catch {
    return undefined;
  }
  const disks = (parsed.blockdevices ?? [])
    .filter((d) => d.type === "disk" && d.name)
    .map((d) => {
      const mountpoint =
        d.mountpoint ?? d.children?.find((c) => c.mountpoint)?.mountpoint ?? undefined;
      return clean({
        device: `/dev/${d.name}`,
        sizeBytes: d.size != null ? Number(d.size) : undefined,
        mountpoint: mountpoint ?? undefined,
      });
    })
    .filter((d): d is NonNullable<typeof d> => d !== undefined);
  return disks.length ? disks.slice(0, 256) : undefined;
}

interface IpAddr {
  ifname?: string;
  address?: string;
  addr_info?: Array<{ family?: string; local?: string }>;
}

async function collectNics(): Promise<Host["nics"]> {
  const out = await run("ip", "-j", "addr");
  if (!out) return undefined;
  let parsed: IpAddr[];
  try {
    parsed = JSON.parse(out);
  } catch {
    return undefined;
  }
  const nics: NonNullable<Host["nics"]> = [];
  for (const n of parsed) {
    const name = n.ifname;
    if (!name || name === "lo") continue;
    const ipv4 = (n.addr_info ?? [])
      .filter((a) => a.family === "inet" && a.local)
      .map((a) => a.local as string);
    const nic: NonNullable<Host["nics"]>[number] = { name };
    if (n.address) nic.mac = n.address;
    if (ipv4.length) nic.ipv4 = ipv4.slice(0, 64);
    nics.push(nic);
  }
  return nics.length ? nics.slice(0, 64) : undefined;
}

/** dmidecode facts — ROOT ONLY (and only if dmidecode is installed); degrade silently otherwise. */
async function collectHardware(): Promise<Host["hardware"]> {
  if (process.getuid?.() !== 0) return undefined;
  const [manufacturer, model, serial] = await Promise.all([
    run("dmidecode", "-s", "system-manufacturer"),
    run("dmidecode", "-s", "system-product-name"),
    run("dmidecode", "-s", "system-serial-number"),
  ]);
  return clean({
    manufacturer: manufacturer?.trim(),
    model: model?.trim(),
    serial: serial?.trim(),
  });
}

const SOFTWARE_CAP = 5000; // matches AgentReportSchema's software array max

/** Parse `name<TAB>version` lines (dpkg-query / rpm output). */
function parseTabbed(out: string | null): Software {
  if (!out) return [];
  const pkgs: Software = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [name, version] = line.split("\t");
    if (name?.trim()) pkgs.push(clean({ name: name.trim(), version: version?.trim() })!);
  }
  return pkgs;
}

/**
 * Parse `apk info -v` lines like `musl-1.2.4-r2` into name + version. apk has no field-format flag, so
 * we split on the `-<pkgver>-r<pkgrel>` tail. // ponytail: a pathological package name could fool the
 * regex; the worst case is a slightly-off name/version string, never a crash or an invalid report.
 */
function parseApk(out: string | null): Software {
  if (!out) return [];
  const pkgs: Software = [];
  for (const raw of out.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(.+)-([^-]+-r\d+)$/);
    if (m?.[1]) pkgs.push({ name: m[1], version: m[2] });
    else pkgs.push({ name: line });
  }
  return pkgs;
}

/** Auto-detect the package manager (dpkg → rpm → apk) and list installed packages, capped. */
export async function collectSoftware(): Promise<Software | undefined> {
  let pkgs: Software = [];
  if (Bun.which("dpkg-query")) {
    pkgs = parseTabbed(await run("dpkg-query", "-W", "-f=${Package}\\t${Version}\\n"));
  } else if (Bun.which("rpm")) {
    pkgs = parseTabbed(await run("rpm", "-qa", "--qf", "%{NAME}\\t%{VERSION}-%{RELEASE}\\n"));
  } else if (Bun.which("apk")) {
    pkgs = parseApk(await run("apk", "info", "-v"));
  }
  return pkgs.length ? pkgs.slice(0, SOFTWARE_CAP) : undefined;
}

/** Gather the full `host` block of an AgentReport (hostname is the only guaranteed field). */
export async function collectHost(): Promise<Host> {
  const [osRelease, kernel, cpuinfo, meminfo, disks, nics, hardware] = await Promise.all([
    readText("/etc/os-release"),
    readText("/proc/sys/kernel/osrelease"),
    readText("/proc/cpuinfo"),
    readText("/proc/meminfo"),
    collectDisks(),
    collectNics(),
    collectHardware(),
  ]);

  const host: Host = { hostname: osHostname() || "unknown" };
  const os = collectOs(osRelease, kernel);
  const cpu = collectCpu(cpuinfo);
  const memoryBytes = collectMemoryBytes(meminfo);
  if (os) host.os = os;
  if (cpu) host.cpu = cpu;
  if (memoryBytes !== undefined) host.memoryBytes = memoryBytes;
  if (disks) host.disks = disks;
  if (nics) host.nics = nics;
  if (hardware) host.hardware = hardware;
  return host;
}
