import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  defaultTrackAsAsset,
  firstMatchingAutoConfirmRule,
  statesAutoConfirmCondition,
  type CreateInfraAutoConfirmRule,
  type InfraAutoConfirmCandidate,
  type InfraAutoConfirmRule,
  type UpdateInfraAutoConfirmRule,
} from '@lazyit/shared';
import { PrismaService } from '../prisma/prisma.service';
import type { Principal } from '../auth/principal';
import { isHumanPrincipal } from '../auth/principal';

/** The rule row plus its author, as the DB returns it. */
const RULE_SELECT = {
  id: true,
  name: true,
  enabled: true,
  appliesTo: true,
  hostnamePattern: true,
  subnetCidr: true,
  reportedKind: true,
  // The ADR-0093 §6 condition. Stored as `String?` (one vocabulary, one storage shape); the matcher
  // reads this row DIRECTLY, so nothing is reshaped or cast on the way in.
  chassis: true,
  confirmAsKind: true,
  trackAsAsset: true,
  createdById: true,
  matchCount: true,
  lastMatchedAt: true,
  createdAt: true,
  updatedAt: true,
  // Selected (not filterable on a to-one relation) so the flatten can gate the name on a LIVE author —
  // the same rule `listNodes` applies to a soft-deleted linked Asset's name.
  createdBy: { select: { firstName: true, lastName: true, deletedAt: true } },
} as const;

/**
 * What a matched rule decides for one freshly-proposed node, plus WHO decided it. The author's
 * principal is carried so the confirm — and the Asset it may mint — is attributed to the operator who
 * wrote the rule, which is the whole basis on which ADR-0074 §8's containment argument survives an
 * automatic confirm.
 */
export interface ResolvedAutoConfirm {
  ruleId: string;
  ruleName: string;
  confirmAsKind: InfraAutoConfirmRule['confirmAsKind'];
  trackAsAsset: boolean;
  /** The rule author as a human principal, or `undefined` when the author is gone (see `resolve`). */
  author?: Principal;
}

/**
 * Operator-authored auto-confirm rules (ADR-0074 §1 amendment, issue #1145) — storage, CRUD and the
 * read side of the matcher. The APPLY side lives in `InfraService`, because applying a rule is exactly
 * the existing `confirmNode` performed with the rule author's principal, and reusing that path rather
 * than re-implementing it is what keeps an auto-confirm and a human confirm from ever diverging.
 *
 * The gate is not weakened. §1 rejected BLANKET auto-confirm, and this does not reopen it:
 *
 *  - a rule must state at least one condition that can rule a proposal OUT. A hostname pattern made
 *    only of wildcards is not one — most such patterns (`*`, `**`, `*?*`) match every hostname there
 *    is, and the few that do narrow (`?` alone matches only one-character names) are refused with
 *    them conservatively, so "carries a literal character" stays a line an operator can check by
 *    looking. `0.0.0.0/0` is not one either, and there the claim is exact: it is every address there
 *    is. Refused by the contract on write, by this service on the merged patch, and by the matcher on
 *    read, so neither a hand-inserted row nor a row left by an older build can become a blanket rule;
 *  - a human authored it, and `createdById` records which human;
 *  - a human can disable or delete it, at which point it stops matching immediately;
 *  - and it is **never retroactive**. Rules are consulted on the report CREATE branch and nowhere
 *    else, so saving one cannot confirm the proposals already sitting in the operator's tray. There is
 *    deliberately no "apply to existing" method here for that to leak through.
 */
