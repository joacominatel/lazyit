import { z } from "zod";
import { requireAtLeastOneKey } from "./primitives";
import { ConfirmInfraNodeSchema, InfraNodeKindSchema, type InfraNodeKind } from "./infra";

/**
 * The PENDING review tray AT SCALE (ADR-0074 §1/§3 amendment, issue #1145) — bulk review actions and
 * operator-authored auto-confirm rules.
 *
 * ADR-0074 §1 chose PENDING over auto-confirm deliberately and that call is untouched here. What this
 * module addresses is the ERGONOMICS the §3 amendment (#1139) named as a real and separate problem the
 * moment a single Docker host started enrolling itself plus one CONTAINER child per running container:
 * one modest host now produces dozens of tray rows where it used to produce one, and the tray's answer
 * was one dialog per row.
 *
 * Two mechanisms, both keeping the human gate:
 *
 *  - **Bulk confirm / discard.** Exactly the semantics the single confirm already exposes, per item —
 *    a human still approves every node, just not one dialog at a time.
 *  - **Saved auto-confirm rules.** The operator expresses their judgement ONCE ("hosts reporting from
 *    10.20.0.0/16 named `srv-*` are VMs I want tracked") instead of per host. The RULE is the human
 *    decision, so §8's containment argument survives: a human authored it, a human can revoke it, and
 *    the node records which human. A rule with NO condition is refused by the contract itself, because
 *    that is blanket auto-confirm, which §1 rejected and this does not reopen.
 *
 * **Rules are never retroactive.** They are read on the report CREATE branch and nowhere else, so an
 * operator saving a rule can never have proposals already sitting in their tray confirm behind them.
 * That is enforced by where the API calls this, and asserted by test; nothing in these shapes can
 * express a retroactive apply.
 */

// ── Bulk review actions ───────────────────────────────────────────────────────────────────────────

/**
 * Cap on ONE bulk request. Deliberately above `AGENT_CONTAINERS_MAX` (100) so a single Docker host's
 * whole reported topology — the host plus every child it may legally report — fits in one call, and
 * deliberately finite so a batch stays a bounded unit of work with a bounded response. A larger tray
 * is confirmed in more than one pass; the tray sends what the operator selected, and the UI is what
 * keeps a selection inside this bound.
 */
export const INFRA_BULK_REVIEW_MAX = 200;

/**
 * One item of a bulk confirm: a node id plus the SAME optional overrides `ConfirmInfraNodeSchema`
 * takes. Per item rather than one set applied to the batch, because `label` is not a batch concept
 * (renaming forty nodes to one string is never what an operator meant) and because a bulk confirm of a
 * host and its containers wants `trackAsAsset` ON for the host and OFF for the children — see
 * {@link defaultTrackAsAsset}. Anything the single confirm accepts, one item accepts identically.
 */
export const BulkConfirmInfraNodeItemSchema = ConfirmInfraNodeSchema.extend({
  id: z.cuid(),
});
export type BulkConfirmInfraNodeItem = z.infer<typeof BulkConfirmInfraNodeItemSchema>;

/** Duplicate ids in one batch would double-charge the per-item work and confuse the result counts. */
function allUnique(ids: readonly string[]): boolean {
  return new Set(ids).size === ids.length;
}

/** `POST /infra/nodes/bulk-confirm` body. */
export const BulkConfirmInfraNodesSchema = z
  .strictObject({
    items: z.array(BulkConfirmInfraNodeItemSchema).min(1).max(INFRA_BULK_REVIEW_MAX),
  })
  .refine((body) => allUnique(body.items.map((item) => item.id)), {
    error: "A node may appear only once in one bulk confirm",
    path: ["items"],
  });
export type BulkConfirmInfraNodes = z.infer<typeof BulkConfirmInfraNodesSchema>;

/** `POST /infra/nodes/bulk-discard` body — discard is still the existing soft delete, in bulk. */
export const BulkDiscardInfraNodesSchema = z
  .strictObject({
    ids: z.array(z.cuid()).min(1).max(INFRA_BULK_REVIEW_MAX),
  })
  .refine((body) => allUnique(body.ids), {
    error: "A node may appear only once in one bulk discard",
    path: ["ids"],
  });
export type BulkDiscardInfraNodes = z.infer<typeof BulkDiscardInfraNodesSchema>;

