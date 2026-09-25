import ArrowExpand01Icon from "@hugeicons/core-free-icons/ArrowExpand01Icon";
import ArrowLeft01Icon from "@hugeicons/core-free-icons/ArrowLeft01Icon";
import ArrowShrink01Icon from "@hugeicons/core-free-icons/ArrowShrink01Icon";
import ArrowUp02Icon from "@hugeicons/core-free-icons/ArrowUp02Icon";
import AiMagicIcon from "@hugeicons/core-free-icons/AiMagicIcon";
import BubbleChatAddIcon from "@hugeicons/core-free-icons/BubbleChatAddIcon";
import BubbleChatSparkIcon from "@hugeicons/core-free-icons/BubbleChatSparkIcon";
import Cancel01Icon from "@hugeicons/core-free-icons/Cancel01Icon";
import Clock01Icon from "@hugeicons/core-free-icons/Clock01Icon";
import SlidersHorizontalIcon from "@hugeicons/core-free-icons/SlidersHorizontalIcon";
import StopIcon from "@hugeicons/core-free-icons/StopIcon";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { SVGProps } from "react";

/**
 * The AI assistant's own icon set (ADR-0045 amendment 2026-09-25, #1406). The assistant is the one
 * surface drawn with Hugeicons (the free, MIT-licensed `@hugeicons/core-free-icons` set) so it reads as
 * a distinct, new feature; every other icon in the app stays Heroicons. This module is the ONLY place
 * allowed to import `@hugeicons/*` (an ESLint `no-restricted-imports` guard enforces it), so the scope
 * of the exception is this file's export list.
 *
 * Each icon is imported from its own subpath (never the package barrel), so the bundle carries only the
 * glyphs listed here. Sizing stays in Tailwind classes like the heroicons: the components accept
 * `className` and are decorative (`aria-hidden`) unless a caller passes an accessible name.
 */
type AiIconProps = Omit<SVGProps<SVGSVGElement>, "ref" | "strokeWidth">;

function hugeicon(icon: IconSvgElement, displayName: string) {
  function Icon({ className, ...rest }: AiIconProps) {
    return (
      <HugeiconsIcon
        icon={icon}
        strokeWidth={1.5}
        aria-hidden
        focusable={false}
        className={className}
        {...rest}
      />
    );
  }
  Icon.displayName = displayName;
  return Icon;
}

/** The assistant's mark: the Settings hub card, the setup wizard / editor header, "Turn on". */
export const AiAssistantIcon = hugeicon(AiMagicIcon, "AiAssistantIcon");
/** The navbar launcher and the chat panel title. */
export const AiChatIcon = hugeicon(BubbleChatSparkIcon, "AiChatIcon");
/** Chat header actions. */
export const AiNewChatIcon = hugeicon(BubbleChatAddIcon, "AiNewChatIcon");
export const AiHistoryIcon = hugeicon(Clock01Icon, "AiHistoryIcon");
export const AiBackIcon = hugeicon(ArrowLeft01Icon, "AiBackIcon");
export const AiExpandIcon = hugeicon(ArrowExpand01Icon, "AiExpandIcon");
export const AiRestoreIcon = hugeicon(ArrowShrink01Icon, "AiRestoreIcon");
export const AiCloseIcon = hugeicon(Cancel01Icon, "AiCloseIcon");
/** Composer actions. */
export const AiSendIcon = hugeicon(ArrowUp02Icon, "AiSendIcon");
export const AiStopIcon = hugeicon(StopIcon, "AiStopIcon");
export const AiChatSettingsIcon = hugeicon(SlidersHorizontalIcon, "AiChatSettingsIcon");
