import type { ArticleStatus } from "@lazyit/shared";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Draft / Published indicator for an Article. DRAFT is highlighted (amber) since
 * it is author-private and the actionable state; PUBLISHED is subdued.
 */
export function ArticleStatusBadge({
  status,
  className,
}: {
  status: ArticleStatus;
  className?: string;
}) {
  const isDraft = status === "DRAFT";
  return (
    <Badge
      variant={isDraft ? "outline" : "secondary"}
      className={cn("gap-1.5", className)}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          isDraft ? "bg-amber-500" : "bg-emerald-500",
        )}
      />
      {isDraft ? "Draft" : "Published"}
    </Badge>
  );
}
