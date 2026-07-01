import { describe, expect, test } from "bun:test";
import {
  CAPABILITY_IDS,
  PERMISSION_DOMAINS,
  PERMISSIONS,
} from "@lazyit/shared";
import enSettings from "./en/settings.json";
import esSettings from "./es/settings.json";

/**
 * Web-side i18n COVERING-SET guard (#900, cf. #882). The shared package owns the permission catalog —
 * the {@link PERMISSION_DOMAINS} (role summary rows), the per-permission {@link PERMISSIONS} META, and
 * the operator-facing {@link CAPABILITY_IDS} toggles. The web renders EACH id via a `settings.json`
 * key; when the catalog grows but the message catalog doesn't, `next-intl` throws MISSING_MESSAGE at
 * runtime (the CEO hit `permissionMeta.capabilities.article:manage`, `roles…summary.domains.notification`,
 * …). This mirrors the shared `permission-meta.test.ts` covering-set guard, extending it across the
 * i18n boundary: it maps every shared id to its EN + ES key and fails on the first hole — before it
 * ships. It is the guard whose absence let this class of drift recur (#877/#882).
 *
 * Key-shape note: `permissionMeta.permissions.*` and `roles.permissions.summary.domains.*` are keyed by
 * the RAW ids (`article:manage`, `notification`); `permissionMeta.capabilities.*` is keyed by the COLON
 * form of the dotted `CapabilityId` (`article.manage` → `article:manage`).
 */

type Json = Record<string, unknown>;

const CATALOGS = {
  en: enSettings as unknown as Json,
  es: esSettings as unknown as Json,
} as const;

const LOCALES = Object.keys(CATALOGS) as (keyof typeof CATALOGS)[];

/** A non-empty string at a dotted path, or `undefined` if any segment is missing / not an object. */
function readString(root: Json, path: readonly string[]): string | undefined {
  let node: unknown = root;
  for (const key of path) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Json)[key];
  }
  return typeof node === "string" && node.trim().length > 0 ? node : undefined;
}

describe.each(LOCALES)("permission i18n coverage — %s", (locale) => {
  const catalog = CATALOGS[locale];

  test.each([...PERMISSIONS])(
    "permissionMeta.permissions.%s has a label",
    (permission) => {
      expect(
        readString(catalog, [
          "permissionMeta",
          "permissions",
          permission,
          "label",
        ]),
      ).toBeDefined();
    },
  );

  test.each([...CAPABILITY_IDS])(
    "permissionMeta.capabilities.%s has a label + description",
    (capabilityId) => {
      // The JSON keys the capabilities by the colon form of the dotted CapabilityId.
      const key = capabilityId.split(".").join(":");
      expect(
        readString(catalog, ["permissionMeta", "capabilities", key, "label"]),
      ).toBeDefined();
      expect(
        readString(catalog, [
          "permissionMeta",
          "capabilities",
          key,
          "description",
        ]),
      ).toBeDefined();
    },
  );

  test.each([...PERMISSION_DOMAINS])(
    "roles.permissions.summary.domains.%s has a label",
    (domain) => {
      expect(
        readString(catalog, [
          "roles",
          "permissions",
          "summary",
          "domains",
          domain,
        ]),
      ).toBeDefined();
    },
  );
});
