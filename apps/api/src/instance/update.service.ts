import {
  BadRequestException,
  Injectable,
  Logger,
  type OnModuleInit,
} from '@nestjs/common';
import {
  UPDATE_RUN_ACTIVE_STATUSES,
  countVersionsBehind,
  isNewerVersion,
  maxVersion,
  type EnqueueUpdate,
  type UpdateRun as UpdateRunWire,
  type UpdateRunStatus,
  type UpdateSettings,
  type UpdateStatus,
} from '@lazyit/shared';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import type { Principal } from '../auth/principal';
import { isHumanPrincipal } from '../auth/principal';

/** The fixed singleton primary key of the UpdateSettings row (mirrors SmtpSettings, ADR-0084/0079). */
export const UPDATE_SETTINGS_SINGLETON_ID = 'singleton';

/** How many recent UpdateRun rows the status card shows (newest-first). A small settings list. */
export const UPDATE_RUN_HISTORY_LIMIT = 10;

/** Redacted release-notes excerpt cap — we cache a short teaser, never a whole changelog body. */
const NOTES_MAX_CHARS = 500;

/** The GitHub Releases API request timeout — fail-soft, never hang a sweep on a slow network. */
const GITHUB_FETCH_TIMEOUT_MS = 10_000;

/** One page of releases (100) — the "N behind" ceiling. ponytail: >100 behind reports 100 (unreal). */
const GITHUB_RELEASES_PER_PAGE = 100;

/** Shape of the GitHub Releases API items we read (a tiny subset of the real payload). */
interface GithubRelease {
  tag_name?: string;
  html_url?: string;
  name?: string | null;
  body?: string | null;
  draft?: boolean;
  prerelease?: boolean;
}

/**
 * UpdateService — the consumption half of versioning (ADR-0084, issue #904): the opt-in update check
 * cache, the "N behind" status the Settings → Instance card reads, and the ENQUEUE-ONLY guided-update
 * contract. It NEVER executes an update: `enqueue` inserts an append-only `UpdateRun` (status
 * `requested`) and the caller is shown the exact `./infra/update.sh vX.Y.Z` command; the HOST script
 * runs the update and stamps state back over plain Postgres (this service only READS those rows).
 *
 * Boot-time reconciliation (OnModuleInit) finalizes any run left in-flight by an abnormally-terminated
 * host so there is never a permanent "updating…" ghost. The periodic GitHub check is driven by the
 * sweep-mold {@link UpdateCheckSweeper}, which calls {@link runCheck} here.
 *
 * RED LINES enforced here: no docker socket, no auto-apply — this class only reads/writes Postgres and
 * emits a notification; the ONLY thing that touches the host is `infra/update.sh`, run by a human.
 */
@Injectable()
export class UpdateService implements OnModuleInit {
  private readonly logger = new Logger(UpdateService.name);

  /** The running build (baked at image build, ADR-0083). Immutable for the process lifetime. */
  private readonly currentVersion = process.env.APP_VERSION || 'dev';

  /** The GitHub repo to check (owner/name). Overridable for forks/testing; defaults to the lazyit repo. */
  private readonly repo =
    process.env.LAZYIT_UPDATE_REPO || 'joacominatel/lazyit';

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Boot reconciliation (ADR-0084 §4): finalize any UpdateRun left IN-FLIGHT (past `requested`) by a
   * host script that died mid-update — the happy path has the host stamp the terminal state itself, so
   * a non-terminal in-flight row on API boot means the host was interrupted. Compare the freshly-booted
   * `APP_VERSION` to the row's `toVersion`: equal ⇒ the update actually landed ⇒ `done`; unchanged ⇒ it
   * did not ⇒ `failed`. `requested` rows are LEFT ALONE — they are a pending intent the operator hasn't
   * run yet, not an interrupted run. Skipped under NODE_ENV=test (mocked Prisma).
   */
  async onModuleInit(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    try {
      await this.reconcileInterruptedRuns();
    } catch (err) {
      // Never block boot on reconciliation — it is a self-healing nicety, not a gate.
      this.logger.error(
        `update-run boot reconciliation failed: ${errText(err)}`,
      );
    }
  }

