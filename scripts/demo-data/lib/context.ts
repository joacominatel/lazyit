import type { User } from "@lazyit/shared";
import type { Client } from "./api";
import type { Report } from "./report";

export const VOLUME_KEYS = ["users", "assets", "grants", "requesters", "purchases", "articles"] as const;
export type VolumeKey = (typeof VOLUME_KEYS)[number];
export type Volumes = Record<VolumeKey, number>;

export const PROFILES: Record<"full" | "small", Volumes> = {
  full: { users: 4000, assets: 2000, grants: 5000, requesters: 30, purchases: 80, articles: 700 },
  small: { users: 200, assets: 100, grants: 250, requesters: 4, purchases: 12, articles: 35 },
};

// Catalog sizes: same in both profiles (they are the variation surface), capped by the word lists.
export const TAXA = {
  applications: { nominal: 15, max: 17 },
  suppliers: { nominal: 25, max: 28 },
  statusLabels: { nominal: 10, max: 11 },
  assetModels: { nominal: 60, max: 60 },
  consumables: { nominal: 40, max: 46 },
  folders: { nominal: 40, max: 46 },
} as const;
export type TaxonKey = keyof typeof TAXA;
export type Taxa = Record<TaxonKey, number>;

export interface PlannedUser {
  index: number;
  id?: string;
  email: string;
}

export interface Ctx {
  api: Client;
  seed: string;
  concurrency: number;
  volumes: Volumes;
  taxa: Taxa;
  report: Report;
  me: User;
  assetCategories: Map<string, string>;
  applicationCategories: Map<string, string>;
  consumableCategories: Map<string, string>;
  locations: Map<string, { id: string; type: string }>;
  models: Map<string, { id: string; category: string }>;
  labels: Map<string, { id: string; kind: string }>;
  suppliers: Map<string, string>;
  applications: Map<string, string>;
  users: PlannedUser[];
  assets: Map<number, string>;
  consumables: Map<string, string>;
}

export function modelKey(manufacturer: string, name: string): string {
  return `${manufacturer}|${name}`;
}

// Maps fill in completion order under concurrency; planners read them sorted so the plan never depends on timing.
export function sortedEntries<K extends string | number, V>(map: Map<K, V>): [K, V][] {
  return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
