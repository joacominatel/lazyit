import { Injectable, Logger } from '@nestjs/common';
import type { DirectorySyncCounts, DirectorySyncResult } from '@lazyit/shared';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { UserHistoryService } from '../user-history/user-history.service';
import type { ActorAttribution } from '../common/actor.service';
import { DirectoryConnectionService } from './directory-connection.service';
import {
  DirectoryLdapClient,
  scrubLdapError,
  type DirectoryEntry,
} from './directory-ldap.client';
import { DIRECTORY_SOURCE_AD } from './directory.constants';

/** The recognized profile keys of the attribute map — these map to real User columns, not directoryAttrs. */
const RECOGNIZED_PROFILE_KEYS = new Set([
  'firstName',
  'lastName',
  'email',
  'username',
]);
/** The synthesized non-routable placeholder domain for a person AD gives no usable/unique email (import parity). */
const DIRECTORY_PLACEHOLDER_EMAIL_DOMAIN = '@directory.local';

/** A live 'ad'-sourced directory person as loaded for reconciliation (small set — a 5–20-person org). */
interface LocalAdPerson {
  id: string;
  directorySourceId: string | null;
  isActive: boolean;
  directoryOffboardedAt: Date | null;
  firstName: string;
  lastName: string;
  directoryAttrs: Prisma.JsonValue | null;
}

/**
 * DirectoryReconcileService — the core of the on-prem AD/LDAP directory source (issue #839, ADR-0091). ONE
 * re-entrancy-guarded {@link reconcile} that the setInterval sweeper AND the ADMIN "Sync now" endpoint both
 * call: bind read-only, subtree-search, and UPSERT login-less `directoryOnly` persons keyed on the AD
 * objectGUID (`User.directorySourceId`). Email is only a merge HINT (surfaced in directoryAttrs), NEVER an
 * auto-merge key.
 *
 * HARD INVARIANTS (enforced in code, asserted by the spec): the reconcile NEVER changes `role`, NEVER sets
 * `passwordHash`, NEVER sets `externalId`, NEVER flips `directoryOnly` to false, NEVER grants a login, and
 * NEVER hard-deletes (a disappeared person is SOFT-offboarded past the grace threshold — isActive=false +
 * directoryOffboardedAt). New persons land in the PENDING review tray (they simply exist as directoryOnly
 * VIEWER rows). `memberOf` group DNs are stored INERT in directoryAttrs (#846). Every meaningful change
 * appends a UserHistory row (attributed to the configured directory ServiceAccount, else system). Logs
 * carry REDACTED COUNTS only — never the bind password, DNs, or attribute PII.
 */
@Injectable()
export class DirectoryReconcileService {
  private readonly logger = new Logger(DirectoryReconcileService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: DirectoryConnectionService,
    private readonly ldap: DirectoryLdapClient,
    private readonly users: UsersService,
    private readonly history: UserHistoryService,
  ) {}

