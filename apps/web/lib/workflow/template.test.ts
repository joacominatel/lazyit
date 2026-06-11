import { expect, test } from "bun:test";
import type { WorkflowStep } from "@lazyit/shared";
import {
  groupTokens,
  insertAt,
  jsonToMapping,
  knownRootsFor,
  mappingToJson,
  parseTemplate,
  validateTemplate,
  wrapToken,
} from "./template";
import { buildContextTokens } from "./context-tokens";

const CONN = "ckconn00000000000000000000";

test("parseTemplate splits literals and tokens in order", () => {
  const segments = parseTemplate("Hello {{ grantee.firstName }}!");
  expect(segments).toEqual([
    { type: "literal", text: "Hello " },
    {
      type: "token",
      raw: "grantee.firstName",
      path: "grantee.firstName",
      root: "grantee",
    },
    { type: "literal", text: "!" },
  ]);
});

test("parseTemplate concatenates multiple tokens with a literal between (issue #338)", () => {
  const segments = parseTemplate("{{ grantee.firstName }} {{ grantee.lastName }}");
  expect(segments.map((s) => s.type)).toEqual(["token", "literal", "token"]);
  expect(segments[1]).toEqual({ type: "literal", text: " " });
});

test("parseTemplate keeps a filter chain in the raw expression", () => {
  const [token] = parseTemplate("{{ grantee.email | lower | trim }}");
  expect(token).toMatchObject({
    type: "token",
    path: "grantee.email",
    root: "grantee",
  });
});

test("parseTemplate leaves a dangling brace as a literal", () => {
  expect(parseTemplate("/users/{{ grantee.id")).toEqual([
    { type: "literal", text: "/users/{{ grantee.id" },
  ]);
});

test("an empty template parses to no segments", () => {
  expect(parseTemplate("")).toEqual([]);
});

const ROOTS = knownRootsFor();

test("validateTemplate accepts a known root and a pure literal", () => {
  expect(validateTemplate("{{ grantee.email }}", ROOTS).hasError).toBe(false);
  expect(validateTemplate("/static/path", ROOTS).hasError).toBe(false);
  expect(validateTemplate("", ROOTS).hasError).toBe(false);
});

test("validateTemplate flags an unknown root", () => {
  const result = validateTemplate("{{ secrets.apiToken }}", ROOTS);
  expect(result.unknownRoots).toEqual(["secrets"]);
  expect(result.hasError).toBe(true);
});

test("validateTemplate flags unbalanced braces", () => {
  const result = validateTemplate("/users/{{ grantee.id }/x", ROOTS);
  expect(result.unbalanced).toBe(true);
  expect(result.hasError).toBe(true);
});

test("validateTemplate flags a malformed (empty) path", () => {
  const result = validateTemplate("{{  }}", ROOTS);
  expect(result.malformedPaths.length).toBeGreaterThan(0);
  expect(result.hasError).toBe(true);
});

test("validateTemplate warns on an unknown filter without erroring", () => {
  const result = validateTemplate("{{ grantee.email | base64 }}", ROOTS);
  expect(result.unknownFilters).toEqual(["base64"]);
  // An unknown filter no-ops server-side, so it is a soft warning, not a hard error.
  expect(result.hasError).toBe(false);
});

test("validateTemplate accepts the closed filter set", () => {
  for (const filter of ["upper", "lower", "trim", "default:'x'"]) {
    const result = validateTemplate(`{{ grantee.email | ${filter} }}`, ROOTS);
    expect(result.unknownFilters).toEqual([]);
    expect(result.hasError).toBe(false);
  }
});

test("knownRootsFor includes prior-step outputs (steps.<key>)", () => {
  const prior: WorkflowStep[] = [
    {
      kind: "REST",
      key: "step-1",
      connectionId: CONN,
      method: "POST",
      path: "/",
      idempotent: false,
      onError: "fail",
    },
  ];
  const roots = knownRootsFor(prior);
  expect(roots.has("grantee")).toBe(true);
  expect(roots.has("steps")).toBe(true);
  // A prior step's output is a valid root, so referencing it must pass validation.
  expect(
    validateTemplate("{{ steps.step-1.response }}", roots).hasError,
  ).toBe(false);
});

