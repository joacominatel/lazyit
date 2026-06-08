import * as net from 'node:net';

/**
 * IP-range classification for the egress (anti-SSRF) guard.
 *
 * The single rule this module encodes: given a *resolved* IP address (never a hostname string), decide
 * whether it is safe to dial. We do this by **parsing the address into its bytes and matching CIDR
 * ranges** — never by string/prefix sniffing (the SEC-008 / SEC-051 lesson: a regex that sniffs a URL
 * or address prefix is repeatedly bypassable). All obfuscated IPv4 encodings (decimal `2130706433`,
 * hex `0x7f000001`, octal `0177.0.0.1`) are already normalized to dotted-quad by the WHATWG `URL`
 * parser before they reach here, so this module only has to handle canonical IPv4 / IPv6 literals.
 *
 * Categories split into three policy buckets (see {@link isAllowlistableCategory} /
 * {@link isPublicCategory}):
 *   - `global`                         → public Internet, allowed by default.
 *   - `private` (IPv4 RFC1918) and
 *     `uniqueLocal` (IPv6 ULA fc00::/7) → genuine internal LAN targets (e.g. `vpn.corp.local`).
 *                                         DENIED by default, allowlistable ONLY via the explicit,
 *                                         audited per-connector seam (deny-private-by-default).
 *   - everything else (loopback, IMDS, link-local, unspecified, CGNAT, multicast, broadcast,
 *     reserved/documentation)          → HARD-DENIED, NEVER allowlistable. localhost and the cloud
 *                                         metadata IP (169.254.169.254 / fd00:ec2::254) live here, so
 *                                         they can never be reached, by construction.
 */
export type AddressCategory =
  | 'global'
  | 'private'
  | 'uniqueLocal'
  | 'loopback'
  | 'linkLocal'
  | 'imds'
  | 'unspecified'
  | 'cgnat'
  | 'multicast'
  | 'broadcast'
  | 'reserved';

/** Categories an admin MAY allowlist as an internal target (genuine LAN unicast). */
const ALLOWLISTABLE: ReadonlySet<AddressCategory> = new Set<AddressCategory>(['private', 'uniqueLocal']);

/** `true` for a public-Internet address (allowed without any allowlist). */
export function isPublicCategory(category: AddressCategory): boolean {
  return category === 'global';
}

/**
 * `true` only for categories that MAY be reached via the explicit internal-target allowlist seam
 * (RFC1918 / ULA). loopback, IMDS, link-local, unspecified, CGNAT, multicast, broadcast and reserved
 * are NEVER allowlistable and always return `false`.
 */
export function isAllowlistableCategory(category: AddressCategory): boolean {
  return ALLOWLISTABLE.has(category);
}

/** Parse a dotted-quad IPv4 string into an unsigned 32-bit integer, or `null` if malformed. */
function ipv4ToInt(value: string): number | null {
  const parts = value.split('.');
  if (parts.length !== 4) {
    return null;
  }
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
    const octet = Number(part);
    if (octet > 255) {
      return null;
    }
    result = result * 256 + octet;
  }
  return result;
}

/** Convert a list of IPv6 hextet/embedded-IPv4 groups into bytes, or `null` if any group is invalid. */
function groupsToBytes(groups: string[]): number[] | null {
  const out: number[] = [];
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    if (group.includes('.')) {
      // An embedded IPv4 tail (e.g. `::ffff:127.0.0.1`) is only legal as the final group.
      if (i !== groups.length - 1) {
        return null;
      }
      const v4 = ipv4ToInt(group);
      if (v4 === null) {
        return null;
      }
      out.push((v4 >>> 24) & 0xff, (v4 >>> 16) & 0xff, (v4 >>> 8) & 0xff, v4 & 0xff);
    } else {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) {
        return null;
      }
      const n = parseInt(group, 16);
      out.push((n >> 8) & 0xff, n & 0xff);
    }
  }
  return out;
}

/** Expand an IPv6 literal (with optional `::` compression / embedded IPv4) into its 16 bytes. */
function ipv6ToBytes(input: string): Uint8Array | null {
  // Drop any zone id (`fe80::1%eth0`) before parsing — it never changes the range classification.
  const zone = input.indexOf('%');
  const value = zone === -1 ? input : input.slice(0, zone);
  if (!value) {
    return null;
  }

  const halves = value.split('::');
  if (halves.length > 2) {
    return null;
  }

  if (halves.length === 1) {
    const bytes = groupsToBytes(value.split(':'));
    if (!bytes || bytes.length !== 16) {
      return null;
    }
    return Uint8Array.from(bytes);
  }

  const head = halves[0] ? groupsToBytes(halves[0].split(':')) : [];
  const tail = halves[1] ? groupsToBytes(halves[1].split(':')) : [];
  if (head === null || tail === null) {
    return null;
  }
  const fill = 16 - head.length - tail.length;
  if (fill < 0) {
    return null;
  }
  const bytes = [...head, ...new Array<number>(fill).fill(0), ...tail];
  if (bytes.length !== 16) {
    return null;
  }
  return Uint8Array.from(bytes);
}