  /**
   * Run one reconcile. Re-entrancy guarded (a slow run never overlaps the next sweep tick or a concurrent
   * "Sync now"). Returns a REDACTED result; a bind/search failure is caught and returned as `ok:false` with
   * a short non-secret error (never a throw that would crash the sweeper). Idempotent: keyed on objectGUID,
   * a re-run over an unchanged directory creates nothing and refreshes silently (all skipped).
   */
  async reconcile(): Promise<DirectorySyncResult> {
    const startedAt = new Date();
    const counts: DirectorySyncCounts = {
      created: 0,
      updated: 0,
      offboarded: 0,
      skipped: 0,
    };

    if (this.running) {
      return {
        ok: false,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        counts,
        error: 'a directory sync is already running',
      };
    }
    this.running = true;
    try {
      const config = await this.config.resolveConfig(true);
      if (!config) {
        return {
          ok: false,
          startedAt: startedAt.toISOString(),
          finishedAt: new Date().toISOString(),
          counts,
          error: 'directory sync is disabled or not fully configured',
        };
      }

      const attributeMap = await this.config.getAttributeMap();
      const graceDays = await this.config.getOffboardGraceDays();
      const serviceAccountId = await this.config.getServiceAccountId();
      const actor: ActorAttribution =
        serviceAccountId != null ? { serviceAccountId } : {};

      // Bind + subtree-search. A failure is scrubbed (never the DN/filter/password) and cached as an error.
      let entries: DirectoryEntry[];
      try {
        entries = await this.ldap.fetchEntries(config);
      } catch (err) {
        const error = err instanceof Error ? err.message : scrubLdapError(err);
        const finishedAt = new Date();
        await this.config.recordRun('error', counts, finishedAt);
        this.logger.warn(`Directory sync failed: ${error}`);
        return {
          ok: false,
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          counts,
          error,
        };
      }

      // Load every live 'ad'-sourced person ONCE (small set) for O(1) match + the offboard diff.
      const localPeople = await this.prisma.user.findMany({
        where: { directorySource: DIRECTORY_SOURCE_AD, deletedAt: null },
        select: {
          id: true,
          directorySourceId: true,
          isActive: true,
          directoryOffboardedAt: true,
          firstName: true,
          lastName: true,
          directoryAttrs: true,
        },
      });
      const byGuid = new Map<string, LocalAdPerson>();
      for (const p of localPeople) {
        if (p.directorySourceId) byGuid.set(p.directorySourceId, p);
      }

      const seenGuids = new Set<string>();
      const nowIso = startedAt.toISOString();

      for (const entry of entries) {
        const guid = entry.objectGUID;
        if (!guid) {
          // No usable natural key — cannot upsert safely; skip (never key on garbage).
          counts.skipped += 1;
          continue;
        }
        seenGuids.add(guid);
        const firstName = pick(entry, attributeMap.firstName);
        const lastName = pick(entry, attributeMap.lastName);
        const directoryAttrs = buildDirectoryAttrs(entry, attributeMap, nowIso);

        const existing = byGuid.get(guid);
        if (existing) {
          await this.refreshMatched(
            existing,
            firstName,
            lastName,
            directoryAttrs,
            actor,
            counts,
          );
        } else {
          await this.createNew(
            guid,
            firstName,
            lastName,
            entry,
            attributeMap,
            directoryAttrs,
            counts,
          );
        }
      }

      // OFFBOARD sweep: a live 'ad' person absent from this search, past the grace threshold, is soft-
      // offboarded (never hard-deleted, ADR-0006). "Missing since" is the last time we saw them
      // (directoryAttrs.lastSeenAt), so the grace is per-person and a single dropped entry never trips it.
      const cutoff = startedAt.getTime() - graceDays * 24 * 60 * 60 * 1000;
      for (const p of localPeople) {
        if (!p.directorySourceId || seenGuids.has(p.directorySourceId))
          continue;
        if (p.directoryOffboardedAt != null) continue; // already offboarded by us
        const lastSeen = lastSeenMs(p.directoryAttrs);
        if (lastSeen != null && lastSeen > cutoff) {
          // Still within grace — leave as-is; a later run offboards it if it stays gone.
          counts.skipped += 1;
          continue;
        }
        await this.offboard(p.id, startedAt, actor, counts);
      }

      const finishedAt = new Date();
      await this.config.recordRun('ok', counts, finishedAt);
      this.logger.log(
        `Directory sync ok: created=${counts.created} updated=${counts.updated} ` +
          `offboarded=${counts.offboarded} skipped=${counts.skipped}.`,
      );
      return {
        ok: true,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        counts,
        error: null,
      };
    } catch (err) {
      // Anything the inner LDAP try/catch didn't already handle — a bind-password decrypt failure after a
      // DIRECTORY_SECRET_KEY rotation / keyVersion mismatch, a transient DB error in config resolution or the
      // upsert loop — must still honor the "always HTTP 200, inspect `ok`" contract the controller + web
      // client rely on. Scrub (name only, never the DN/filter/password), record the failed run, return ok:false.
      const error = scrubLdapError(err);
      const finishedAt = new Date();
      await this.config
        .recordRun('error', counts, finishedAt)
        .catch(() => undefined);
      this.logger.warn(`Directory sync failed: ${error}`);
      return {
        ok: false,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        counts,
        error,
      };
    } finally {
      this.running = false;
    }
  }

