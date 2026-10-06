import { describe, expect, test } from "bun:test";
import {
  type UpdateDirectoryConnection,
  UpdateDirectoryConnectionSchema,
} from "@lazyit/shared";
import {
  attributeInputsFrom,
  buildAttributeMap,
  emptyToNull,
  toDirectoryPayload,
} from "./directory-form";

/**
 * Unit coverage for the pure Directory-editor form glue (#839, ADR-0091). The two behaviours that must
 * never regress: the attribute map assembles from the four profile inputs (blanks dropped, `null` when
 * empty) and the write-only bind password is stripped when blank so re-saving the read form can't wipe the
 * stored secret. The assembled payload is round-tripped through the SAME shared schema the API validates
 * with, so a drift between this UI and the wire contract fails here.
 */

const BASE_VALUES: UpdateDirectoryConnection = {
  enabled: true,
  host: "ldap.corp.example.com",
  port: 636,
  transport: "ldaps",
  rejectUnauthorized: true,
  baseDN: "OU=People,DC=corp,DC=example,DC=com",
  bindDN: "CN=svc-lazyit,OU=Service,DC=corp,DC=example,DC=com",
  searchFilter: "(&(objectClass=user)(objectCategory=person))",
  offboardGraceDays: 7,
};

const NO_ATTRS = { firstName: "", lastName: "", email: "", username: "" };
const AD_ATTRS = {
  firstName: "givenName",
  lastName: "sn",
  email: "mail",
  username: "sAMAccountName",
};

describe("buildAttributeMap", () => {
  test("assembles only the non-blank, trimmed entries", () => {
    expect(
      buildAttributeMap({
        firstName: " givenName ",
        lastName: "sn",
        email: "",
        username: "sAMAccountName",
      }),
    ).toEqual({ firstName: "givenName", lastName: "sn", username: "sAMAccountName" });
  });

  test("returns null when every input is blank (unset, not {})", () => {
    expect(buildAttributeMap(NO_ATTRS)).toBeNull();
    expect(buildAttributeMap({ firstName: "   ", lastName: "", email: "", username: "" })).toBeNull();
  });
});

describe("emptyToNull", () => {
  test("blank / whitespace → null, otherwise the original value", () => {
    expect(emptyToNull("")).toBeNull();
    expect(emptyToNull("   ")).toBeNull();
    expect(emptyToNull("ldap.corp")).toBe("ldap.corp");
  });
});

describe("attributeInputsFrom", () => {
  test("seeds from a stored map, defaulting missing keys to empty", () => {
    expect(attributeInputsFrom({ firstName: "givenName", email: "mail" })).toEqual({
      firstName: "givenName",
      lastName: "",
      email: "mail",
      username: "",
    });
    expect(attributeInputsFrom(null)).toEqual(NO_ATTRS);
  });
});

describe("toDirectoryPayload", () => {
  test("omits bindPassword when blank (keeps the stored secret)", () => {
    const payload = toDirectoryPayload({ ...BASE_VALUES, bindPassword: "  " });
    expect("bindPassword" in payload).toBe(false);
  });

  test("includes bindPassword when a non-empty value is typed (set/rotate)", () => {
    const payload = toDirectoryPayload({ ...BASE_VALUES, bindPassword: "s3cret" });
    expect(payload.bindPassword).toBe("s3cret");
  });

  test("assembles attributeMap from the form field, dropping blanks (null when none)", () => {
    expect(
      toDirectoryPayload({ ...BASE_VALUES, attributeMap: AD_ATTRS }).attributeMap,
    ).toEqual(AD_ATTRS);
    expect(toDirectoryPayload({ ...BASE_VALUES, attributeMap: NO_ATTRS }).attributeMap).toBeNull();
    expect(toDirectoryPayload(BASE_VALUES).attributeMap).toBeNull();
  });

  test("normalizes undefined/null scalars to null on the wire", () => {
    const payload = toDirectoryPayload({ ...BASE_VALUES, host: undefined, bindDN: null });
    expect(payload.host).toBeNull();
    expect(payload.bindDN).toBeNull();
  });

  test("produces a payload the shared write schema accepts", () => {
    const payload = toDirectoryPayload({ ...BASE_VALUES, attributeMap: AD_ATTRS });
    const parsed = UpdateDirectoryConnectionSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
  });

  test("a malformed baseDN is rejected by the shared schema (the trust boundary still bites)", () => {
    const payload = toDirectoryPayload({ ...BASE_VALUES, baseDN: "not a dn" });
    const parsed = UpdateDirectoryConnectionSchema.safeParse(payload);
    expect(parsed.success).toBe(false);
  });
});
