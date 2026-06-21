import { describe, expect, it } from "bun:test";
import {
  parseEnv,
  serializeEnv,
  splitNewVsExisting,
} from "./env-file";

describe("parseEnv", () => {
  it("parses simple KEY=value pairs", () => {
    const { entries, malformed } = parseEnv("FOO=bar\nBAZ=qux");
    expect(entries).toEqual([
      { key: "FOO", value: "bar" },
      { key: "BAZ", value: "qux" },
    ]);
    expect(malformed).toEqual([]);
  });

  it("ignores comments and blank lines", () => {
    const { entries } = parseEnv("# a comment\n\nFOO=bar\n   \n# another\nBAZ=qux");
    expect(entries).toEqual([
      { key: "FOO", value: "bar" },
      { key: "BAZ", value: "qux" },
    ]);
  });

  it("strips the `export ` prefix", () => {
    const { entries } = parseEnv("export FOO=bar");
    expect(entries).toEqual([{ key: "FOO", value: "bar" }]);
  });

  it("handles double-quoted values with escapes and spaces", () => {
    const { entries } = parseEnv('FOO="a b\\nc"');
    expect(entries).toEqual([{ key: "FOO", value: "a b\nc" }]);
  });

  it("handles single-quoted values literally (no escape processing)", () => {
    const { entries } = parseEnv("FOO='a b\\nc'");
    expect(entries).toEqual([{ key: "FOO", value: "a b\\nc" }]);
  });

  it("strips trailing inline comments from unquoted values only", () => {
    expect(parseEnv("FOO=bar # trailing").entries).toEqual([
      { key: "FOO", value: "bar" },
    ]);
    // a `#` inside a quoted value is preserved
    expect(parseEnv('FOO="bar # not a comment"').entries).toEqual([
      { key: "FOO", value: "bar # not a comment" },
    ]);
  });

  it("keeps `=` characters inside the value (only the first `=` splits)", () => {
    expect(parseEnv("URL=postgres://u:p@h/db?x=1&y=2").entries).toEqual([
      { key: "URL", value: "postgres://u:p@h/db?x=1&y=2" },
    ]);
  });

  it("flags malformed lines (no `=`, bad key) without dropping the good ones", () => {
    const { entries, malformed } = parseEnv("GOOD=1\nnonsense line\n1BAD=2\nALSO_GOOD=3");
    expect(entries).toEqual([
      { key: "GOOD", value: "1" },
      { key: "ALSO_GOOD", value: "3" },
    ]);
    expect(malformed).toEqual([
      { line: 2, raw: "nonsense line" },
      { line: 3, raw: "1BAD=2" },
    ]);
  });

  it("applies last-wins on duplicate keys within the blob", () => {
    const { entries } = parseEnv("FOO=1\nFOO=2");
    expect(entries).toEqual([{ key: "FOO", value: "2" }]);
  });

  it("treats an empty value as an empty string", () => {
    expect(parseEnv("FOO=").entries).toEqual([{ key: "FOO", value: "" }]);
  });
});

describe("splitNewVsExisting (skip-existing collision policy, #613)", () => {
  it("separates new keys from those already in the vault", () => {
    const entries = [
      { key: "NEW_ONE", value: "a" },
      { key: "EXISTS", value: "b" },
      { key: "NEW_TWO", value: "c" },
    ];
    const { toCreate, skipped } = splitNewVsExisting(entries, ["EXISTS", "OTHER"]);
    expect(toCreate).toEqual([
      { key: "NEW_ONE", value: "a" },
      { key: "NEW_TWO", value: "c" },
    ]);
    expect(skipped).toEqual([{ key: "EXISTS", value: "b" }]);
  });

  it("never overwrites — an existing key is always skipped, never created", () => {
    const { toCreate, skipped } = splitNewVsExisting(
      [{ key: "EXISTS", value: "new" }],
      ["EXISTS"],
    );
    expect(toCreate).toEqual([]);
    expect(skipped).toEqual([{ key: "EXISTS", value: "new" }]);
  });

  it("creates everything when the vault is empty", () => {
    const entries = [{ key: "A", value: "1" }];
    const { toCreate, skipped } = splitNewVsExisting(entries, []);
    expect(toCreate).toEqual(entries);
    expect(skipped).toEqual([]);
  });

  it("is case-sensitive (distinct keys are not collapsed)", () => {
    const { toCreate, skipped } = splitNewVsExisting(
      [{ key: "foo", value: "1" }],
      ["FOO"],
    );
    expect(toCreate).toEqual([{ key: "foo", value: "1" }]);
    expect(skipped).toEqual([]);
  });
});

describe("serializeEnv (export, #612) round-trips with parseEnv", () => {
  it("serializes simple pairs", () => {
    expect(serializeEnv([{ key: "FOO", value: "bar" }])).toBe("FOO=bar");
  });

  it("quotes values that need it", () => {
    expect(serializeEnv([{ key: "FOO", value: "a b" }])).toBe('FOO="a b"');
    expect(serializeEnv([{ key: "FOO", value: "with#hash" }])).toBe('FOO="with#hash"');
  });

  it("round-trips: parse(serialize(x)) === x for tricky values", () => {
    const entries = [
      { key: "PLAIN", value: "value" },
      { key: "SPACES", value: "a b c" },
      { key: "NEWLINE", value: "line1\nline2" },
      { key: "QUOTE", value: 'he said "hi"' },
      { key: "HASH", value: "has # inside" },
      { key: "EMPTY", value: "" },
      { key: "URL", value: "postgres://u:p@h/db?x=1" },
    ];
    const text = serializeEnv(entries);
    expect(parseEnv(text).entries).toEqual(entries);
  });
});