  /**
   * Finalize interrupted in-flight runs (public for direct testing). Only touches rows whose status is
   * past `requested` (backing_up…verifying) — a `requested` row is a pending intent, never reconciled.
   * Returns how many rows were finalized.
   */
  async reconcileInterruptedRuns(): Promise<number> {
    // The in-flight set is the active statuses MINUS `requested` (which is a pending intent, not a run).
    const inFlight = UPDATE_RUN_ACTIVE_STATUSES.filter(
      (s) => s !== 'requested',
    );
    const rows = await this.prisma.updateRun.findMany({
      where: { status: { in: inFlight } },
      select: { id: true, toVersion: true },
    });
    let finalized = 0;
    for (const row of rows) {
      const landed = isSameVersion(this.currentVersion, row.toVersion);
      await this.prisma.updateRun.update({
        where: { id: row.id },
        data: landed
          ? { status: 'done', finishedAt: new Date(), error: null }
          : {
              status: 'failed',
              finishedAt: new Date(),
              error: `Update interrupted: the API restarted still running ${this.currentVersion}, not ${row.toVersion}. If the host update.sh is still running this will be corrected; otherwise re-run it or restore the pre-update backup.`,
            },
      });
      finalized += 1;
    }
    if (finalized > 0) {
      this.logger.warn(
        `Reconciled ${finalized} interrupted update run(s) at boot.`,
      );
    }
    return finalized;
  }

  // ── settings singleton (the opt-in toggle) ─────────────────────────────────

  /** Read the opt-in setting for the config surface (default OFF when no row exists). */
  async getSettings(): Promise<UpdateSettings> {
    const row = await this.prisma.updateSettings.findFirst({
      where: { id: UPDATE_SETTINGS_SINGLETON_ID },
      select: { checkEnabled: true },
    });
    return { checkEnabled: row?.checkEnabled ?? false };
  }

  /**
   * Flip the opt-in toggle (`PUT /instance/update-settings`). Upserts the singleton row. Turning the
   * check OFF leaves any cached result in place (the card just stops showing "N behind" — it degrades
   * to version-only); we don't wipe the cache so re-enabling shows the last-known state immediately.
   */
  async updateSettings(input: UpdateSettings): Promise<UpdateSettings> {
    const row = await this.prisma.updateSettings.upsert({
      where: { id: UPDATE_SETTINGS_SINGLETON_ID },
      create: {
        id: UPDATE_SETTINGS_SINGLETON_ID,
        checkEnabled: input.checkEnabled,
      },
      update: { checkEnabled: input.checkEnabled },
      select: { checkEnabled: true },
    });
    return { checkEnabled: row.checkEnabled };
  }

  // ── status (the card read) ─────────────────────────────────────────────────

  /**
   * The whole "Version & updates" card in one read (ADR-0084 §5): running version, opt-in state, the
   * cached latest release + how far behind, when last checked, the active run and recent history. Reads
   * only the cache — never fetches GitHub. When the check is off, `latestVersion`/`behindBy` reflect
   * whatever was last cached but the UI keys off `checkEnabled` to show "checks disabled".
   */
  async getStatus(): Promise<UpdateStatus> {
    const [settings, runs] = await Promise.all([
      this.prisma.updateSettings.findFirst({
        where: { id: UPDATE_SETTINGS_SINGLETON_ID },
      }),
      this.prisma.updateRun.findMany({
        orderBy: { createdAt: 'desc' },
        take: UPDATE_RUN_HISTORY_LIMIT,
      }),
    ]);
    const recentRuns = runs.map((r) => this.toRunWire(r));
    const activeRun =
      recentRuns.find((r) =>
        (UPDATE_RUN_ACTIVE_STATUSES as readonly UpdateRunStatus[]).includes(
          r.status,
        ),
      ) ?? null;
    const checkEnabled = settings?.checkEnabled ?? false;
    return {
      currentVersion: this.currentVersion,
      checkEnabled,
      latestVersion: settings?.latestVersion ?? null,
      htmlUrl: settings?.latestHtmlUrl ?? null,
      behindBy: settings?.behindBy ?? 0,
      checkedAt: settings?.checkedAt?.toISOString() ?? null,
      activeRun,
      recentRuns,
    };
  }

  // ── enqueue (the ADMIN action — enqueue-only, executes NOTHING) ─────────────

