import { z } from "zod";

/**
 * Infra node fact HISTORY (ADR-0074 §3 amendment, issue #1143) — the wire shape of one recorded
 * change, and the pure diff that decides when a change exists at all.
 *
 * The problem it solves is stated as a question an operator actually asks: *"someone upgraded
 * OpenSSL on db-01 last Tuesday and broke the app."* Until this, the estate stored only the CURRENT
 * value of every fact, which `dpkg -l` over SSH also gives you. Storing the DIFF is what makes it a
 * CMDB.
 *
 * WHY A DIFF AND NOT AN EVENT PER REPORT. `syncAssetSpecs` deliberately bypasses `AssetsService.update`
 * so no `SPECS_CHANGED` history event fires per report — at the shipped cadence that would be ~96
 * no-op audit rows per host per day. That reasoning stands. What is logged here is what MOVED, so a
 * host nobody touched writes nothing at all, forever.
 *
 * The diff lives in `@lazyit/shared` because it is pure, framework-agnostic and the thing most worth
 * testing: every input it takes comes out of a jsonb column, so none of it is known to have the shape
 * it should. Everything below reads TOLERANTLY and answers "no change" on anything it cannot read —
 * the same degrade-never-reject posture the report contract is built on. It is never a throw on the
 * report path.
 */

/** What KIND of move a recorded row describes. Package rows carry the package name in `fact`. */
export const InfraFactChangeKindSchema = z.enum([
  "PACKAGE_ADDED", // the package was not installed at the previous observation and now is
  "PACKAGE_REMOVED", // it was installed and now is not
  "PACKAGE_VERSION", // still installed, different version (an upgrade OR a downgrade — both matter)
  "FACT_CHANGED", // a tracked host or container fact moved from one known value to another
]);
export type InfraFactChangeKind = z.infer<typeof InfraFactChangeKindSchema>;

/**
 * Cap on a stored `fact` key — exactly the report contract's own package-name ceiling, since a package
 * name IS a fact key here. No real name reaches it, and every tracked host/container key is far
 * shorter; it exists so a hand-rolled client cannot make this column the widest thing in the table.
 */
export const INFRA_FACT_CHANGE_FACT_MAX = 255;
/**
 * Cap on a stored value, set to the widest tracked fact the contract admits: `container.image` at 300
 * (`os.*` and `hardware.serial` are 200, a package version 120). Chosen so nothing this table records
 * is ever truncated in normal operation — a truncated image tag is a value an operator would compare
 * against a real one and get a wrong answer from.
 */
export const INFRA_FACT_CHANGE_VALUE_MAX = 300;

/**
 * One change the ingest path is about to record — the pure diff's output, before it becomes a row.
 *
 * `previousValue`/`currentValue` are absent rather than empty when the kind makes them meaningless:
 * a `PACKAGE_ADDED` has no previous value, a `PACKAGE_REMOVED` no current one, and a package that
 * moved between "installed, version unknown" and "installed, 3.0.13" legitimately has only one side.
 */
export interface InfraFactChangeDraft {
  kind: InfraFactChangeKind;
  fact: string;
  previousValue?: string;
  currentValue?: string;
}

/** One recorded change as the API serves it. Append-only: `createdAt`, no `updatedAt`/`deletedAt`. */
export const InfraNodeFactChangeSchema = z.object({
  /** Autoincrement (ADR-0005: logs/history) — also the pagination cursor, newest first. */
  id: z.number().int(),
  nodeId: z.string(),
  kind: InfraFactChangeKindSchema,
  /** The package name, or a tracked fact key such as `host.os.kernel` / `container.imageDigest`. */
  fact: z.string(),
  previousValue: z.string().nullable(),
  currentValue: z.string().nullable(),
  /** When the SERVER recorded it — within seconds of the report that carried the change. */
  createdAt: z.iso.datetime(),
});
export type InfraNodeFactChange = z.infer<typeof InfraNodeFactChangeSchema>;

/** A page of a node's change history, newest first. `nextCursor` is null on the last page. */
export const InfraNodeFactChangeListSchema = z.object({
  items: z.array(InfraNodeFactChangeSchema),
  nextCursor: z.number().int().nullable(),
});
export type InfraNodeFactChangeList = z.infer<typeof InfraNodeFactChangeListSchema>;

