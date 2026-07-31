import { describe, expect, test } from "bun:test";
import { COLLECT_TIMEOUT_MS, run } from "./collect";

/**
 * Issue #1133. Collection was unbounded: `run()` awaited Bun Shell, which offers no timeout, and
 * `collectHost` fires every collector concurrently. On a host where `lsblk` blocks on a degraded
 * NFS mount — or `dmidecode` blocks on a bad BMC — the whole report hung, the systemd unit stayed
 * in `activating` forever, and because `OnUnitActiveSec` only re-arms once a unit goes inactive,
 * THE TIMER NEVER FIRED AGAIN. The host then went dark and the staleness sweeper reported the
 * HOST as offline, when it was the agent that was wedged: the CMDB reported a false outage.
 *
 * These tests pin the contract `run()` owes the rest of the collector: a bounded wait, and `null`
 * for every failure mode so the best-effort design keeps degrading gracefully instead of throwing.
 */
describe("run", () => {
  test("returns stdout on success", async () => {
    expect(await run(["echo", "hello"])).toBe("hello\n");
  });

  test("returns null when the binary is missing", async () => {
    // The degradation path that matters most: a distro without lsblk/dmidecode/ip must still report.
    expect(await run(["lazyit-no-such-binary-exists"])).toBeNull();
  });

  test("returns null on a non-zero exit", async () => {
    expect(await run(["false"])).toBeNull();
  });

  test("kills a hung command at the timeout and returns null", async () => {
    const startedAt = Date.now();
    const out = await run(["sleep", "30"], 150);
    const elapsed = Date.now() - startedAt;

    expect(out).toBeNull();
    // The point of the issue: it must come back, and it must come back near the budget — not after
    // the 30s sleep, and not never. A generous ceiling keeps this green on a loaded CI runner.
    expect(elapsed).toBeLessThan(5_000);
  });

  test("the default timeout is bounded and shorter than systemd's RuntimeMaxSec", () => {
    // install.sh caps the unit at RuntimeMaxSec=120. Every collector must be able to time out and
    // still let the agent finish a partial report BEFORE systemd kills the process outright —
    // otherwise a degraded host reports nothing instead of reporting what it could gather.
    expect(COLLECT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(COLLECT_TIMEOUT_MS).toBeLessThan(120_000);
  });
});
