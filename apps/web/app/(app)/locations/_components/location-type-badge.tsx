import type { LocationType } from "@lazyit/shared";
import { Badge } from "@/components/ui/badge";

/** "DATACENTER" → "Datacenter". The LocationType enum values are single words. */
export function formatLocationType(type: LocationType): string {
  return type.charAt(0) + type.slice(1).toLowerCase();
}

/** Small, neutral badge for a location's classification. */
export function LocationTypeBadge({ type }: { type: LocationType }) {
  return <Badge variant="secondary">{formatLocationType(type)}</Badge>;
}
