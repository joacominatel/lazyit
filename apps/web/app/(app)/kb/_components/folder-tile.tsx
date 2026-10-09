import { FolderIcon } from "@heroicons/react/24/outline";
import { cn } from "@/lib/utils";
import { folderTileClass } from "@/lib/utils/kb-folder-color";

const SIZE = {
  xs: "size-5 rounded-[5px] [&>svg]:size-3",
  sm: "size-7 rounded-md [&>svg]:size-4",
  md: "size-9 rounded-lg [&>svg]:size-5",
  lg: "size-11 rounded-lg [&>svg]:size-6",
} as const;

/**
 * The folder's colour tile (#1539): a tinted square holding a folder glyph, its hue derived from the
 * folder id (`folderTileClass`) so a folder looks the same in the rail, on its card and in its header.
 * Decorative — the folder name always sits beside it.
 */
export function FolderTile({
  folderId,
  size = "xs",
  className,
}: {
  folderId: string;
  size?: keyof typeof SIZE;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center",
        folderTileClass(folderId),
        SIZE[size],
        className,
      )}
    >
      <FolderIcon />
    </span>
  );
}