  /**
   * Enqueue a guided update (ADR-0084 §4). Inserts an append-only `UpdateRun` (status `requested`) and
   * returns it — the caller then shows the operator `./infra/update.sh <toVersion>` to run on the host.
   * This method NEVER touches the host: no shell, no docker, no network — it only writes one Postgres
   * row (RED LINE: the API never executes an update).
   *
   * Guards: the target must be strictly NEWER than the running version (nothing to update to otherwise);
   * and if a run is already in flight, we refuse a second (single-flight at the app layer — the host
   * script has its own lock file too). `requestedByUserId` is the enqueuing human (the controller's
   * HumanOnlyGuard already refused a service principal).
   */
  async enqueue(
    input: EnqueueUpdate,
    principal?: Principal,
  ): Promise<UpdateRunWire> {
    const toVersion = normalizeTag(input.toVersion);

    if (!isNewerVersion(toVersion, this.currentVersion)) {
      throw new BadRequestException(
        `Target ${toVersion} is not newer than the running version ${this.currentVersion} — nothing to update to.`,
      );
    }

    const active = await this.prisma.updateRun.findFirst({
      where: {
        status: { in: UPDATE_RUN_ACTIVE_STATUSES as unknown as string[] },
      },
      select: { id: true, toVersion: true, status: true },
    });
    if (active) {
      throw new BadRequestException(
        `An update to ${active.toVersion} is already ${active.status}. Wait for it to finish (or reconcile) before enqueuing another.`,
      );
    }

    const requestedByUserId =
      principal && isHumanPrincipal(principal) ? principal.user.id : null;

    const created = await this.prisma.updateRun.create({
      data: {
        requestedByUserId,
        fromVersion: this.currentVersion,
        toVersion,
        status: 'requested',
      },
    });
    this.logger.log(
      `Update enqueued: ${this.currentVersion} → ${toVersion} (run #${created.id}). Operator must run: ./infra/update.sh ${toVersion}`,
    );
    return this.toRunWire(created);
  }

  // ── the periodic check (called by the sweeper) ─────────────────────────────

  /**
   * One update-check pass (ADR-0084 §1) — called by {@link UpdateCheckSweeper}. Fail-soft by
   * construction: any error (check off, egress blocked, rate-limited, unparseable payload) is logged
   * and dropped, the cache is left UNTOUCHED (a failed check never becomes "up to date", and never
   * wipes a prior good result). Returns a small summary for tests/telemetry.
   *
   *   1. Skip entirely when the check is OPT-OUT (default) — no byte leaves the host.
   *   2. One anonymous GET to the GitHub Releases API (no auth, no body, no install id — beacon-free).
   *   3. Compute latest + "N behind" via the shared semver util (drafts/pre-releases dropped).
   *   4. Cache {latestVersion, behindBy, htmlUrl, notes, checkedAt}.
   *   5. If behind AND this latest version hasn't been emailed yet, emit `update.available` (ADMIN
   *      broadcast) and advance `lastEmailedVersion` (suppress-when-current + de-dupe-per-version).
   */
  async runCheck(): Promise<{
    checked: boolean;
    latestVersion: string | null;
    behindBy: number;
    emailed: boolean;
  }> {
    const skip = {
      checked: false,
      latestVersion: null,
      behindBy: 0,
      emailed: false,
    };
    try {
      const settings = await this.prisma.updateSettings.findFirst({
        where: { id: UPDATE_SETTINGS_SINGLETON_ID },
      });
      if (!settings?.checkEnabled) {
        return skip; // opt-out: never reach out.
      }

      const releases = await this.fetchReleases();
      const tags = releases
        .filter((r) => !r.draft && !r.prerelease && r.tag_name)
        .map((r) => r.tag_name as string);
      const latestVersion = maxVersion(tags);
      const behindBy = countVersionsBehind(this.currentVersion, tags);
      const latest = latestVersion
        ? releases.find((r) => r.tag_name === latestVersion)
        : undefined;

      await this.prisma.updateSettings.update({
        where: { id: UPDATE_SETTINGS_SINGLETON_ID },
        data: {
          latestVersion,
          behindBy,
          latestHtmlUrl: latest?.html_url ?? null,
          latestNotes: buildNotes(latest),
          checkedAt: new Date(),
        },
      });

      // Weekly email — suppress-when-current + de-dupe-per-version (ADR-0084 §2).
      let emailed = false;
      if (
        behindBy > 0 &&
        latestVersion &&
        latestVersion !== settings.lastEmailedVersion
      ) {
        await this.emitUpdateAvailable(
          latestVersion,
          behindBy,
          latest?.html_url ?? null,
        );
        await this.prisma.updateSettings.update({
          where: { id: UPDATE_SETTINGS_SINGLETON_ID },
          data: { lastEmailedVersion: latestVersion },
        });
        emailed = true;
      }

      this.logger.log(
        `Update check: running ${this.currentVersion}, latest ${latestVersion ?? 'unknown'}, ${behindBy} behind${emailed ? ' (emailed)' : ''}.`,
      );
      return { checked: true, latestVersion, behindBy, emailed };
    } catch (err) {
      // FAIL-SOFT: log + drop; leave the cache untouched. "Couldn't check" is never "up to date".
      this.logger.warn(
        `Update check failed (fail-soft, cache untouched): ${errText(err)}`,
      );
      return skip;
    }
  }

