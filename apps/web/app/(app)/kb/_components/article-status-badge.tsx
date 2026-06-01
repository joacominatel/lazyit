import type { ArticleStatus } from "@lazyit/shared";
import { Badge } from "@/components/ui/badge";
import { StatusDot } from "@/components/ui/status-badge";
import { cn } from "@/lib/utils";

/**
 * Draft / Published indicator for an Article. DRAFT is highlighted (warning) since
 * it is author-private and the actionable state; PUBLISHED is subdued (success).
 * The color cue is a token-driven {@link StatusDot} inside a neutral pill.
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
      <StatusDot tone={isDraft ? "warning" : "success"} />
      {isDraft ? "Draft" : "Published"}
    </Badge>
  );
}
