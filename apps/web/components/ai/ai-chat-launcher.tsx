"use client";

import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { useAiAssistant } from "./ai-assistant-root";
import { AiChatIcon } from "./ai-icons";

/** The keyboard shape of the toggle shortcut. */
export interface ShortcutKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing: boolean;
}

/**
 * `⌘J` on macOS, `Ctrl+J` elsewhere — no Shift or Alt, and never in the middle of an IME composition.
 * Handling it (with `preventDefault`) takes precedence over the browser's own Ctrl+J.
 */
export function isAiChatShortcut(event: ShortcutKeyEvent): boolean {
  return (
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey &&
    !event.isComposing &&
    event.key.toLowerCase() === "j"
  );
}

/**
 * The navbar button that opens the AI assistant panel (docs/ai-assistant/frontend.md §5.2), plus its
 * `⌘J`/`Ctrl+J` shortcut. Renders nothing — and binds no shortcut — unless the server said the caller
 * may use the chat, so an instance with AI off, a user without `ai:use`, and an API that predates the
 * assistant all get the unchanged header.
 */
export function AiChatLauncher() {
  const t = useTranslations("ai");
  const { available, open, toggle, launcherRef, panelId } = useAiAssistant();

  useEffect(() => {
    if (!available) return;
    function onKeyDown(event: KeyboardEvent) {
      if (!isAiChatShortcut(event)) return;
      event.preventDefault();
      toggle();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [available, toggle]);

  if (!available) return null;

  return (
    <Button
      ref={launcherRef}
      variant="ghost"
      size="icon"
      aria-label={open ? t("launcher.close") : t("launcher.open")}
      aria-expanded={open}
      aria-controls={open ? panelId : undefined}
      aria-keyshortcuts="Meta+J Control+J"
      onClick={toggle}
    >
      <AiChatIcon className="size-5" />
    </Button>
  );
}