/**
 * What happened to ONE node in a bulk request.
 *
 *  - `applied` — confirmed (PENDING → CONFIRMED), or discarded.
 *  - `skipped` — the single-action idempotency, per item: an already-CONFIRMED node on a confirm.
 *  - `notFound` — missing or already soft-deleted, which a racing discard from another tab produces.
 *  - `failed` — anything else; `message` carries the reason.
 */
export const InfraBulkOutcomeSchema = z.enum(["applied", "skipped", "notFound", "failed"]);

export const InfraBulkResultSchema = z.object({
  id: z.cuid(),
  outcome: InfraBulkOutcomeSchema,
  /** The node's label, so a partial failure can NAME the row without a second round-trip. */
  label: z.string().nullable(),
  /** Present on `failed` only; the message the API would have returned for the single action. */
  message: z.string().nullable(),
});

/**
 * The bulk response. PER-ITEM outcomes, not one all-or-nothing verdict, on the same degrade-never-
 * reject posture the report path takes: one node failing (a serial collision, a node another operator
 * discarded a second earlier) must not throw away the thirty-nine that succeeded and leave the
 * operator no way to tell which. The counts are derived from `results` and exist so the toast can say
 * the useful sentence without the caller re-tallying.
 */
export const InfraBulkResponseSchema = z.object({
  applied: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  notFound: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  results: z.array(InfraBulkResultSchema),
});
export type InfraBulkResult = z.infer<typeof InfraBulkResultSchema>;
export type InfraBulkResponse = z.infer<typeof InfraBulkResponseSchema>;

/**
 * The `trackAsAsset` default for ONE proposal — ON for a reporting host, OFF for a CONTAINER child.
 *
 * The single confirm's default is ON and stays ON: a discovered SERVER is exactly what
 * [[0070-infra-topology-graph]] §5's default-on asset linkage was designed for — a thing the operator
 * owns, assigns, warranties and depreciates.
 *
 * A container is not that thing, and ADR-0070 §5 already said so: `trackAsAsset: false` is described in
 * the create path as "right for ephemeral containers". A container is a workload a
 * `docker compose up --force-recreate` recreates; nobody assigns it an owner or a purchase cost, the
 * confirm path's serial promotion has nothing to promote (a container has no SMBIOS serial), and a
 * default-ON bulk confirm of one Docker host would mint thirty Assets nobody will ever curate. So the
 * default inverts for children — and it is a DEFAULT, not a rule: every item and every rule can set it
 * either way, and a container that genuinely is a licensed appliance can be tracked like anything else.
 *
 * A shared function rather than a constant in the tray, because the bulk dialog, the rule form and the
 * server-side rule default must not be able to disagree about it.
 */
export function defaultTrackAsAsset(isContainerChild: boolean): boolean {
  return !isContainerChild;
}

// ── Operator-authored auto-confirm rules ──────────────────────────────────────────────────────────

/** Which half of a report a rule speaks for. `ANY` is stated explicitly, never assumed by omission. */
export const InfraAutoConfirmScopeSchema = z.enum(["HOST", "CONTAINER", "ANY"]);
export type InfraAutoConfirmScope = z.infer<typeof InfraAutoConfirmScopeSchema>;

export const INFRA_RULE_NAME_MAX = 120;
export const INFRA_HOSTNAME_PATTERN_MAX = 200;
export const INFRA_CIDR_MAX = 49; // the longest legal IPv6 CIDR text: 39 chars + "/128"

/**
 * A hostname glob — `*` (any run) and `?` (exactly one), over the characters a hostname may legally
 * contain plus `_` (which real estates use in spite of RFC 1123). The allowlist is what keeps the
 * pattern from carrying regex the matcher would otherwise have to decide whether to honour;
 * {@link matchesHostnamePattern} escapes everything anyway, so this is defence in depth and, more
 * usefully, an early "that is not a hostname pattern" instead of a rule that silently never matches.
 */
export const HostnamePatternSchema = z
  .string()
  .trim()
  .min(1)
  .max(INFRA_HOSTNAME_PATTERN_MAX)
  .refine((pattern) => /^[A-Za-z0-9._*?-]+$/.test(pattern), {
    error: "A hostname pattern may contain letters, digits, . _ - and the * / ? wildcards",
  });

