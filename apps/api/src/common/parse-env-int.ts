/**
 * Read a POSITIVE-INTEGER env knob, falling back when the value is unset, blank, non-numeric, zero or
 * negative. The shared version of the idiom the sweepers already use inline (`envMs` in
 * `infra-agent-staleness.sweeper.ts`, the parsers in `attachments.constants.ts`).
 *
 * FALL BACK, never throw: these knobs tune limits on a self-hosted box an operator edits by hand, and
 * a typo in one env var must not stop the API from booting. A silently-ignored bad value leaves the
 * safe default in force, which is the failure mode we want (a rate limit that still limits).
 *
 * `0` and negatives are rejected on purpose: every caller is a cap or an interval where "0" would mean
 * "block everything" / "spin forever" — almost certainly a mistake, never an intent worth honouring.
 * Fractions are floored, so `1.9` is 1 (a cap is a count).
 *
 * Pure + framework-free so it unit-tests in isolation.
 */
export function parseEnvInt(
  name: string,
  fallback: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
