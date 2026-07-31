import { describe, expect, test } from "bun:test";
import { detectCodeLanguage } from "./detect-code-language";

/**
 * Unit coverage for the render-time code-fence language auto-detect (KB/Settings UX batch). The
 * function is the confidence boundary: it must recognize the IT/Systems runbook languages the KB
 * actually holds from a lightweight signature, and — crucially — return `null` on an ambiguous block
 * so an un-fenced snippet never gets mis-highlighted. It only ever returns an ALREADY-registered
 * grammar (see components/code-highlighter.tsx).
 */

describe("detectCodeLanguage — confident matches", () => {
  test("the CEO's python one-liner", () => {
    expect(detectCodeLanguage("def sum(a,b): return a+b")).toBe("python");
  });

  test("python import block", () => {
    expect(
      detectCodeLanguage("import os\nfrom pathlib import Path\n\nprint(os.getcwd())"),
    ).toBe("python");
  });

  test("SQL select", () => {
    expect(
      detectCodeLanguage("SELECT id, name FROM users WHERE active = true;"),
    ).toBe("sql");
  });

  test("strict-parseable JSON document", () => {
    expect(detectCodeLanguage('{\n  "name": "lazyit",\n  "ports": [3000, 3001]\n}')).toBe(
      "json",
    );
  });

  test("YAML mapping (several key: lines)", () => {
    expect(
      detectCodeLanguage("name: build\nversion: 1.0\nsteps:\n  - checkout\n  - test"),
    ).toBe("yaml");
  });

  test("bash / shell command", () => {
    expect(detectCodeLanguage("sudo apt-get install -y nginx")).toBe("bash");
  });

  test("bash shebang", () => {
    expect(detectCodeLanguage("#!/usr/bin/env bash\nset -euo pipefail")).toBe("bash");
  });

  test("Dockerfile (FROM + instruction)", () => {
    expect(detectCodeLanguage("FROM node:20-alpine\nWORKDIR /app\nRUN bun install")).toBe(
      "dockerfile",
    );
  });

  test("unified diff", () => {
    expect(
      detectCodeLanguage(
        "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n-old\n+new",
      ),
    ).toBe("diff");
  });

  test("Go package", () => {
    expect(
      detectCodeLanguage('package main\n\nimport "fmt"\n\nfunc main() { fmt.Println("hi") }'),
    ).toBe("go");
  });

  test("JavaScript const + arrow", () => {
    expect(detectCodeLanguage("const add = (a, b) => a + b;\nconsole.log(add(1, 2));")).toBe(
      "javascript",
    );
  });

  test("TypeScript interface (before the JS fallback)", () => {
    expect(detectCodeLanguage("export interface User {\n  id: string;\n}")).toBe(
      "typescript",
    );
  });

  test("PowerShell cmdlet", () => {
    expect(detectCodeLanguage("Get-Service | Where-Object { $_.Status -eq 'Running' }")).toBe(
      "powershell",
    );
  });

  test("nginx server block", () => {
    expect(
      detectCodeLanguage("server {\n  listen 80;\n  server_name example.com;\n}"),
    ).toBe("nginx");
  });
});

describe("detectCodeLanguage — falls back to null (never mis-highlight)", () => {
  test("ambiguous prose", () => {
    expect(detectCodeLanguage("the quick brown fox jumps over the lazy dog")).toBeNull();
  });

  test("a single bare word", () => {
    expect(detectCodeLanguage("hello")).toBeNull();
  });

  test("empty / whitespace only", () => {
    expect(detectCodeLanguage("")).toBeNull();
    expect(detectCodeLanguage("   \n  \t ")).toBeNull();
  });

  test("a single un-keyed line that looks like nothing in particular", () => {
    expect(detectCodeLanguage("just a value 42 here")).toBeNull();
  });
});
