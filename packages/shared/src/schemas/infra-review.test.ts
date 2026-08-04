import { describe, expect, test } from "bun:test";
import { containerExternalId, hostExternalIdOfContainerChild } from "./infra";
import {
  BulkConfirmInfraNodesSchema,
  BulkDiscardInfraNodesSchema,
  CreateInfraAutoConfirmRuleSchema,
  INFRA_BULK_REVIEW_MAX,
  InfraAutoConfirmRuleSchema,
  UpdateInfraAutoConfirmRuleSchema,
  defaultTrackAsAsset,
  firstMatchingAutoConfirmRule,
  ipInCidr,
  matchesAutoConfirmRule,
  matchesHostnamePattern,
  statesAutoConfirmCondition,
  type InfraAutoConfirmRule,
  type InfraAutoConfirmScope,
} from "./infra-review";

/** A saved rule with every optional condition empty — each test fills only what it exercises. */
function rule(overrides: Partial<InfraAutoConfirmRule> = {}): InfraAutoConfirmRule {
  return {
    id: "clh0000000000000000000000",
    name: "rule",
    enabled: true,
    appliesTo: "HOST",
    hostnamePattern: null,
    subnetCidr: null,
    reportedKind: null,
    chassis: null,
    confirmAsKind: null,
    trackAsAsset: true,
    createdById: null,
    createdByName: null,
    matchCount: 0,
    lastMatchedAt: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("hostExternalIdOfContainerChild (#1145 — grouping the tray by reporting host)", () => {
  test("returns the host key a container child was scoped to", () => {
    expect(hostExternalIdOfContainerChild(containerExternalId("9f8d7c", "api"))).toBe("9f8d7c");
  });

  test("a container name containing the separator resolves to the FIRST segment", () => {
    // The key is `<host>/container/<name>`; a name that itself contains the separator must not be
    // able to re-parent the child onto a different host.
    expect(hostExternalIdOfContainerChild("9f8d7c/container/a/container/b")).toBe("9f8d7c");
  });

  test("a host key (or nothing) is not a child key", () => {
    expect(hostExternalIdOfContainerChild("9f8d7c6b5a4e3f2a")).toBeUndefined();
    expect(hostExternalIdOfContainerChild(null)).toBeUndefined();
    expect(hostExternalIdOfContainerChild(undefined)).toBeUndefined();
  });
});

describe("BulkConfirmInfraNodesSchema (#1145)", () => {
  const id = "clh0000000000000000000001";
  const other = "clh0000000000000000000002";

  test("carries the SAME per-item overrides the single confirm exposes", () => {
    const parsed = BulkConfirmInfraNodesSchema.parse({
      items: [
        { id, trackAsAsset: false, kind: "CONTAINER", label: "redis" },
        { id: other },
      ],
    });
    expect(parsed.items[0]).toEqual({
      id,
      trackAsAsset: false,
      kind: "CONTAINER",
      label: "redis",
    });
    expect(parsed.items[1]).toEqual({ id: other });
  });

  test("rejects an empty batch, a duplicate id and an over-cap batch", () => {
    expect(BulkConfirmInfraNodesSchema.safeParse({ items: [] }).success).toBe(false);
    expect(
      BulkConfirmInfraNodesSchema.safeParse({ items: [{ id }, { id }] }).success,
    ).toBe(false);
    const tooMany = Array.from({ length: INFRA_BULK_REVIEW_MAX + 1 }, (_, i) => ({
      id: `clh00000000000000000${String(i).padStart(5, "0")}`,
    }));
    expect(BulkConfirmInfraNodesSchema.safeParse({ items: tooMany }).success).toBe(false);
  });

  test("is strict — no unknown key rides the bulk body", () => {
    expect(
      BulkConfirmInfraNodesSchema.safeParse({ items: [{ id }], state: "CONFIRMED" }).success,
    ).toBe(false);
    expect(
      BulkConfirmInfraNodesSchema.safeParse({ items: [{ id, assetId: other }] }).success,
    ).toBe(false);
  });
});

describe("BulkDiscardInfraNodesSchema (#1145)", () => {
  const id = "clh0000000000000000000001";

  test("accepts a bounded, duplicate-free id list", () => {
    expect(BulkDiscardInfraNodesSchema.parse({ ids: [id] }).ids).toEqual([id]);
    expect(BulkDiscardInfraNodesSchema.safeParse({ ids: [] }).success).toBe(false);
    expect(BulkDiscardInfraNodesSchema.safeParse({ ids: [id, id] }).success).toBe(false);
  });
});

describe("defaultTrackAsAsset (#1145 — the child-node default)", () => {
  test("a reporting HOST keeps the default-ON behaviour the single confirm has", () => {
    expect(defaultTrackAsAsset(false)).toBe(true);
  });

  test("a CONTAINER child defaults OFF", () => {
    expect(defaultTrackAsAsset(true)).toBe(false);
  });
});

describe("matchesHostnamePattern (#1145)", () => {
  test("`*` spans any run of characters and the match is case-insensitive", () => {
    expect(matchesHostnamePattern("srv-*", "srv-app-04")).toBe(true);
    expect(matchesHostnamePattern("SRV-*", "srv-app-04")).toBe(true);
    expect(matchesHostnamePattern("srv-*", "db-01")).toBe(false);
    expect(matchesHostnamePattern("*.corp.local", "srv-app-04.corp.local")).toBe(true);
  });

  test("`?` spans exactly one character", () => {
    expect(matchesHostnamePattern("web-0?", "web-04")).toBe(true);
    expect(matchesHostnamePattern("web-0?", "web-041")).toBe(false);
  });

  test("the pattern is ANCHORED — a bare substring never matches", () => {
    expect(matchesHostnamePattern("srv", "srv-app-04")).toBe(false);
  });

  test("regex metacharacters in a pattern are literal, never operators", () => {
    // Without escaping, `srv.01` would match `srv-01` and `a+` would be a quantifier.
    expect(matchesHostnamePattern("srv.01", "srv-01")).toBe(false);
    expect(matchesHostnamePattern("srv.01", "srv.01")).toBe(true);
  });

  test("an empty pattern or an empty hostname never matches", () => {
    expect(matchesHostnamePattern("", "srv-01")).toBe(false);
    expect(matchesHostnamePattern("*", "")).toBe(false);
  });
});

describe("ipInCidr (#1145)", () => {
  test("IPv4 prefixes", () => {
    expect(ipInCidr("10.20.3.7", "10.20.0.0/16")).toBe(true);
    expect(ipInCidr("10.21.3.7", "10.20.0.0/16")).toBe(false);
    expect(ipInCidr("192.168.1.5", "192.168.1.5/32")).toBe(true);
    expect(ipInCidr("192.168.1.6", "192.168.1.5/32")).toBe(false);
    expect(ipInCidr("1.2.3.4", "0.0.0.0/0")).toBe(true);
  });

  test("IPv6 prefixes, including a compressed address", () => {
    expect(ipInCidr("2001:db8::1", "2001:db8::/32")).toBe(true);
    expect(ipInCidr("2001:db9::1", "2001:db8::/32")).toBe(false);
    expect(ipInCidr("fd00:1234::5", "fd00::/8")).toBe(true);
  });

  test("families never cross-match, and garbage is never a match", () => {
    expect(ipInCidr("10.20.3.7", "2001:db8::/32")).toBe(false);
    expect(ipInCidr("2001:db8::1", "10.20.0.0/16")).toBe(false);
    expect(ipInCidr("not-an-ip", "10.20.0.0/16")).toBe(false);
    expect(ipInCidr("10.20.3.7", "10.20.0.0/99")).toBe(false);
    expect(ipInCidr("10.20.3.7", "10.20.0.0")).toBe(false);
    expect(ipInCidr(null, "10.20.0.0/16")).toBe(false);
  });
});

describe("matchesAutoConfirmRule (#1145)", () => {
  const host = {
    hostname: "srv-app-04",
    ipAddress: "10.20.3.7",
    kind: "PHYSICAL_HOST" as const,
    isContainerChild: false,
  };

  test("EVERY stated condition must hold — conditions AND, they never OR", () => {
    const r = rule({ hostnamePattern: "srv-*", subnetCidr: "10.20.0.0/16" });
    expect(matchesAutoConfirmRule(r, host)).toBe(true);
    expect(matchesAutoConfirmRule(r, { ...host, hostname: "db-01" })).toBe(false);
    expect(matchesAutoConfirmRule(r, { ...host, ipAddress: "10.90.0.1" })).toBe(false);
  });

  test("an unstated condition is not a wildcard match on missing evidence", () => {
    // A rule scoped to a subnet must NOT fire for a host that reported no IP at all: the operator
    // asked for "hosts on this wire", and "we do not know where it is" is not that.
    const r = rule({ subnetCidr: "10.20.0.0/16" });
    expect(matchesAutoConfirmRule(r, { ...host, ipAddress: null })).toBe(false);
  });

  test("a disabled rule never matches", () => {
    expect(matchesAutoConfirmRule(rule({ enabled: false, hostnamePattern: "srv-*" }), host)).toBe(
      false,
    );
  });

  test("a rule with NO condition never matches — that would be blanket auto-confirm", () => {
    expect(matchesAutoConfirmRule(rule(), host)).toBe(false);
  });

  test("appliesTo separates a reporting host from a container child", () => {
    // `srv-*` matches both fixtures, so only `appliesTo` decides — and it is a REAL condition, which
    // a bare `*` is not (see the blanket-rule tests below).
    const child = {
      ...host,
      hostname: "srv-redis",
      kind: "CONTAINER" as const,
      isContainerChild: true,
    };
    const scoped = (appliesTo: InfraAutoConfirmScope) =>
      rule({ appliesTo, hostnamePattern: "srv-*" });
    expect(matchesAutoConfirmRule(scoped("HOST"), host)).toBe(true);
    expect(matchesAutoConfirmRule(scoped("HOST"), child)).toBe(false);
    expect(matchesAutoConfirmRule(scoped("CONTAINER"), child)).toBe(true);
    expect(matchesAutoConfirmRule(scoped("CONTAINER"), host)).toBe(false);
    expect(matchesAutoConfirmRule(scoped("ANY"), host)).toBe(true);
    expect(matchesAutoConfirmRule(scoped("ANY"), child)).toBe(true);
  });

  test("reportedKind matches the kind the SERVER proposed", () => {
    const r = rule({ reportedKind: "VM" });
    expect(matchesAutoConfirmRule(r, { ...host, kind: "VM" })).toBe(true);
    expect(matchesAutoConfirmRule(r, host)).toBe(false);
  });

  // ── Chassis as a condition (ADR-0093 §6, #1198) ───────────────────────────────────────────────

  test("a stated chassis is AND-ed with the other conditions, never OR-ed", () => {
    const r = rule({ hostnamePattern: "srv-*", chassis: "server" });
    expect(matchesAutoConfirmRule(r, { ...host, chassis: "server" })).toBe(true);
    // Hostname matches, chassis does not — a laptop named `srv-…` is still a laptop.
    expect(matchesAutoConfirmRule(r, { ...host, chassis: "laptop" })).toBe(false);
    // Chassis matches, hostname does not.
    expect(matchesAutoConfirmRule(r, { ...host, hostname: "db-01", chassis: "server" })).toBe(false);
  });

  test("a stated chassis NEVER matches missing evidence — absent, null, or `unknown`", () => {
    // `unknown` means the probe did not run (a container reading /sys/class/dmi sees the HOST's board),
    // which is a different fact from any form factor. "We do not know what this box is" is not "it is
    // the kind of box you described", and the cost of not matching is that the proposal waits in the
    // tray — where it was going anyway. Same conservatism the subnet condition already applies.
    const r = rule({ chassis: "server" });
    expect(matchesAutoConfirmRule(r, { ...host, chassis: "server" })).toBe(true);
    expect(matchesAutoConfirmRule(r, { ...host, chassis: "unknown" })).toBe(false);
    expect(matchesAutoConfirmRule(r, { ...host, chassis: null })).toBe(false);
    expect(matchesAutoConfirmRule(r, host)).toBe(false);
  });

  test("a rule stating ONLY chassis acts — the same footing reportedKind has", () => {
    expect(matchesAutoConfirmRule(rule({ chassis: "server" }), { ...host, chassis: "server" })).toBe(
      true,
    );
  });

  test("a CONTAINER child carries no chassis, so a chassis rule can never confirm one", () => {
    // A child's blob is `{ container, reportedAt }` — no `host` key at all (#1139), so it has no form
    // factor to compare and even an ANY-scoped chassis rule must not reach it.
    const child = {
      ...host,
      hostname: "srv-redis",
      kind: "CONTAINER" as const,
      isContainerChild: true,
    };
    expect(matchesAutoConfirmRule(rule({ appliesTo: "ANY", chassis: "container" }), child)).toBe(
      false,
    );
  });
});

describe("a wildcard-only condition is not a condition (#1145 blanket auto-confirm)", () => {
  const host = {
    hostname: "srv-app-04",
    ipAddress: "10.20.3.7",
    kind: "PHYSICAL_HOST" as const,
    isContainerChild: false,
  };

  // Every pattern here is made ONLY of wildcard characters, and every one is refused. Most of them
  // (`*`, `**`, `***`, `*?*`, `?*`) genuinely match every proposal there is — blanket auto-confirm
  // however it is spelled, which ADR-0074 §1 rejected, so it has to be unstorable AND unusable. The
  // last two (`?`, `??`) only constrain LENGTH and are refused conservatively alongside them; see the
  // dedicated test below for why that over-refusal is the deliberate, safe direction.
  const wildcardOnly = ["*", "**", "***", "*?*", "?*", "?", "??"];
  const narrowing = ["srv-*", "*.*", "*-01"];

  test.each(wildcardOnly)("a hostname pattern of only wildcards (%p) is refused", (pattern) => {
    expect(statesAutoConfirmCondition({ hostnamePattern: pattern })).toBe(false);
    expect(matchesAutoConfirmRule(rule({ hostnamePattern: pattern }), host)).toBe(false);
    expect(
      CreateInfraAutoConfirmRuleSchema.safeParse({ name: "everything", hostnamePattern: pattern })
        .success,
    ).toBe(false);
  });

  test("a pattern of only `?`s constrains LENGTH, and is refused anyway", () => {
    // `??` does exclude `srv-01`, so this one is a deliberate over-refusal: the rule is "a pattern
    // has to carry a literal character", which is a line an operator can check by looking, and
    // "hostnames of exactly two characters" describes no estate anyone runs. Refusing is the safe
    // direction — the proposals it would have confirmed simply wait in the tray.
    expect(matchesHostnamePattern("??", "ab")).toBe(true);
    expect(statesAutoConfirmCondition({ hostnamePattern: "??" })).toBe(false);
  });

  test.each(narrowing)("a pattern carrying a literal (%p) IS a condition", (pattern) => {
    expect(statesAutoConfirmCondition({ hostnamePattern: pattern })).toBe(true);
    expect(
      CreateInfraAutoConfirmRuleSchema.safeParse({ name: "narrow", hostnamePattern: pattern })
        .success,
    ).toBe(true);
  });

  test("`*.*` is a near-miss that stays legal — it genuinely rules out a name with no dot", () => {
    expect(matchesAutoConfirmRule(rule({ hostnamePattern: "*.*" }), host)).toBe(false);
    expect(
      matchesAutoConfirmRule(rule({ hostnamePattern: "*.*" }), {
        ...host,
        hostname: "srv-app-04.corp.local",
      }),
    ).toBe(true);
  });

  test("a /0 subnet spans the whole address space, so it states nothing either", () => {
    expect(statesAutoConfirmCondition({ subnetCidr: "0.0.0.0/0" })).toBe(false);
    expect(statesAutoConfirmCondition({ subnetCidr: "::/0" })).toBe(false);
    expect(matchesAutoConfirmRule(rule({ subnetCidr: "0.0.0.0/0" }), host)).toBe(false);
    expect(
      CreateInfraAutoConfirmRuleSchema.safeParse({ name: "any ip", subnetCidr: "0.0.0.0/0" })
        .success,
    ).toBe(false);
    // One bit of prefix already rules something out, so it is a (very wide) condition.
    expect(statesAutoConfirmCondition({ subnetCidr: "0.0.0.0/1" })).toBe(true);
  });

  test("all-wildcard name AND /0 subnet together are still blanket — two nothings do not add up", () => {
    const blanket = { hostnamePattern: "*", subnetCidr: "0.0.0.0/0" };
    expect(statesAutoConfirmCondition(blanket)).toBe(false);
    expect(matchesAutoConfirmRule(rule(blanket), host)).toBe(false);
    expect(
      CreateInfraAutoConfirmRuleSchema.safeParse({ name: "everything", ...blanket }).success,
    ).toBe(false);
  });

  test("a wildcard name beside a REAL condition is fine — the rule still excludes proposals", () => {
    expect(
      statesAutoConfirmCondition({ hostnamePattern: "*", subnetCidr: "10.20.0.0/16" }),
    ).toBe(true);
    expect(statesAutoConfirmCondition({ hostnamePattern: "*", reportedKind: "VM" })).toBe(true);
    expect(
      CreateInfraAutoConfirmRuleSchema.safeParse({
        name: "everything on the management wire",
        hostnamePattern: "*",
        subnetCidr: "10.20.0.0/16",
      }).success,
    ).toBe(true);
    expect(
      matchesAutoConfirmRule(rule({ hostnamePattern: "*", subnetCidr: "10.20.0.0/16" }), host),
    ).toBe(true);
  });

  test("a reported kind is always a condition — it names one of several kinds", () => {
    expect(statesAutoConfirmCondition({ reportedKind: "VM" })).toBe(true);
    expect(statesAutoConfirmCondition({})).toBe(false);
    expect(
      statesAutoConfirmCondition({ hostnamePattern: null, subnetCidr: null, reportedKind: null }),
    ).toBe(false);
  });

  test("a PATCH cannot widen a rule into a blanket one either", () => {
    expect(
      UpdateInfraAutoConfirmRuleSchema.safeParse({
        hostnamePattern: "*",
        subnetCidr: null,
        reportedKind: null,
        chassis: null,
      }).success,
    ).toBe(false);
    expect(
      UpdateInfraAutoConfirmRuleSchema.safeParse({ hostnamePattern: "srv-*" }).success,
    ).toBe(true);
  });

  test("a patch that leaves a condition field ALONE is the API's call, not the schema's", () => {
    // `{ hostnamePattern: "*", subnetCidr: "0.0.0.0/0" }` says nothing about `reportedKind`, so the
    // merged rule keeps whatever kind is stored — and a stored `reportedKind: "VM"` makes it a
    // perfectly usable rule. The schema cannot see the row, so it must not guess: the API's merged
    // re-check is what refuses this patch when the stored kind really is null.
    expect(
      UpdateInfraAutoConfirmRuleSchema.safeParse({
        hostnamePattern: "*",
        subnetCidr: "0.0.0.0/0",
      }).success,
    ).toBe(true);
  });
});

describe("firstMatchingAutoConfirmRule (#1145)", () => {
  test("the FIRST rule in the given order wins, and a non-match is skipped", () => {
    const specific = rule({ id: "clh0000000000000000000011", hostnamePattern: "srv-app-*", confirmAsKind: "VM" });
    const broad = rule({ id: "clh0000000000000000000012", hostnamePattern: "srv-*", confirmAsKind: "PHYSICAL_HOST" });
    const candidate = {
      hostname: "srv-app-04",
      ipAddress: null,
      kind: "PHYSICAL_HOST" as const,
      isContainerChild: false,
    };
    expect(firstMatchingAutoConfirmRule([specific, broad], candidate)?.id).toBe(specific.id);
    expect(firstMatchingAutoConfirmRule([broad, specific], candidate)?.id).toBe(broad.id);
    expect(firstMatchingAutoConfirmRule([], candidate)).toBeUndefined();
  });
});

describe("CreateInfraAutoConfirmRuleSchema (#1145)", () => {
  test("accepts a rule stating at least one condition", () => {
    const parsed = CreateInfraAutoConfirmRuleSchema.parse({
      name: "  Prod servers  ",
      hostnamePattern: "srv-*",
      subnetCidr: "10.20.0.0/16",
      confirmAsKind: "VM",
    });
    expect(parsed.name).toBe("Prod servers");
    expect(parsed.hostnamePattern).toBe("srv-*");
  });

  test("REFUSES a rule with no condition — ADR-0074 §1 rejected blanket auto-confirm", () => {
    expect(CreateInfraAutoConfirmRuleSchema.safeParse({ name: "everything" }).success).toBe(false);
    expect(
      CreateInfraAutoConfirmRuleSchema.safeParse({
        name: "everything",
        hostnamePattern: null,
        subnetCidr: null,
        reportedKind: null,
      }).success,
    ).toBe(false);
  });

  test("refuses a malformed CIDR and a hostname pattern with illegal characters", () => {
    expect(
      CreateInfraAutoConfirmRuleSchema.safeParse({ name: "x", subnetCidr: "10.20.0.0" }).success,
    ).toBe(false);
    expect(
      CreateInfraAutoConfirmRuleSchema.safeParse({ name: "x", hostnamePattern: "srv %" }).success,
    ).toBe(false);
  });

  test("is strict — matchCount and lastMatchedAt are server-owned, not client-settable", () => {
    expect(
      CreateInfraAutoConfirmRuleSchema.safeParse({
        name: "x",
        hostnamePattern: "srv-*",
        matchCount: 99,
      }).success,
    ).toBe(false);
  });
});

describe("UpdateInfraAutoConfirmRuleSchema (#1145)", () => {
  test("a partial patch is fine; an empty one is not", () => {
    expect(UpdateInfraAutoConfirmRuleSchema.parse({ enabled: false }).enabled).toBe(false);
    expect(UpdateInfraAutoConfirmRuleSchema.safeParse({}).success).toBe(false);
  });

  test("clearing the LAST condition through a patch is refused, not silently allowed", () => {
    // The API re-validates the MERGED rule too (the patch alone cannot see the stored row), but a
    // patch that nulls every condition it mentions is refusable here and is refused here.
    expect(
      UpdateInfraAutoConfirmRuleSchema.safeParse({
        hostnamePattern: null,
        subnetCidr: null,
        reportedKind: null,
        chassis: null,
      }).success,
    ).toBe(false);
  });

  test("dropping ONE of two conditions is a legitimate patch, not a blanket rule", () => {
    // A rule with `hostnamePattern: "srv-*"` AND `subnetCidr` that drops the subnet is left a
    // perfectly ordinary single-condition rule. The patch alone cannot see that, so refusing it here
    // refuses a legal edit outright — the operator cannot narrow a rule down to one condition at all.
    expect(UpdateInfraAutoConfirmRuleSchema.safeParse({ subnetCidr: null }).success).toBe(true);
    expect(UpdateInfraAutoConfirmRuleSchema.safeParse({ hostnamePattern: null }).success).toBe(true);
    expect(UpdateInfraAutoConfirmRuleSchema.safeParse({ reportedKind: null }).success).toBe(true);
    expect(UpdateInfraAutoConfirmRuleSchema.safeParse({ chassis: null }).success).toBe(true);
  });

  test("a patch that RESTATES every condition and narrows with none is refused", () => {
    // This is the one case the patch alone settles: when it fixes all four condition fields, the
    // stored row contributes nothing to the merged rule, so the patch IS the merged rule's conditions
    // and its emptiness is knowable here rather than only at the API's merged re-check.
    expect(
      UpdateInfraAutoConfirmRuleSchema.safeParse({
        hostnamePattern: "*",
        subnetCidr: "0.0.0.0/0",
        reportedKind: null,
        chassis: null,
      }).success,
    ).toBe(false);
  });

  test("chassis alone is a condition that can rule a proposal OUT (ADR-0093 §6)", () => {
    // "Auto-confirm the servers, review the laptops" is the bounded operator judgement ADR-0093 makes
    // writable, and it needs no second condition to be legitimate — the same footing `reportedKind` has.
    expect(
      CreateInfraAutoConfirmRuleSchema.safeParse({ name: "servers", chassis: "server" }).success,
    ).toBe(true);
    expect(statesAutoConfirmCondition({ chassis: "laptop" })).toBe(true);
    expect(statesAutoConfirmCondition({ chassis: null })).toBe(false);
    expect(statesAutoConfirmCondition({})).toBe(false);
  });

  test("a chassis outside the vocabulary is a clean 400, not a rule that never fires", () => {
    expect(
      CreateInfraAutoConfirmRuleSchema.safeParse({ name: "typo", chassis: "labtop" }).success,
    ).toBe(false);
  });
});

describe("InfraAutoConfirmRuleSchema (the wire shape)", () => {
  test("round-trips a saved rule, author included", () => {
    const parsed = InfraAutoConfirmRuleSchema.parse(
      rule({ createdById: "9f0d1c2b-3a4e-4f5a-8b6c-7d8e9f0a1b2c", createdByName: "Ada Lovelace" }),
    );
    expect(parsed.createdByName).toBe("Ada Lovelace");
  });
});