  /**
   * Refresh a MATCHED person. FIXED ALLOWLIST (mass-assignment-proof): only firstName/lastName (when
   * mapped + changed), directoryAttrs (always — bumps lastSeenAt), and a re-activation (isActive=true +
   * clear directoryOffboardedAt) IFF WE previously offboarded them. NEVER role/externalId/passwordHash/
   * directoryOnly. A UserHistory row is written ONLY on a MEANINGFUL change (not a bare lastSeenAt bump),
   * so a steady directory doesn't spam the audit log; the count follows the same rule (idempotent re-run).
   */
  private async refreshMatched(
    person: LocalAdPerson,
    firstName: string | undefined,
    lastName: string | undefined,
    directoryAttrs: Record<string, unknown>,
    actor: ActorAttribution,
    counts: DirectorySyncCounts,
  ): Promise<void> {
    // Carry forward the create-time `emailConflict` merge HINT: it's set once in createNew and never
    // re-derived (refreshMatched never re-evaluates email — email is a hint, never an auto-merge key).
    // Without this it'd be wiped ~1 sweep after creation, which also spawns a phantom UPDATED + history row.
    if (priorEmailConflict(person.directoryAttrs)) {
      directoryAttrs.emailConflict = true;
    }
    const changedFields: string[] = [];
    const data: Prisma.UserUpdateInput = {
      directoryAttrs: directoryAttrs as Prisma.InputJsonValue,
    };
    if (firstName && firstName !== person.firstName) {
      data.firstName = firstName;
      changedFields.push('firstName');
    }
    if (lastName && lastName !== person.lastName) {
      data.lastName = lastName;
      changedFields.push('lastName');
    }
    if (!attrsEqualIgnoringLastSeen(person.directoryAttrs, directoryAttrs)) {
      changedFields.push('directoryAttrs');
    }
    // Reappeared after WE offboarded them → undo our own soft offboard (never touch a manual deactivation).
    if (person.directoryOffboardedAt != null) {
      data.isActive = true;
      data.directoryOffboardedAt = null;
      changedFields.push('reactivated');
    }

    if (changedFields.length === 0) {
      // Only the lastSeenAt heartbeat moved — persist it silently (no history, no "updated" count).
      await this.prisma.user.update({ where: { id: person.id }, data });
      counts.skipped += 1;
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: person.id }, data });
      await this.history.record(tx, {
        userId: person.id,
        eventType: 'UPDATED',
        payload: { action: 'directorySync', fields: changedFields },
        actor,
      });
    });
    counts.updated += 1;
  }

  /**
   * Create a NEW directory person into the PENDING tray via the sanctioned skipIdpWriteBack rail
   * (users.service.create) — which FORCES role VIEWER, leaves externalId null, grants no login, and stamps
   * directoryOnly=true + our directorySource/directorySourceId. firstName+lastName are required (skip the
   * entry if AD gives neither). Email is the mapped mail IFF it does not collide with a live user, else a
   * per-GUID non-routable placeholder (the real mail is stashed in directoryAttrs as a merge hint — email
   * is NEVER an auto-merge key). The CREATED history row is system-attributed with a directorySync payload
   * (the create rail attributes a human actorId or system; a service-account actor isn't threadable through
   * it — the update/offboard paths carry the SA attribution).
   */
  private async createNew(
    guid: string,
    firstName: string | undefined,
    lastName: string | undefined,
    entry: DirectoryEntry,
    attributeMap: Record<string, string>,
    directoryAttrs: Record<string, unknown>,
    counts: DirectorySyncCounts,
  ): Promise<void> {
    if (!firstName || !lastName) {
      // A person with no resolvable name can't be created (firstName/lastName are required, min length 1).
      counts.skipped += 1;
      return;
    }
    const mappedEmail = attributeMap.email
      ? entry.attributes[attributeMap.email]
      : undefined;
    let email: string;
    if (mappedEmail && !(await this.emailTaken(mappedEmail))) {
      email = mappedEmail;
    } else {
      email = `${guid}${DIRECTORY_PLACEHOLDER_EMAIL_DOMAIN}`;
      if (mappedEmail) {
        directoryAttrs.emailConflict = true; // flagged for the human tray, never overwritten
      }
    }

    try {
      await this.users.create(
        { email, firstName, lastName },
        undefined, // system actor: the create rail can't thread a service-account actor
        {
          skipIdpWriteBack: true,
          directorySource: DIRECTORY_SOURCE_AD,
          directorySourceId: guid,
          directoryAttrs: directoryAttrs as Prisma.InputJsonValue,
          createdPayload: { source: 'directorySync' },
        },
      );
      counts.created += 1;
    } catch (err) {
      // A live email/directorySourceId race trips a partial-unique P2002 → skip; the next run reconciles it.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        counts.skipped += 1;
        return;
      }
      throw err;
    }
  }

  /**
   * Soft-offboard a person that DISAPPEARED from AD past the grace threshold: isActive=false +
   * directoryOffboardedAt (NEVER hard-delete, ADR-0006; NEVER touches role/credentials). A UserHistory
   * row records it, attributed to the directory ServiceAccount (else system). A later reappearance clears
   * the offboard (refreshMatched).
   */
  private async offboard(
    userId: string,
    at: Date,
    actor: ActorAttribution,
    counts: DirectorySyncCounts,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { isActive: false, directoryOffboardedAt: at },
      });
      await this.history.record(tx, {
        userId,
        eventType: 'UPDATED',
        payload: { action: 'directorySync', reason: 'offboarded' },
        actor,
      });
    });
    counts.offboarded += 1;
  }

  /** True when a LIVE (non-deleted) user already owns this email (the citext live-unique index would trip). */
  private async emailTaken(email: string): Promise<boolean> {
    const hit = await this.prisma.user.findFirst({
      where: { email, deletedAt: null },
      select: { id: true },
    });
    return hit != null;
  }
}

