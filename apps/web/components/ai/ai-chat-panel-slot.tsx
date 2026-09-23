"use client";

import { XMarkIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useCallback, useSyncExternalStore, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useAiAssistant } from "./ai-assistant-root";

/** Tailwind's `md` breakpoint (48rem): below it the panel is a modal sheet. */
const MD_UP = "(min-width: 48rem)";

function subscribeToMdUp(onChange: () => void): () => void {
  const query = window.matchMedia(MD_UP);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function useIsMdUp(): boolean {
  return useSyncExternalStore(
    subscribeToMdUp,
    () => window.matchMedia(MD_UP).matches,
    () => false,
  );
}

/**
 * Where the AI assistant panel mounts (docs/ai-assistant/frontend.md Fork A): a NON-modal side panel so
 * the page stays live and clickable beside the conversation — docked in the layout's flex row at `xl`,
 * a fixed overlay with no backdrop from `md` to `xl`, and a modal full-width sheet below `md`.
 *
 * Renders nothing unless the assistant is available AND open. The panel content is a placeholder until
 * the chat itself lands in this slot.
 */
export function AiChatPanelSlot() {
  const t = useTranslations("ai");
  const { available, open, setOpen, launcherRef, panelId } = useAiAssistant();
  const isMdUp = useIsMdUp();

  const close = useCallback(() => {
    setOpen(false);
    launcherRef.current?.focus();
  }, [setOpen, launcherRef]);

  if (!available || !open) return null;

  const body = (
    <div className="flex-1 overflow-y-auto p-4">
      <p className="text-sm text-muted-foreground">{t("panel.placeholder")}</p>
    </div>
  );

  if (!isMdUp) {
    return (
      <Sheet open onOpenChange={(next) => !next && close()}>
        <SheetContent
          id={panelId}
          side="right"
          aria-describedby={undefined}
          className="w-full gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-none"
        >
          <SheetHeader className="border-b border-border">
            <SheetTitle>{t("panel.title")}</SheetTitle>
          </SheetHeader>
          {body}
        </SheetContent>
      </Sheet>
    );
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    close();
  }

  return (
    <aside
      id={panelId}
      aria-label={t("panel.title")}
      onKeyDown={onKeyDown}
      className="fixed inset-y-0 right-0 z-40 flex w-[400px] max-w-full flex-col border-l border-border bg-background shadow-lg xl:sticky xl:top-0 xl:right-auto xl:bottom-auto xl:z-auto xl:h-svh xl:shrink-0 xl:shadow-none"
    >
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
        <h2 className="text-sm font-medium">{t("panel.title")}</h2>
        <Button variant="ghost" size="icon-sm" aria-label={t("panel.close")} onClick={close}>
          <XMarkIcon />
        </Button>
      </div>
      {body}
    </aside>
  );
}
