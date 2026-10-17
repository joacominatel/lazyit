import { ApiError } from "./api";

interface Counts {
  created: number;
  skipped: number;
  failed: number;
}

interface Failure {
  entity: string;
  key: string;
  message: string;
}

export class PhaseFailedError extends Error {}

export class Report {
  private readonly counts = new Map<string, Counts>();
  private readonly failures: Failure[] = [];
  private readonly started = Date.now();
  private readonly phaseTimes: [string, number][] = [];

  private entry(entity: string): Counts {
    let counts = this.counts.get(entity);
    if (!counts) {
      counts = { created: 0, skipped: 0, failed: 0 };
      this.counts.set(entity, counts);
    }
    return counts;
  }

  created(entity: string, n = 1): void {
    this.entry(entity).created += n;
  }

  skipped(entity: string, n = 1): void {
    this.entry(entity).skipped += n;
  }

  failed(entity: string, key: string, err: unknown): void {
    this.entry(entity).failed++;
    const message =
      err instanceof ApiError
        ? `${err.status} ${err.method} ${err.path.replace(/[0-9a-f-]{20,}|c[a-z0-9]{20,}/g, ":id")}: ${err.message}`
        : String((err as Error)?.message ?? err);
    this.failures.push({ entity, key, message });
  }

  get(entity: string): Counts {
    return this.entry(entity);
  }

  async phase(name: string, entities: string[], body: () => Promise<void>): Promise<void> {
    const before = entities.map((e) => ({ ...this.entry(e) }));
    const t0 = Date.now();
    console.log(`\n== ${name}`);
    await body();
    this.phaseTimes.push([name, Date.now() - t0]);
    const delta = entities.map((e, i) => {
      const now = this.entry(e);
      const was = before[i]!;
      return {
        e,
        created: now.created - was.created,
        skipped: now.skipped - was.skipped,
        failed: now.failed - was.failed,
      };
    });
    for (const d of delta) {
      console.log(`   ${d.e.padEnd(26)} created ${d.created}  skipped ${d.skipped}  failed ${d.failed}`);
    }
    const worked = delta.reduce((s, d) => s + d.created + d.skipped, 0);
    const failed = delta.reduce((s, d) => s + d.failed, 0);
    if (failed > 0 && worked === 0) {
      throw new PhaseFailedError(`phase "${name}" failed for every row; first error: ${this.failures.at(-1)?.message}`);
    }
  }

  progress(label: string, total: number): Progress {
    return new Progress(label, total);
  }

  print(): void {
    const seconds = ((Date.now() - this.started) / 1000).toFixed(1);
    console.log(`\n== Summary (${seconds}s)`);
    console.log(`   ${"entity".padEnd(26)} ${"created".padStart(8)} ${"skipped".padStart(8)} ${"failed".padStart(8)}`);
    for (const [entity, c] of this.counts) {
      console.log(
        `   ${entity.padEnd(26)} ${String(c.created).padStart(8)} ${String(c.skipped).padStart(8)} ${String(c.failed).padStart(8)}`,
      );
    }
    console.log(`\n   phase timings: ${this.phaseTimes.map(([n, ms]) => `${n} ${(ms / 1000).toFixed(1)}s`).join(", ")}`);
    if (this.failures.length === 0) return;
    const grouped = new Map<string, Failure[]>();
    for (const f of this.failures) {
      const key = `${f.entity}: ${f.message}`;
      grouped.set(key, [...(grouped.get(key) ?? []), f]);
    }
    console.log(`\n== Failures (${this.failures.length})`);
    for (const [message, list] of grouped) {
      const examples = list.slice(0, 3).map((f) => f.key).join(", ");
      console.log(`   ${list.length}x ${message}\n      e.g. ${examples}`);
    }
  }

  get failureCount(): number {
    return this.failures.length;
  }
}

export class Progress {
  private done = 0;
  private lastPrint = 0;
  private readonly tty = Boolean(process.stdout.isTTY);

  constructor(
    private readonly label: string,
    private readonly total: number,
  ) {}

  tick(): void {
    this.done++;
    const now = Date.now();
    const finished = this.done === this.total;
    if (this.tty) {
      if (finished || now - this.lastPrint > 200) {
        process.stdout.write(`\r   ${this.label} ${this.done}/${this.total}${finished ? "\n" : ""}`);
        this.lastPrint = now;
      }
    } else if (finished || now - this.lastPrint > 5000) {
      console.log(`   ${this.label} ${this.done}/${this.total}`);
      this.lastPrint = now;
    }
  }
}
