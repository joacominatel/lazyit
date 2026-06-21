import * as fs from 'node:fs';
import * as path from 'node:path';
import { UserHistoryEventTypeSchema } from '@lazyit/shared';

/**
 * Regression guard for the `recent_activity` view's UserHistory summary CASE (issue #618 /
 * ADR-0050 / ADR-0058).
 *
 * The view is pure SQL inside a migration file — Prisma never re-generates it. Every time a new
 * `UserHistoryEventType` enum value is added to @lazyit/shared, a matching `WHEN '<VALUE>' THEN
 * '<summary>'` branch MUST be added to the CASE in the most-recent `recent_activity` view
 * migration. Without this guard, a forgotten branch silently emits a NULL summary in the feed.
 *
 * ponytail: read the SQL off disk (no DB, no ORM), regex the CASE block, compare to the enum.
 * Anchors to the LATEST migration whose SQL redefines the view — so the guard tracks future view
 * revisions automatically, not just the current one.
 */

const MIGRATIONS_DIR = path.resolve(
  __dirname,
  '../../prisma/migrations',
);

/** The SQL string that marks the start of a recent_activity view definition. */
const VIEW_DEFINITION_MARKER = 'CREATE OR REPLACE VIEW "recent_activity"';

/**
 * Finds the latest migration (lexicographic order = chronological for the YYYYMMDDHHMMSS prefix)
 * whose SQL contains a `CREATE OR REPLACE VIEW "recent_activity"` statement.
 */
function resolveCanonicalViewMigration(): {
  name: string;
  sql: string;
} {
  const dirs = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter(
      (entry) =>
        !entry.startsWith('.') &&
        fs
          .statSync(path.join(MIGRATIONS_DIR, entry))
          .isDirectory(),
    )
    .sort(); // lexicographic = chronological (YYYYMMDDHHMMSS_ prefix)

  let found: { name: string; sql: string } | null = null;
  for (const dir of dirs) {
    const sqlPath = path.join(MIGRATIONS_DIR, dir, 'migration.sql');
    if (!fs.existsSync(sqlPath)) continue;
    const sql = fs.readFileSync(sqlPath, 'utf8');
    if (sql.includes(VIEW_DEFINITION_MARKER)) {
      found = { name: dir, sql };
    }
  }

  if (!found) {
    throw new Error(
      `No migration found containing '${VIEW_DEFINITION_MARKER}'. ` +
        `Check ${MIGRATIONS_DIR} — the recent_activity view must be defined in at least one migration.`,
    );
  }
  return found;
}

/**
 * Extracts the UserHistory CASE block from the view SQL and returns a map of
 * `{ 'ENUM_VALUE' => 'summary text' }` for every `WHEN '<VALUE>' THEN '<summary>'` pair found
 * inside the block that follows `CASE uh."eventType"::text`.
 */
function extractUserHistorySummaryBranches(
  sql: string,
): Map<string, string> {
  // Isolate the UserHistory CASE block: starts at `CASE uh."eventType"::text` and ends at the
  // first `END` keyword that closes it. We grab everything between them.
  const caseStart = sql.indexOf('CASE uh."eventType"::text');
  if (caseStart === -1) {
    throw new Error(
      'Could not locate `CASE uh."eventType"::text` inside the recent_activity view SQL. ' +
        'The guard expects the UserHistory branch to switch on this exact expression.',
    );
  }
  // Find the matching END (simplistic but sufficient: the block has no nested CASE).
  const endIdx = sql.indexOf('\n  END', caseStart);
  if (endIdx === -1) {
    throw new Error(
      'Could not find the closing `END` after `CASE uh."eventType"::text` in the view SQL.',
    );
  }
  const caseBlock = sql.slice(caseStart, endIdx + 5); // include "END"

  // Match every `WHEN 'VALUE' THEN 'summary'` pair (single-quoted, on one line each).
  const branchRe = /WHEN\s+'([^']+)'\s+THEN\s+'([^']*)'/g;
  const branches = new Map<string, string>();
  let m: RegExpExecArray | null;
  while ((m = branchRe.exec(caseBlock)) !== null) {
    branches.set(m[1], m[2]);
  }
  return branches;
}

describe('recent_activity view — UserHistory CASE completeness (regression guard, issue #618)', () => {
  let migrationName: string;
  let sql: string;

  beforeAll(() => {
    const result = resolveCanonicalViewMigration();
    migrationName = result.name;
    sql = result.sql;
  });

  it('resolves a canonical migration that defines the recent_activity view', () => {
    expect(migrationName).toBeTruthy();
    expect(sql).toContain(VIEW_DEFINITION_MARKER);
  });

  it('every UserHistoryEventType enum value has a WHEN branch in the view summary CASE', () => {
    const branches = extractUserHistorySummaryBranches(sql);
    const missingBranches: string[] = [];
    const blankSummaries: string[] = [];

    for (const enumValue of UserHistoryEventTypeSchema.options) {
      if (!branches.has(enumValue)) {
        missingBranches.push(enumValue);
      } else if (!branches.get(enumValue)?.trim()) {
        blankSummaries.push(enumValue);
      }
    }

    if (missingBranches.length > 0 || blankSummaries.length > 0) {
      const lines: string[] = [
        `Canonical view migration: ${migrationName}`,
      ];
      if (missingBranches.length > 0) {
        lines.push(
          `Missing WHEN branches (add them to the view SQL): ${missingBranches.join(', ')}`,
        );
      }
      if (blankSummaries.length > 0) {
        lines.push(
          `Blank THEN summaries (non-blank required): ${blankSummaries.join(', ')}`,
        );
      }
      throw new Error(lines.join('\n'));
    }

    // Positive assertion so Jest counts this as a concrete expect.
    expect(branches.size).toBeGreaterThanOrEqual(
      UserHistoryEventTypeSchema.options.length,
    );
  });

  it('the canonical migration is the expected 20260611180848_user_manager_clone (update if view is re-issued)', () => {
    // This assertion is intentionally explicit: if someone re-issues the view in a NEW migration
    // the test still passes (the guard auto-upgrades), but this test will FAIL to remind you to
    // update this name. Delete or re-pin this case when the canonical migration changes.
    expect(migrationName).toBe('20260611180848_user_manager_clone');
  });
});
