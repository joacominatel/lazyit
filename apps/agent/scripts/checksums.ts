#!/usr/bin/env bun
/**
 * Write a `.sha256` next to every compiled agent artifact (ADR-0074 §6 amendment, issue #1137).
 *
 * `install.sh` fetches the digest from `GET /api/agent/checksum` and refuses to install a binary
 * that does not match it. Generating it HERE, in the same step that produced the binary, is what
 * makes the comparison mean anything: the digest is a record of what the build emitted, so swapping
 * the binary later also requires swapping this file, and a tamper that misses one is visible at the
 * installer instead of nowhere at all.
 *
 * Stated plainly: this is an integrity check, not a signature. ADR-0074 defers cosign as an
 * enterprise ask, and nothing here pretends otherwise.
 *
 * Bun's own hasher rather than `sha256sum`, because this script also runs on a developer's macOS
 * machine, where that tool does not exist (it is `shasum -a 256` there) — and reaching for a hasher
 * the repo already ships beats branching on the platform. Streamed, because these artifacts are
 * ~100 MB each and a build stage should not hold three of them in memory to hash them.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const DIST = join(import.meta.dir, "..", "dist");

async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}

let names: string[];
try {
  names = await readdir(DIST);
} catch {
  console.error(`checksums: no ${DIST} — run the compile scripts first`);
  process.exit(1);
}

const artifacts = names.filter((name) => !name.endsWith(".sha256")).sort();
if (artifacts.length === 0) {
  console.error(`checksums: ${DIST} holds no artifacts — run the compile scripts first`);
  process.exit(1);
}

for (const name of artifacts) {
  const digest = await sha256(join(DIST, name));
  // Bare hex plus a newline. The controller trims a `sha256sum`-style `<hex>  <name>` too, but the
  // bare form is what install.sh compares against and what keeps the two ends boring.
  await Bun.write(join(DIST, `${name}.sha256`), `${digest}\n`);
  console.log(`${digest}  ${name}`);
}
