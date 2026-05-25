import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Active / Inactive pill with a status dot. `isActive` is independent of soft
 * delete: an inactive user is offboarded/disabled but still retained (see the
 * User entity note). Soft-deleted users never reach the list at all.
 */
export function UserStatusBadge({ isActive }: { isActive: boolean }) {
  return (
    <Badge variant={isActive ? "secondary" : "outline"} className="gap-1.5">
      <span
        className={cn(
          "size-1.5 rounded-full",
          isActive ? "bg-emerald-500" : "bg-muted-foreground/40",
        )}
      />
      {isActive ? "Active" : "Inactive"}
    </Badge>
  );
}