/** Read a mapped attribute's value from an entry (undefined when the attr is unmapped/absent). */
function pick(
  entry: DirectoryEntry,
  adAttr: string | undefined,
): string | undefined {
  if (!adAttr) return undefined;
  const v = entry.attributes[adAttr];
  return v !== undefined && v.trim() !== '' ? v.trim() : undefined;
}

/**
 * Build the directoryAttrs jsonb blob: every NON-recognized mapped attribute under its logical key, plus
 * `mail`/`username` hints (recognized keys we don't write to their live-unique columns on refresh), the
 * INERT `memberOf` group DNs (#846), and a `lastSeenAt` heartbeat (drives the grace-based offboard).
 */
function buildDirectoryAttrs(
  entry: DirectoryEntry,
  attributeMap: Record<string, string>,
  lastSeenAt: string,
): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  for (const [profileKey, adAttr] of Object.entries(attributeMap)) {
    if (RECOGNIZED_PROFILE_KEYS.has(profileKey)) continue;
    const v = entry.attributes[adAttr];
    if (v !== undefined) attrs[profileKey] = v;
  }
  if (attributeMap.email && entry.attributes[attributeMap.email]) {
    attrs.mail = entry.attributes[attributeMap.email];
  }
  if (attributeMap.username && entry.attributes[attributeMap.username]) {
    attrs.username = entry.attributes[attributeMap.username];
  }
  if (entry.memberOf.length > 0) {
    attrs.memberOf = entry.memberOf;
  }
  attrs.lastSeenAt = lastSeenAt;
  return attrs;
}

/** True when a person's stored directoryAttrs already carries the create-time `emailConflict` merge hint. */
function priorEmailConflict(attrs: Prisma.JsonValue | null): boolean {
  if (attrs === null || typeof attrs !== 'object' || Array.isArray(attrs)) {
    return false;
  }
  return (attrs as Record<string, unknown>).emailConflict === true;
}

/** The lastSeenAt heartbeat (ms) stored in a person's directoryAttrs, or null when absent/unparseable. */
function lastSeenMs(attrs: Prisma.JsonValue | null): number | null {
  if (attrs === null || typeof attrs !== 'object' || Array.isArray(attrs)) {
    return null;
  }
  const v = (attrs as Record<string, unknown>).lastSeenAt;
  if (typeof v !== 'string') return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

/** Compare two directoryAttrs blobs IGNORING the lastSeenAt heartbeat (so a bump alone isn't a "change"). */
function attrsEqualIgnoringLastSeen(
  current: Prisma.JsonValue | null,
  next: Record<string, unknown>,
): boolean {
  const a = stripLastSeen(current);
  const b = stripLastSeen(next);
  return JSON.stringify(sortedEntries(a)) === JSON.stringify(sortedEntries(b));
}

function stripLastSeen(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const rest = { ...(value as Record<string, unknown>) };
  delete rest.lastSeenAt;
  return rest;
}

/** Stable key-sorted entries for order-independent structural comparison. */
function sortedEntries(obj: Record<string, unknown>): [string, unknown][] {
  return Object.entries(obj).sort(([a], [b]) => a.localeCompare(b));
}