/** An IPv4 or IPv6 CIDR, format-validated so a typo is a clean 400 rather than a rule that never fires. */
export const CidrSchema = z
  .string()
  .trim()
  .min(1)
  .max(INFRA_CIDR_MAX)
  .refine((cidr) => parseCidr(cidr) !== undefined, {
    error: "Must be an IPv4 or IPv6 CIDR block, e.g. 10.20.0.0/16",
  });

/**
 * The persisted rule as it crosses the wire. `createdById`/`createdByName` name the human who
 * authored it — the whole basis on which ADR-0074 §8's containment argument survives an automatic
 * confirm, so the author is part of the shape rather than an admin-only detail. Both are nullable: a
 * rule authored before the instance had the column, or by an operator whose account was since deleted,
 * still has to READ (the soft-deleted author is un-linked, never resurrected).
 *
 * `matchCount`/`lastMatchedAt` are server-owned. A rule that confirms hosts without a human present
 * has to be observable, otherwise the only way to learn it is misfiring is to notice nodes you did not
 * approve — which is exactly the failure the human gate exists to prevent.
 */
export const InfraAutoConfirmRuleSchema = z.object({
  id: z.cuid(),
  name: z.string(),
  enabled: z.boolean(),
  appliesTo: InfraAutoConfirmScopeSchema,
  hostnamePattern: z.string().nullable(),
  subnetCidr: z.string().nullable(),
  reportedKind: InfraNodeKindSchema.nullable(),
  confirmAsKind: InfraNodeKindSchema.nullable(),
  trackAsAsset: z.boolean(),
  createdById: z.uuid().nullable(),
  createdByName: z.string().nullable(),
  matchCount: z.number().int().nonnegative(),
  lastMatchedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type InfraAutoConfirmRule = z.infer<typeof InfraAutoConfirmRuleSchema>;

/** The three condition fields. A rule must state at least one of them — see the refinement below. */
const RULE_CONDITION_KEYS = ["hostnamePattern", "subnetCidr", "reportedKind"] as const;

/** Does this object state at least one non-null condition? */
function statesACondition(value: Record<string, unknown>): boolean {
  return RULE_CONDITION_KEYS.some(
    (key) => value[key] !== undefined && value[key] !== null,
  );
}

const RULE_CONDITION_ERROR =
  "A rule must state at least one condition (hostname pattern, subnet or reported kind). A rule with none would auto-confirm everything, which ADR-0074 §1 rejected.";

const RuleWritableShape = {
  name: z.string().trim().min(1).max(INFRA_RULE_NAME_MAX),
  enabled: z.boolean(),
  appliesTo: InfraAutoConfirmScopeSchema,
  hostnamePattern: HostnamePatternSchema.nullable(),
  subnetCidr: CidrSchema.nullable(),
  reportedKind: InfraNodeKindSchema.nullable(),
  confirmAsKind: InfraNodeKindSchema.nullable(),
  trackAsAsset: z.boolean(),
};

/**
 * `POST /infra/auto-confirm-rules` body. `name` plus at least one condition; everything else has a
 * server-side default. Strict — `matchCount`, `lastMatchedAt` and the author are server-owned, and a
 * client that could set them could dress an unattributed rule up as somebody's decision.
 */
export const CreateInfraAutoConfirmRuleSchema = z
  .strictObject({
    name: RuleWritableShape.name,
    enabled: RuleWritableShape.enabled.optional(),
    appliesTo: RuleWritableShape.appliesTo.optional(),
    hostnamePattern: RuleWritableShape.hostnamePattern.optional(),
    subnetCidr: RuleWritableShape.subnetCidr.optional(),
    reportedKind: RuleWritableShape.reportedKind.optional(),
    confirmAsKind: RuleWritableShape.confirmAsKind.optional(),
    trackAsAsset: RuleWritableShape.trackAsAsset.optional(),
  })
  .refine(statesACondition, { error: RULE_CONDITION_ERROR, path: ["hostnamePattern"] });
export type CreateInfraAutoConfirmRule = z.infer<typeof CreateInfraAutoConfirmRuleSchema>;

/**
 * `PATCH /infra/auto-confirm-rules/:id` body — any subset, never empty.
 *
 * The condition check here can only see the PATCH, so it refuses a patch that nulls every condition it
 * mentions. That is genuinely partial protection: the API re-validates the MERGED rule, which is the
 * only place the stored row is visible. Both checks exist because failing early gives the operator the
 * real message, and failing late is what makes the guarantee true.
 */
export const UpdateInfraAutoConfirmRuleSchema = requireAtLeastOneKey(
  z.strictObject(RuleWritableShape).partial(),
).refine(
  (patch) =>
    !RULE_CONDITION_KEYS.some((key) => key in patch) || statesACondition(patch),
  { error: RULE_CONDITION_ERROR, path: ["hostnamePattern"] },
);
export type UpdateInfraAutoConfirmRule = z.infer<typeof UpdateInfraAutoConfirmRuleSchema>;

/**
 * The FIELDS a match reads — the wire shape's condition half, and nothing else.
 *
 * Structural rather than the whole `InfraAutoConfirmRule`, so the API can evaluate a DB row directly
 * (whose timestamps are `Date`s, not the wire's ISO strings) without a cast that would quietly let a
 * mis-shaped object through. It also states, in the type, exactly which fields decide a match.
 */
export type InfraAutoConfirmConditions = Pick<
  InfraAutoConfirmRule,
  "enabled" | "appliesTo" | "hostnamePattern" | "subnetCidr" | "reportedKind"
>;

/** What a rule is evaluated AGAINST: one freshly-proposed node, before it is written. */
export interface InfraAutoConfirmCandidate {
  /** The reported hostname (a host) or container name (a child) — what becomes the node's label. */
  hostname: string;
  /** The primary IP the report promoted, or null when the report carried none. */
  ipAddress?: string | null;
  /** The kind the SERVER proposed for this node (`inferNodeKind`, or CONTAINER for a child). */
  kind: InfraNodeKind;
  isContainerChild: boolean;
}

/**
 * Does this rule match this candidate? Conditions **AND**, they never OR: an operator writing
 * "`srv-*` on 10.20.0.0/16" means both, and reading it as either would auto-confirm every host on that
 * wire. A condition the rule does not state is simply not tested.
 *
 * **A stated condition never matches on missing evidence.** A subnet rule does not fire for a host
 * that reported no IP: "we do not know where it is" is not "it is on your management wire", and this
 * is the direction to be conservative in — the cost of not matching is that the proposal waits in the
 * tray, which is where it was going anyway.
 */
export function matchesAutoConfirmRule(
  rule: InfraAutoConfirmConditions,
  candidate: InfraAutoConfirmCandidate,
): boolean {
  if (!rule.enabled) return false;
  // A rule with no condition is blanket auto-confirm. The create/update contract refuses to store one;
  // this refuses to ACT on one, so a row hand-inserted or left by an older build cannot become one.
  if (!statesACondition(rule as unknown as Record<string, unknown>)) return false;

  if (rule.appliesTo === "HOST" && candidate.isContainerChild) return false;
  if (rule.appliesTo === "CONTAINER" && !candidate.isContainerChild) return false;

  if (rule.hostnamePattern !== null && !matchesHostnamePattern(rule.hostnamePattern, candidate.hostname)) {
    return false;
  }
  if (rule.subnetCidr !== null && !ipInCidr(candidate.ipAddress, rule.subnetCidr)) return false;
  if (rule.reportedKind !== null && rule.reportedKind !== candidate.kind) return false;
  return true;
}

/**
 * The first rule in the given order that matches, or `undefined`. FIRST match wins rather than
 * most-specific: "most specific" needs a specificity metric operators would have to learn and
 * maintainers would have to keep stable, and ADR-0074 §3 already rejected a rule-precedence engine on
 * exactly that reasoning. The caller supplies the order (the API lists oldest-first, deterministically)
 * and the UI shows it, so the operator can see which rule answers first.
 */
export function firstMatchingAutoConfirmRule<T extends InfraAutoConfirmConditions>(
  rules: readonly T[],
  candidate: InfraAutoConfirmCandidate,
): T | undefined {
  return rules.find((rule) => matchesAutoConfirmRule(rule, candidate));
}

// ── Pure matchers (shared by the rule engine AND the tray's client-side filters) ───────────────────

/**
 * Glob match, ANCHORED and case-insensitive: `*` spans any run of characters, `?` exactly one,
 * everything else is literal. Anchored because `srv` meaning "contains srv" would quietly widen every
 * rule an operator wrote; the wildcard for that is `*srv*`, and they can type it.
 *
 * Every non-wildcard character is regex-escaped. Without that, `srv.01` matches `srv-01` and a stray
 * `+` becomes a quantifier — a rule that fires on hosts the operator never described.
 */
export function matchesHostnamePattern(pattern: string, hostname: string): boolean {
  if (!pattern || !hostname) return false;
  const source = pattern.replace(/[.*+?^${}()|[\]\\]/g, (char) =>
    char === "*" ? "[\\s\\S]*" : char === "?" ? "[\\s\\S]" : `\\${char}`,
  );
  return new RegExp(`^${source}$`, "i").test(hostname);
}

/** 4 bytes for an IPv4 literal, `undefined` for anything else (no host names, no partial quads). */
function ipv4Bytes(value: string): Uint8Array | undefined {
  const parts = value.split(".");
  if (parts.length !== 4) return undefined;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i += 1) {
    const part = parts[i] as string;
    // Reject leading zeros and non-digits outright: `010.1.1.1` is octal to some parsers and decimal
    // to others, and a value two readers disagree about must never decide whether a rule fires.
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return undefined;
    const n = Number(part);
    if (n > 255) return undefined;
    bytes[i] = n;
  }
  return bytes;
}

/** 16 bytes for an IPv6 literal (one `::` run allowed, trailing dotted-quad allowed). */
function ipv6Bytes(value: string): Uint8Array | undefined {
  if (!value.includes(":")) return undefined;
  const halves = value.split("::");
  if (halves.length > 2) return undefined;
  const expand = (part: string): string[] | undefined => {
    if (part === "") return [];
    const groups: string[] = [];
    for (const group of part.split(":")) {
      if (group.includes(".")) {
        // A trailing dotted quad (`::ffff:10.0.0.1`) is two groups' worth of bytes.
        const v4 = ipv4Bytes(group);
        if (!v4) return undefined;
        groups.push(
          ((v4[0] as number) * 256 + (v4[1] as number)).toString(16),
          ((v4[2] as number) * 256 + (v4[3] as number)).toString(16),
        );
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return undefined;
      groups.push(group);
    }
    return groups;
  };
  const head = expand(halves[0] as string);
  const tail = halves.length === 2 ? expand(halves[1] as string) : [];
  if (!head || !tail) return undefined;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return undefined;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    const n = Number.parseInt(group, 16);
    bytes[index * 2] = (n >> 8) & 0xff;
    bytes[index * 2 + 1] = n & 0xff;
  });
  return bytes;
}

