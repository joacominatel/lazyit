---
id: SEC-NNN
title: <one-line title>
severity: critical | high | medium | low | info
status: open
cwe: CWE-XXX
discovered: YYYY-MM-DD
module: <area — e.g. articles / users / transversal / infra>
tags: []
---

# SEC-NNN — <title>

## Summary

One sentence: what happens.

## Description

The bug: how it manifests, what conditions trigger it, why the current code allows it.

## Impact

What is compromised and who can do it. State the dev-only / no-auth context as mitigation where it
applies — rate intrinsic exploitability, not the hypothetical public exposure.

## Proof of concept

A `curl` or code snippet that triggers it. If it was reasoned from the code and **not executed**, say
so explicitly (the API is not run during review).

## Affected

- `path/to/file.ts:line` — what is there.
- (append `(at commit <hash>)` if the file may move or be deleted soon.)

## Recommendation

The concrete fix, with reference code where it helps. Keep the app-code change for the feature agents;
describe it precisely.

## Prevention

How to stop the whole class recurring: a pattern, a lint rule, an ADR, a test.

## References

CWE / OWASP / RFC / relevant ADR or doc links.