test("knownRootsFor matches the server mapper's ALLOWED_ROOTS exactly (drift guard, #350)", () => {
  // The client validation allowlist MUST equal the engine's resolvable roots
  // (apps/api/src/workflow-engine/mapping/data-mapper.ts ALLOWED_ROOTS + run-context.ts):
  // { event, grantee, application, grant, steps }. Any drift makes the builder mis-report
  // what will resolve at run time — flagging a valid token, or passing one that renders empty.
  const prior: WorkflowStep[] = [
    {
      kind: "REST",
      key: "step-1",
      connectionId: CONN,
      method: "POST",
      path: "/",
      idempotent: false,
      onError: "fail",
    },
  ];
  const roots = knownRootsFor(prior);
  expect([...roots].sort()).toEqual(
    ["application", "event", "grant", "grantee", "steps"].sort(),
  );
  // No false positive: the scalar `event` root (the trigger) resolves, so it must pass.
  expect(validateTemplate("{{ event }}", roots).hasError).toBe(false);
  // No false negative: there is no `context` root on the engine, so it must flag.
  expect(
    validateTemplate("{{ context.actor }}", roots).unknownRoots,
  ).toEqual(["context"]);
});

test("the catalog offers the ADR-0058 grantee tokens and they resolve (no drift, #357)", () => {
  // #357: legajo / username / manager.{name,email} were added additively under the existing `grantee`
  // root — the engine's run-context.ts projectGrantee now resolves them. They must be in the catalog
  // (the picker offers them) AND validate (no NEW unknown root, since `grantee` was already allowed).
  const paths = buildContextTokens().map((token) => token.path);
  for (const path of [
    "grantee.legajo",
    "grantee.username",
    "grantee.manager.name",
    "grantee.manager.email",
  ]) {
    expect(paths).toContain(path);
    expect(validateTemplate(`{{ ${path} }}`, knownRootsFor()).hasError).toBe(
      false,
    );
  }
});

test("wrapToken round-trips through parseTemplate to a single token", () => {
  const segments = parseTemplate(wrapToken("application.name"));
  expect(segments).toEqual([
    {
      type: "token",
      raw: "application.name",
      path: "application.name",
      root: "application",
    },
  ]);
});

test("insertAt drops text at the caret and reports the new caret", () => {
  // "{{ grantee.id }}" is 16 chars inserted at offset 7 ⇒ caret lands at 23.
  expect(insertAt("/users//deactivate", 7, 7, "{{ grantee.id }}")).toEqual({
    value: "/users/{{ grantee.id }}/deactivate",
    caret: 23,
  });
});

test("insertAt replaces a selection", () => {
  expect(insertAt("/users/OLD/x", 7, 10, "{{ grantee.id }}")).toEqual({
    value: "/users/{{ grantee.id }}/x",
    caret: 23,
  });
});

test("insertAt clamps out-of-range offsets", () => {
  const { value } = insertAt("abc", 99, 99, "X");
  expect(value).toBe("abcX");
});

test("groupTokens partitions the catalog by group preserving order", () => {
  const grouped = groupTokens(buildContextTokens());
  expect([...grouped.keys()]).toContain("grantee");
  expect(grouped.get("grantee")?.[0]?.path).toBe("grantee.email");
});

test("mapping ↔ JSON round-trips (issue #339)", () => {
  const mapping = {
    email: "{{ grantee.email }}",
    name: "{{ grantee.firstName }} {{ grantee.lastName }}",
  };
  const json = mappingToJson(mapping);
  expect(jsonToMapping(json)).toEqual({ mapping });
});

test("mappingToJson renders an empty mapping as {}", () => {
  expect(mappingToJson(undefined)).toBe("{}");
});

test("jsonToMapping treats blank / {} as no mapping", () => {
  expect(jsonToMapping("")).toEqual({ mapping: undefined });
  expect(jsonToMapping("{}")).toEqual({ mapping: undefined });
});

test("jsonToMapping reports a parse error without throwing", () => {
  const result = jsonToMapping("{ bad json");
  expect(result.error).toBeDefined();
  expect(result.mapping).toBeUndefined();
});

test("jsonToMapping rejects a non-string value", () => {
  expect(jsonToMapping('{"age": 30}').error).toContain("age");
});

test("jsonToMapping rejects a non-object document", () => {
  expect(jsonToMapping("[1,2,3]").error).toBeDefined();
});
