import { describe, expect, it } from "bun:test";
import {
  DirectoryConnectionSchema,
  DirectorySyncResultSchema,
  UpdateDirectoryConnectionSchema,
} from "./directory-connection";

describe("UpdateDirectoryConnectionSchema (issue #839, ADR-0091)", () => {
  const base = {
    enabled: true,
    transport: "ldaps" as const,
    rejectUnauthorized: true,
    offboardGraceDays: 7,
  };

  it("accepts a well-formed connection", () => {
    const parsed = UpdateDirectoryConnectionSchema.safeParse({
      ...base,
      host: "dc01.corp.example.com",
      port: 636,
      baseDN: "OU=People,DC=corp,DC=example,DC=com",
      bindDN: "CN=svc-lazyit,OU=Service,DC=corp,DC=example,DC=com",
      searchFilter: "(&(objectClass=user)(objectCategory=person))",
      attributeMap: { firstName: "givenName", lastName: "sn", email: "mail" },
      bindPassword: "s3cret",
      serviceAccountId: "svc_123",
    });
    expect(parsed.success).toBe(true);
  });

  it("allows a half-filled disabled draft (nullish host/baseDN/filter)", () => {
    expect(
      UpdateDirectoryConnectionSchema.safeParse({ ...base, enabled: false }).success,
    ).toBe(true);
  });

  it("rejects a baseDN that is not DN-shaped", () => {
    expect(
      UpdateDirectoryConnectionSchema.safeParse({ ...base, baseDN: "not a dn" }).success,
    ).toBe(false);
  });

  it("rejects a searchFilter with unbalanced parentheses", () => {
    expect(
      UpdateDirectoryConnectionSchema.safeParse({
        ...base,
        searchFilter: "(&(objectClass=user)",
      }).success,
    ).toBe(false);
  });

  it("rejects a searchFilter not wrapped in parens", () => {
    expect(
      UpdateDirectoryConnectionSchema.safeParse({
        ...base,
        searchFilter: "objectClass=user",
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown transport mode", () => {
    expect(
      UpdateDirectoryConnectionSchema.safeParse({ ...base, transport: "ldap" }).success,
    ).toBe(false);
  });

  it("treats bindPassword as write-only optional (omitted keeps stored)", () => {
    const parsed = UpdateDirectoryConnectionSchema.safeParse({ ...base });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.bindPassword).toBeUndefined();
  });
});

describe("DirectoryConnectionSchema read shape", () => {
  it("never carries a bind password — only bindPasswordSet", () => {
    const shape = DirectoryConnectionSchema.shape;
    expect("bindPassword" in shape).toBe(false);
    expect("bindPasswordCiphertext" in shape).toBe(false);
    expect("bindPasswordSet" in shape).toBe(true);
  });

  it("validates a full redacted row", () => {
    const now = new Date().toISOString();
    const parsed = DirectoryConnectionSchema.safeParse({
      enabled: false,
      host: null,
      port: null,
      transport: "ldaps",
      rejectUnauthorized: true,
      baseDN: null,
      bindDN: null,
      searchFilter: null,
      attributeMap: null,
      offboardGraceDays: 7,
      bindPasswordSet: false,
      serviceAccountId: null,
      lastSyncAt: null,
      lastSyncStatus: "never",
      lastSyncCounts: null,
      createdAt: now,
      updatedAt: now,
    });
    expect(parsed.success).toBe(true);
  });
});

describe("DirectorySyncResultSchema", () => {
  it("validates a sync result with counts", () => {
    const now = new Date().toISOString();
    const parsed = DirectorySyncResultSchema.safeParse({
      ok: true,
      startedAt: now,
      finishedAt: now,
      counts: { created: 2, updated: 5, offboarded: 1, skipped: 0 },
      error: null,
    });
    expect(parsed.success).toBe(true);
  });
});