@Injectable()
export class InfraAutoConfirmService {
  private readonly logger = new Logger(InfraAutoConfirmService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Every live rule, OLDEST FIRST — the deterministic evaluation order the matcher's "first match
   * wins" reads, and the order the rules list shows, so an operator can see which rule answers
   * first. Disabled rules are included: the list is a management surface, and hiding a rule an
   * operator disabled is how a forgotten rule becomes a surprise when someone re-enables it.
   */
  async list(): Promise<unknown[]> {
    const rows = await this.prisma.infraAutoConfirmRule.findMany({
      orderBy: { createdAt: 'asc' },
      select: RULE_SELECT,
    });
    return rows.map((row) => this.flatten(row));
  }

  /**
   * Save a new rule. `trackAsAsset` defaults through the SHARED {@link defaultTrackAsAsset}, and the
   * argument is *"can this rule reach a container child?"* rather than *"is this a CONTAINER rule?"* —
   * so an `ANY` rule takes the child default (OFF) too. That is what makes the claim true rather than
   * nearly true: no default anywhere — tray, bulk dialog or rule — mints an Asset for a container.
   * An operator who wants one says so explicitly, in the form, and that choice is honoured.
   *
   * The DB column's own default is the host value; this always passes an explicit boolean, so the
   * column default is only ever the fallback for a row written by something other than this method.
   */
  async create(dto: CreateInfraAutoConfirmRule, principal?: Principal) {
    const appliesTo = dto.appliesTo ?? 'HOST';
    const row = await this.prisma.infraAutoConfirmRule.create({
      data: {
        name: dto.name,
        enabled: dto.enabled ?? true,
        appliesTo,
        hostnamePattern: dto.hostnamePattern ?? null,
        subnetCidr: dto.subnetCidr ?? null,
        reportedKind: dto.reportedKind ?? null,
        chassis: dto.chassis ?? null,
        confirmAsKind: dto.confirmAsKind ?? null,
        trackAsAsset:
          dto.trackAsAsset ?? defaultTrackAsAsset(appliesTo !== 'HOST'),
        // The human who authored the decision. A non-human caller cannot reach here (the route is
        // HumanOnlyGuard-ed), and if one ever did the rule is stored unattributed rather than under a
        // fabricated user id.
        createdById: isHumanPrincipal(principal) ? principal.user.id : null,
      },
      select: RULE_SELECT,
    });
    return this.flatten(row);
  }

  /**
   * Patch a rule. The merged result is re-checked with the SAME shared predicate the create contract
   * uses: the patch shape alone cannot see the stored row, so a patch that nulls the only remaining
   * condition — or widens it to `*` / `0.0.0.0/0`, which is the same blanket rule spelled differently
   * — would otherwise store one through the one door the create contract closes.
   */
  async update(id: string, dto: UpdateInfraAutoConfirmRule) {
    const existing = await this.prisma.infraAutoConfirmRule.findFirst({
      where: { id },
      select: RULE_SELECT,
    });
    if (!existing) throw new NotFoundException('Auto-confirm rule not found');

    const merged = {
      hostnamePattern:
        'hostnamePattern' in dto
          ? dto.hostnamePattern
          : existing.hostnamePattern,
      subnetCidr: 'subnetCidr' in dto ? dto.subnetCidr : existing.subnetCidr,
      reportedKind:
        'reportedKind' in dto ? dto.reportedKind : existing.reportedKind,
      chassis: 'chassis' in dto ? dto.chassis : existing.chassis,
    };
    if (!statesAutoConfirmCondition(merged)) {
      throw new BadRequestException(
        'This patch would leave the rule with no condition that can rule a proposal OUT, and ADR-0074 §1 rejected rules that state no condition — a rule whose conditions cannot exclude anything is blanket auto-confirm. Keep at least one: a hostname pattern containing something other than * and ?, a subnet narrower than /0, a reported kind, or a reported chassis. A pattern made only of wildcards does not count: most of them (*, **, *?*) match every hostname there is, and the few that do narrow (? alone matches only one-character names) are refused with them conservatively. Dropping one condition while another survives is fine.',
      );
    }

    const row = await this.prisma.infraAutoConfirmRule.update({
      where: { id },
      data: { ...dto },
      select: RULE_SELECT,
    });
    return this.flatten(row);
  }

  /** Soft-delete a rule — it stops matching immediately; the record of the decision is kept (ADR-0006). */
  async remove(id: string) {
    const existing = await this.prisma.infraAutoConfirmRule.findFirst({
      where: { id },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Auto-confirm rule not found');
    const row = await this.prisma.infraAutoConfirmRule.update({
      where: { id },
      data: { deletedAt: new Date() },
      select: RULE_SELECT,
    });
    return this.flatten(row);
  }

  /**
   * Which rule (if any) decides this freshly-proposed node — READ-ONLY, and the only method the report
   * path calls.
   *
   * Loads the ENABLED rules oldest-first and asks the shared matcher; the matcher re-checks `enabled`
   * and the at-least-one-condition invariant itself, so a row that reached the table by another route
   * is still refused. `undefined` (the overwhelmingly normal case, and the case of an instance with no
   * rules at all) means the node lands PENDING exactly as it always has.
   *
   * The author is resolved to a LIVE human principal so the confirm is attributed. A rule whose author
   * was deleted still fires — it is instance policy, not a personal preference, and quietly retiring
   * an estate's confirmation policy because someone left would be a worse surprise than an
   * unattributed Asset — but it fires with NO principal, so nothing fabricates an actor.
   */
  async resolve(
    candidate: InfraAutoConfirmCandidate,
  ): Promise<ResolvedAutoConfirm | undefined> {
    const rules = await this.prisma.infraAutoConfirmRule.findMany({
      where: { enabled: true },
      orderBy: { createdAt: 'asc' },
      select: RULE_SELECT,
    });
    // The DB rows are evaluated DIRECTLY — `firstMatchingAutoConfirmRule` reads only the condition
    // fields (`InfraAutoConfirmConditions`), so nothing is reshaped or cast on the way in.
    const matched = firstMatchingAutoConfirmRule(rules, candidate);
    if (!matched) return undefined;

    let author: Principal | undefined;
    if (matched.createdById) {
      // `findFirst` is soft-delete-scoped, so a deleted author simply resolves to no principal.
      const user = await this.prisma.user.findFirst({
        where: { id: matched.createdById },
      });
      if (user) author = { kind: 'human', user };
    }
    return {
      ruleId: matched.id,
      ruleName: matched.name,
      confirmAsKind: matched.confirmAsKind,
      trackAsAsset: matched.trackAsAsset,
      author,
    };
  }

  /**
   * Stamp that a rule fired. Best-effort and never awaited into a failure path: the node is already
   * confirmed by the time this runs, so losing the counter costs a line of observability, while
   * throwing here would fail a report that fully succeeded.
   */
  async recordMatch(ruleId: string): Promise<void> {
    try {
      await this.prisma.infraAutoConfirmRule.update({
        where: { id: ruleId },
        data: { matchCount: { increment: 1 }, lastMatchedAt: new Date() },
      });
    } catch (err) {
      this.logger.warn(
        `Could not stamp auto-confirm rule ${ruleId} as matched — the node was still confirmed. ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Flatten the joined author into the wire shape's `createdByName` (null when gone or deleted). */
  private flatten(row: {
    createdBy: {
      firstName: string;
      lastName: string;
      deletedAt: Date | null;
    } | null;
    [key: string]: unknown;
  }) {
    const { createdBy, ...rule } = row;
    return {
      ...rule,
      createdByName:
        createdBy && createdBy.deletedAt === null
          ? `${createdBy.firstName} ${createdBy.lastName}`
          : null,
    };
  }
}
