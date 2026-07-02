/**
 * Export/import version provenance (issue #909, ADR-0083).
 *
 * A lazyit-produced export carries a one-line provenance STAMP naming the build that wrote it, so an
 * operator — and the importer — can tell which version, and thus which schema era, produced the file.
 * The running build's version is the SAME source `GET /instance/version` reads (ADR-0083):
 * `process.env.APP_VERSION`, baked at image build by `git describe --tags` (see the InstanceController).
 * A native dev run has no such env → `'dev'`, which deliberately DISABLES the compatibility gate: a dev
 * build has no meaningful major to vet another build's file against.
 *
 * The stamp is a leading `# lazyit vX.Y.Z — <ISO timestamp>` comment line. On import, a lazyit stamp is
 * STRIPPED before parsing (so it never corrupts the CSV header/columns) and, when its major is NEWER
 * than the running server's, the import is refused with a clear operator message instead of failing
 * cryptically deep in row validation. A MISSING stamp = legacy / hand-made / third-party export →
 * accepted unchanged (this must never break the migrator's existing non-lazyit imports, ADR-0069).
 */

/** The literal prefix that identifies a lazyit provenance stamp line. */
export const PROVENANCE_PREFIX = '# lazyit';

/**
 * The running build's version identity — the exact expression `GET /instance/version` reads (ADR-0083).
 * `'dev'` on a native run with no baked `APP_VERSION`.
 */
export function appVersion(): string {
  return process.env.APP_VERSION || 'dev';
}

/**
 * The provenance stamp line prepended to a lazyit CSV export: `# lazyit vX.Y.Z — <ISO timestamp>`.
 * `now` is injectable for deterministic tests.
 */
export function provenanceStampLine(now: Date = new Date()): string {
  return `${PROVENANCE_PREFIX} ${appVersion()} — ${now.toISOString()}`;
}

/**
 * Extract the leading major-version number from a version string like `v1.4.2` or the honest off-tag
 * describe form `v1.4.2-3-gabc1234`. Returns `null` when there is no leading integer (e.g. `dev`).
 */
function majorOf(version: string): number | null {
  const match = /^v?(\d+)/.exec(version.trim());
  return match ? Number(match[1]) : null;
}

/** The outcome of screening an import's leading line for a lazyit provenance stamp. */
export interface ProvenanceCheck {
  /** The input text with a leading lazyit stamp line removed (returned unchanged when there is none). */
  text: string;
  /** A clear, operator-facing reason when the stamp names an INCOMPATIBLE origin; `null` = accept. */
  incompatibleReason: string | null;
}

/**
 * Screen an import's first line for a lazyit provenance stamp and decide compatibility.
 *
 * - No `# lazyit` stamp → legacy/third-party file: accepted, text untouched.
 * - A stamp from the SAME or an OLDER major than the server → accepted; the stamp line is stripped so
 *   it can't be parsed as a header/data row.
 * - A stamp from a NEWER major than the server → refused with a clear message (the stamp is still
 *   stripped in the returned text, but the caller should surface `incompatibleReason` and not parse).
 * - The gate is disabled when the server is a `dev` build or either major is unknown (accept).
 */
export function checkImportProvenance(
  text: string,
  serverVersion: string = appVersion(),
): ProvenanceCheck {
  const nlIdx = text.indexOf('\n');
  const firstLine = (nlIdx === -1 ? text : text.slice(0, nlIdx)).replace(
    /\r$/,
    '',
  );

  // No stamp → never touch a legacy / hand-made / third-party file.
  if (!firstLine.startsWith(PROVENANCE_PREFIX)) {
    return { text, incompatibleReason: null };
  }

  // It IS our stamp — strip it unconditionally so it can never corrupt column parsing.
  const stripped = nlIdx === -1 ? '' : text.slice(nlIdx + 1);

  const stampVersion = /^#\s*lazyit\s+(\S+)/i.exec(firstLine)?.[1];
  const stampMajor = stampVersion ? majorOf(stampVersion) : null;
  const serverMajor = majorOf(serverVersion);

  // Gate only when the server is a real build AND both majors are known AND the file is from a newer
  // major. Everything else (dev server, unparseable version, same/older major) is accepted.
  if (
    serverVersion !== 'dev' &&
    stampMajor !== null &&
    serverMajor !== null &&
    stampMajor > serverMajor
  ) {
    return {
      text: stripped,
      incompatibleReason:
        `This file was exported by lazyit ${stampVersion}, a newer major version than this server ` +
        `(${serverVersion}). Upgrade this server to at least v${stampMajor} before importing it, or ` +
        `re-export the file from a version compatible with this server.`,
    };
  }

  return { text: stripped, incompatibleReason: null };
}