  /**
   * The single anonymous GET (ADR-0084 §1). No Authorization header, no body, no install identifier —
   * a bare unauthenticated request, the same trust shape as pinging an OS package mirror. A `User-Agent`
   * is required by the GitHub API (a UA is not instance-identifying). Timed out so a slow network can
   * never hang the sweep. A non-2xx (rate-limit, 404, block) throws → the caller fails soft.
   */
  private async fetchReleases(): Promise<GithubRelease[]> {
    const url = `https://api.github.com/repos/${this.repo}/releases?per_page=${GITHUB_RELEASES_PER_PAGE}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GITHUB_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'lazyit-update-check',
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`GitHub releases API returned HTTP ${res.status}`);
      }
      const data = (await res.json()) as unknown;
      if (!Array.isArray(data)) {
        throw new Error('GitHub releases API returned a non-array payload');
      }
      return data as GithubRelease[];
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Emit the `update.available` notification (ADR-0084 §2). Broadcast to the ADMIN feed (recipientUserId
   * null) and — since the type is on the ADR-0079 email allowlist — ALSO emailed, best-effort. The
   * dedupeKey pins ONE row per version (a re-check of the same latest is a no-op even if the row was
   * pruned). Metadata carries only version strings + count (INV-6). Fail-soft: emit never throws.
   */
  private async emitUpdateAvailable(
    latestVersion: string,
    behindBy: number,
    htmlUrl: string | null,
  ): Promise<void> {
    await this.notifications.emit({
      type: 'update.available',
      dedupeKey: `update.available:${latestVersion}`,
      severity: 'info',
      title: `lazyit ${latestVersion} is available`,
      summary:
        behindBy === 1
          ? `You are running ${this.currentVersion} — one newer release is out. Review it in Settings → Instance.`
          : `You are running ${this.currentVersion} — ${behindBy} newer releases are out. Review them in Settings → Instance.`,
      metadata: {
        current: this.currentVersion,
        latest: latestVersion,
        behindBy,
        ...(htmlUrl ? { htmlUrl } : {}),
      },
    });
  }

  // ── mapping ────────────────────────────────────────────────────────────────

  /** Map a Prisma UpdateRun row to the shared wire shape (ISO timestamps). */
  private toRunWire(row: {
    id: number;
    requestedByUserId: string | null;
    fromVersion: string;
    toVersion: string;
    status: string;
    startedAt: Date | null;
    finishedAt: Date | null;
    logTail: string | null;
    error: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): UpdateRunWire {
    return {
      id: row.id,
      requestedByUserId: row.requestedByUserId,
      fromVersion: row.fromVersion,
      toVersion: row.toVersion,
      status: row.status as UpdateRunStatus,
      startedAt: row.startedAt?.toISOString() ?? null,
      finishedAt: row.finishedAt?.toISOString() ?? null,
      logTail: row.logTail,
      error: row.error,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

// ── module-local helpers (pure) ───────────────────────────────────────────────

/** A short, non-secret error string (message only — never a stack). */
function errText(err: unknown): string {
  if (err instanceof Prisma.PrismaClientKnownRequestError)
    return `${err.code} ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

/** Normalize a target tag to the canonical leading-`v` form (`1.5.0` → `v1.5.0`). */
function normalizeTag(tag: string): string {
  const t = tag.trim();
  return /^v/i.test(t) ? `v${t.replace(/^v/i, '')}` : `v${t}`;
}

/** True when two tags share the same numeric semver core (ignoring a describe suffix / leading v). */
function isSameVersion(a: string, b: string): boolean {
  return (
    !isNewerVersion(a, b) &&
    !isNewerVersion(b, a) &&
    !!parseCore(a) &&
    !!parseCore(b)
  );
}

/** Tiny local re-parse used only by isSameVersion (avoids importing parseSemver just for a null-check). */
function parseCore(tag: string): boolean {
  return /^[vV]?\d+\.\d+\.\d+/.test(tag.trim());
}

/** Build the short, redacted release-notes teaser cached for the card (title + first lines, capped). */
function buildNotes(release: GithubRelease | undefined): string | null {
  if (!release) return null;
  const raw = (release.name || release.body || '').trim();
  if (!raw) return null;
  return raw.length > NOTES_MAX_CHARS
    ? `${raw.slice(0, NOTES_MAX_CHARS)}…`
    : raw;
}