/** `{ bytes, prefix }` for a well-formed CIDR, `undefined` otherwise. Exported behaviour, not shape. */
function parseCidr(cidr: string): { bytes: Uint8Array; prefix: number } | undefined {
  const parts = cidr.trim().split("/");
  if (parts.length !== 2) return undefined;
  const [address, prefixText] = parts as [string, string];
  if (!/^\d{1,3}$/.test(prefixText)) return undefined;
  const bytes = ipv4Bytes(address) ?? ipv6Bytes(address);
  if (!bytes) return undefined;
  const prefix = Number(prefixText);
  if (prefix > bytes.length * 8) return undefined;
  return { bytes, prefix };
}

/**
 * Is this address inside this CIDR block? Pure, dependency-free (no `ipaddr.js`), and total: a
 * malformed address, a malformed block, a missing address or a family mismatch all read as `false`.
 *
 * Same value both sides of the wire: the API evaluates saved rules with it, and the tray's subnet
 * filter narrows the loaded list with it, so "which hosts would this rule have matched" and "which
 * hosts does this filter show" can never be answered by two different implementations.
 */
export function ipInCidr(ip: string | null | undefined, cidr: string): boolean {
  if (!ip) return false;
  const block = parseCidr(cidr);
  if (!block) return false;
  const address = ipv4Bytes(ip.trim()) ?? ipv6Bytes(ip.trim());
  // Family mismatch: 4-byte and 16-byte addresses are never compared (no implicit v4-mapped widening —
  // an operator's `10.20.0.0/16` describes a v4 wire and must not silently match `::ffff:10.20.0.1`).
  if (!address || address.length !== block.bytes.length) return false;
  const full = block.prefix >> 3;
  for (let i = 0; i < full; i += 1) {
    if (address[i] !== block.bytes[i]) return false;
  }
  const rest = block.prefix & 7;
  if (rest === 0) return true;
  const mask = (0xff << (8 - rest)) & 0xff;
  return ((address[full] as number) & mask) === ((block.bytes[full] as number) & mask);
}
