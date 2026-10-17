function hash(text: string): number {
  let h = 1779033703 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("pick from an empty list");
    return items[Math.floor(this.next() * items.length)]!;
  }

  weighted<T>(entries: readonly (readonly [T, number])[]): T {
    const total = entries.reduce((sum, [, w]) => sum + w, 0);
    let roll = this.next() * total;
    for (const [value, weight] of entries) {
      roll -= weight;
      if (roll < 0) return value;
    }
    return entries[entries.length - 1]![0];
  }

  sample<T>(items: readonly T[], count: number): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [copy[i], copy[j]] = [copy[j]!, copy[i]!];
    }
    return copy.slice(0, Math.min(count, copy.length));
  }

  chars(length: number, alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789"): string {
    let out = "";
    for (let i = 0; i < length; i++) out += alphabet[Math.floor(this.next() * alphabet.length)];
    return out;
  }
}

// One stream per record, so record N is the same in every profile and a small run is a prefix of a full one.
export function rngFor(seed: string, ...scope: (string | number)[]): Rng {
  return new Rng(hash([seed, ...scope].join("\u0000")));
}

// Targets are nudged 4-15% off their nominal value and never land on a round number; same seed, same target.
export function jitter(seed: string, key: string, nominal: number, max = Number.MAX_SAFE_INTEGER): number {
  const rng = rngFor(seed, "count", key, nominal);
  let n =
    nominal < 20
      ? Math.max(1, nominal + rng.pick([-1, 1, 2]))
      : Math.round(nominal * (1 + (rng.chance(0.5) ? 1 : -1) * (0.04 + rng.next() * 0.11)));
  if (n > max) n = Math.max(1, 2 * nominal - n);
  if (n % 10 === 0) n += n + 1 <= max ? 1 : -1;
  return Math.min(n, max);
}

// Two letters that keep seed-scoped identifiers (legajo, purchase reference) apart when several seeds share an instance.
export function seedCode(seed: string): string {
  return rngFor(seed, "code").chars(2, "ABCDEFGHJKLMNPRSTUVWXYZ");
}

const DAY_MS = 86_400_000;

export function daysFromNow(days: number): string {
  return new Date(Date.now() + days * DAY_MS).toISOString();
}

export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}