/** Classify an unsigned 32-bit IPv4 integer. */
function classifyIpv4Int(ip: number): AddressCategory {
  if (ip === 0xffffffff) {
    return 'broadcast';
  }
  const a = (ip >>> 24) & 0xff;
  const b = (ip >>> 16) & 0xff;
  const c = (ip >>> 8) & 0xff;

  if (a === 0) {
    return 'unspecified'; // 0.0.0.0/8 ("this host")
  }
  if (a === 10) {
    return 'private'; // 10.0.0.0/8
  }
  if (a === 127) {
    return 'loopback'; // 127.0.0.0/8
  }
  if (a === 169 && b === 254) {
    // 169.254.0.0/16 link-local — and the cloud metadata service inside it.
    return ip === 0xa9fea9fe ? 'imds' : 'linkLocal';
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return 'private'; // 172.16.0.0/12
  }
  if (a === 192 && b === 168) {
    return 'private'; // 192.168.0.0/16
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return 'cgnat'; // 100.64.0.0/10 (carrier-grade NAT)
  }
  if (a >= 224 && a <= 239) {
    return 'multicast'; // 224.0.0.0/4
  }
  if (a >= 240) {
    return 'reserved'; // 240.0.0.0/4 (future use; 255.255.255.255 handled above)
  }
  // Documentation / special-use ranges that should never be a connector target.
  if (a === 192 && b === 0 && (c === 0 || c === 2)) {
    return 'reserved'; // 192.0.0.0/24 (IETF) + 192.0.2.0/24 (TEST-NET-1)
  }
  if (a === 192 && b === 88 && c === 99) {
    return 'reserved'; // 192.88.99.0/24 (6to4 relay anycast)
  }
  if (a === 198 && (b === 18 || b === 19)) {
    return 'reserved'; // 198.18.0.0/15 (benchmarking)
  }
  if (a === 198 && b === 51 && c === 100) {
    return 'reserved'; // 198.51.100.0/24 (TEST-NET-2)
  }
  if (a === 203 && b === 0 && c === 113) {
    return 'reserved'; // 203.0.113.0/24 (TEST-NET-3)
  }
  return 'global';
}

/** The exact bytes of the AWS IPv6 instance-metadata address `fd00:ec2::254` (never allowlistable). */
const IMDS_V6 = [0xfd, 0x00, 0x0e, 0xc2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x02, 0x54];

/** Classify the 16 bytes of an IPv6 address. */
function classifyIpv6Bytes(b: Uint8Array): AddressCategory {
  const allZeroUpTo = (end: number): boolean => {
    for (let i = 0; i < end; i++) {
      if (b[i] !== 0) {
        return false;
      }
    }
    return true;
  };

  if (allZeroUpTo(16)) {
    return 'unspecified'; // ::
  }
  if (allZeroUpTo(15) && b[15] === 1) {
    return 'loopback'; // ::1
  }
  // IPv4-mapped ::ffff:0:0/96 — re-classify the embedded IPv4 (so ::ffff:127.0.0.1 is loopback).
  if (allZeroUpTo(10) && b[10] === 0xff && b[11] === 0xff) {
    return classifyIpv4Int(((b[12] << 24) >>> 0) + (b[13] << 16) + (b[14] << 8) + b[15]);
  }
  // IPv4-compatible ::/96 (deprecated) — also embeds an IPv4 address.
  if (allZeroUpTo(12)) {
    return classifyIpv4Int(((b[12] << 24) >>> 0) + (b[13] << 16) + (b[14] << 8) + b[15]);
  }
  // NAT64 well-known prefix 64:ff9b::/96 — bytes 4..11 are zero, last 4 embed an IPv4 address.
  if (
    b[0] === 0x00 &&
    b[1] === 0x64 &&
    b[2] === 0xff &&
    b[3] === 0x9b &&
    b[4] === 0 &&
    b[5] === 0 &&
    b[6] === 0 &&
    b[7] === 0 &&
    b[8] === 0 &&
    b[9] === 0 &&
    b[10] === 0 &&
    b[11] === 0
  ) {
    return classifyIpv4Int(((b[12] << 24) >>> 0) + (b[13] << 16) + (b[14] << 8) + b[15]);
  }
  if (IMDS_V6.every((x, i) => b[i] === x)) {
    return 'imds'; // fd00:ec2::254 (sits inside ULA, but never allowlistable)
  }
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) {
    return 'linkLocal'; // fe80::/10
  }
  if ((b[0] & 0xfe) === 0xfc) {
    return 'uniqueLocal'; // fc00::/7 (ULA)
  }
  if (b[0] === 0xff) {
    return 'multicast'; // ff00::/8
  }
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) {
    return 'reserved'; // 2001:db8::/32 (documentation)
  }
  if (b[0] === 0x01 && b[1] === 0x00 && allZeroUpTo(8)) {
    return 'reserved'; // 100::/64 (discard-only)
  }
  return 'global';
}

/**
 * Classify a resolved IP address into an {@link AddressCategory}. `family` (4 or 6) may be supplied
 * (e.g. from `dns.lookup`); otherwise it is detected. Fails CLOSED: anything that is not a parseable
 * IP literal returns `reserved` (hard-denied) rather than being treated as global.
 */
export function classifyIp(address: string, family?: 4 | 6): AddressCategory {
  const detected = family ?? net.isIP(address);
  if (detected === 4 || (detected === 0 && net.isIPv4(address))) {
    const ip = ipv4ToInt(address);
    return ip === null ? 'reserved' : classifyIpv4Int(ip);
  }
  if (detected === 6 || net.isIPv6(address)) {
    const bytes = ipv6ToBytes(address);
    return bytes === null ? 'reserved' : classifyIpv6Bytes(bytes);
  }
  return 'reserved';
}