/** Default page size for the Changes tab. */
export const INFRA_FACT_CHANGE_PAGE_SIZE = 50;
/** Ceiling on a requested page size — the panel paginates, it does not export. */
export const INFRA_FACT_CHANGE_PAGE_SIZE_MAX = 200;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A nested value read tolerantly: any non-object on the way down answers `undefined`. */
function at(root: unknown, path: readonly string[]): unknown {
  let cursor: unknown = root;
  for (const key of path) {
    if (!isPlainObject(cursor)) return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

/**
 * A tracked value rendered for storage, or `undefined` when the fact is not readable.
 *
 * Only strings and finite numbers count. Anything else — an object where a scalar belongs, a NaN a
 * hand-edited blob put there — reads as "this fact is not observable", which the comparison below
 * treats as no evidence rather than as a change.
 */
function scalar(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length ? trimmed.slice(0, INFRA_FACT_CHANGE_VALUE_MAX) : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

/**
 * The host facts worth a history row, in the order they are recorded.
 *
 * Deliberately SHORT, and it is the whole vocabulary: an OS or kernel move (the patch window), a
 * memory or disk move (the box was resized), and the hardware serial (the chassis was swapped, or two
 * machines are colliding on one node). Everything else the report carries — hostname, NICs, IPs,
 * bootedAt, container state — is either already visible elsewhere or moves for reasons that are not
 * inventory changes, and a history nobody trusts is worse than none.
 */
const TRACKED_HOST_FACTS: readonly {
  fact: string;
  read: (host: unknown) => string | undefined;
}[] = [
  { fact: "host.os.name", read: (h) => scalar(at(h, ["os", "name"])) },
  { fact: "host.os.version", read: (h) => scalar(at(h, ["os", "version"])) },
  { fact: "host.os.kernel", read: (h) => scalar(at(h, ["os", "kernel"])) },
  { fact: "host.memoryBytes", read: (h) => scalar(at(h, ["memoryBytes"])) },
  { fact: "host.disks.totalBytes", read: (h) => diskTotalBytes(at(h, ["disks"])) },
  { fact: "host.disks.count", read: (h) => diskCount(at(h, ["disks"])) },
  { fact: "host.hardware.serial", read: (h) => scalar(at(h, ["hardware", "serial"])) },
];

/**
 * Total known disk capacity — the answer to *"was this volume grown?"*.
 *
 * Summed rather than recorded per device on purpose: a per-device row would make every ephemeral
 * loop/overlay mount a change, and the operator question is about capacity. A disks array carrying no
 * readable size at all answers `undefined` (no evidence), never `0` — otherwise an unprivileged
 * report would read as "all storage disappeared".
 */
function diskTotalBytes(disks: unknown): string | undefined {
  if (!Array.isArray(disks)) return undefined;
  let total = 0;
  let seen = false;
  for (const disk of disks) {
    const size = isPlainObject(disk) ? disk.sizeBytes : undefined;
    if (typeof size === "number" && Number.isFinite(size)) {
      total += size;
      seen = true;
    }
  }
  return seen ? String(total) : undefined;
}

/**
 * How many disks the host reports — a device added or removed at unchanged total capacity.
 *
 * Only readable disk RECORDS are counted, and a list carrying none answers `undefined` (no evidence),
 * never `0` — exactly the guard {@link diskTotalBytes} already applies, for a sharper reason. An
 * agent policy that excludes every mountpoint (#1140) sends `disks: []` on purpose: `applyDiskPolicy`
 * returns an empty array rather than omitting the fact, because "the policy matched them all" is a
 * positive answer about the COLLECTOR. It says nothing about the hardware. Counting it would render
 * an operator's own policy edit as `host.disks.count 2 → 0` — a chassis losing all of its storage,
 * which is precisely the reading a history nobody can trust would put on screen.
 */
function diskCount(disks: unknown): string | undefined {
  if (!Array.isArray(disks)) return undefined;
  let seen = 0;
  for (const disk of disks) {
    if (isPlainObject(disk)) seen += 1;
  }
  return seen > 0 ? String(seen) : undefined;
}

/**
 * Compare one fact across two observations.
 *
 * TWO ABSENCES ARE DELIBERATELY SILENT, and they are the two that would otherwise flood the table:
 *
 *  - **No previous value ⇒ no row.** The first observation of a fact SEEDS the baseline. This is what
 *    stops the first report after this ships from diffing a whole host against nothing, and it is the
 *    same rule for a brand-new node, a node enrolled before this feature, and a fact that simply had
 *    never been collected on this host before.
 *  - **No current value ⇒ no row.** A fact that DISAPPEARS is a collector that lost a capability — an
 *    agent downgraded, dmidecode no longer readable because the unit stopped running as root — not a
 *    host whose serial was removed. Recording it would put a change on screen that never happened.
 *
 * A row is written only when BOTH sides are readable and they differ.
 */
function compareFacts(
  tracked: typeof TRACKED_HOST_FACTS,
  previous: unknown,
  next: unknown,
): InfraFactChangeDraft[] {
  const changes: InfraFactChangeDraft[] = [];
  for (const { fact, read } of tracked) {
    const before = read(previous);
    const after = read(next);
    if (before === undefined || after === undefined || before === after) continue;
    changes.push({
      kind: "FACT_CHANGED",
      fact,
      previousValue: before,
      currentValue: after,
    });
  }
  return changes;
}

/**
 * What moved between two stored `specs.host` blocks (#1143).
 *
 * `previousHost` is whatever the node's column held — possibly `undefined`, possibly hand-edited into
 * a shape that is not a host block at all. Both read as "no baseline", which seeds silently.
 */
export function diffHostFacts(previousHost: unknown, nextHost: unknown): InfraFactChangeDraft[] {
  return compareFacts(TRACKED_HOST_FACTS, previousHost, nextHost);
}

/**
 * The container facts worth a row (#1139/#1157 gave a container child its own `specs`).
 *
 * `image` and `imageDigest` ONLY. A container whose digest moved under an unchanged `:latest` tag is
 * the single most useful change this table can record — it is precisely the deploy nobody remembers
 * doing — and the tag itself answers the ordinary version question.
 *
 * `state` is excluded on purpose: it is LIVENESS, it already drives the child node's `status` column,
 * and a container that restarts nightly would otherwise write two rows a day forever. `ports` is
 * excluded because a published-port change is a compose edit the operator just made, and the shape is
 * an array whose ordering the runtime does not promise.
 */
const TRACKED_CONTAINER_FACTS: readonly {
  fact: string;
  read: (container: unknown) => string | undefined;
}[] = [
  { fact: "container.image", read: (c) => scalar(at(c, ["image"])) },
  { fact: "container.imageDigest", read: (c) => scalar(at(c, ["imageDigest"])) },
];

/** What moved between two stored `specs.container` blocks (#1143). Same seeding rules as the host. */
export function diffContainerFacts(
  previousContainer: unknown,
  nextContainer: unknown,
): InfraFactChangeDraft[] {
  return compareFacts(TRACKED_CONTAINER_FACTS, previousContainer, nextContainer);
}

/** A package list read tolerantly into name → version. Malformed elements are dropped, never thrown on. */
function packageVersions(list: unknown): Map<string, string | undefined> | undefined {
  if (!Array.isArray(list)) return undefined;
  const byName = new Map<string, string | undefined>();
  for (const entry of list) {
    if (!isPlainObject(entry)) continue;
    const name = scalar(entry.name);
    if (name === undefined) continue;
    // Last one wins, which only matters for a list that lists a package twice.
    byName.set(name.slice(0, INFRA_FACT_CHANGE_FACT_MAX), scalar(entry.version));
  }
  return byName;
}

/**
 * What moved between two package lists (#1143) — the row set behind *"when did OpenSSL change?"*.
 *
 * THREE SILENCES, each of which would otherwise be a flood:
 *
 *  - A node that held NO readable list seeds silently. A first report, a rediscovered node and a
 *    restore all land here, and each would otherwise write one row per installed package.
 *  - An EMPTY or unreadable incoming list says nothing about packages. `softwareState: 'disabled'`
 *    clears a node's stored list because policy turned collection off; that is a POLICY event, and
 *    rendering it as three thousand removals would be actively misleading.
 *  - A package present on both sides at the same version writes nothing, and the comparison is by
 *    NAME rather than by position, so a package manager that re-sorts its output is not a change.
 *    That matters in its own right: the API caller normally reaches this only when the server's own
 *    order-independent fingerprint of the two lists already disagreed, but a node stored before the
 *    fingerprint existed holds none, and its first report after an upgrade therefore arrives here
 *    with no disagreement established. Comparing by name means that report records nothing rather
 *    than one row per package.
 *
 * Ordered by package name and then CAPPED, so one report after a six-month gap writes a bounded,
 * deterministic slice instead of a few thousand rows.
 */
export function diffSoftwareFacts(
  previousList: unknown,
  nextList: unknown,
  limit: number,
): InfraFactChangeDraft[] {
  if (limit <= 0) return [];
  const previous = packageVersions(previousList);
  const next = packageVersions(nextList);
  if (previous === undefined || previous.size === 0) return [];
  if (next === undefined || next.size === 0) return [];

  const names = [...new Set([...previous.keys(), ...next.keys()])].sort();
  const changes: InfraFactChangeDraft[] = [];
  for (const name of names) {
    if (changes.length >= limit) break;
    const had = previous.has(name);
    const has = next.has(name);
    const before = previous.get(name);
    const after = next.get(name);
    if (had && !has) {
      changes.push({
        kind: "PACKAGE_REMOVED",
        fact: name,
        ...(before !== undefined ? { previousValue: before } : {}),
      });
    } else if (!had && has) {
      changes.push({
        kind: "PACKAGE_ADDED",
        fact: name,
        ...(after !== undefined ? { currentValue: after } : {}),
      });
    } else if (before !== after) {
      changes.push({
        kind: "PACKAGE_VERSION",
        fact: name,
        ...(before !== undefined ? { previousValue: before } : {}),
        ...(after !== undefined ? { currentValue: after } : {}),
      });
    }
  }
  return changes;
}
