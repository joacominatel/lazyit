"use client";

import { XMarkIcon } from "@heroicons/react/24/outline";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import type { SlashCommand } from "@/lib/ai/slash-commands";

const SHORTCUTS = ["toggle", "send", "slash", "close"] as const;

/**
 * `/help` (issue #1372): the slash commands and the keyboard shortcuts, shown in the chat log. Local to
 * the browser — nothing is sent to the model — and dismissed with its close button.
 */
export function AiChatHelp<C>({
  commands,
  onClose,
}: {
  commands: readonly SlashCommand<C>[];
  onClose: () => void;
}) {
  const t = useTranslations("ai.commands");

  return (
    <section
      aria-labelledby="ai-chat-help-title"
      className="rounded-md border border-border bg-card px-3 py-2 text-xs text-card-foreground"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 id="ai-chat-help-title" className="text-sm font-medium">
          {t("helpTitle")}
        </h3>
        <Button type="button" variant="ghost" size="icon-xs" aria-label={t("helpClose")} onClick={onClose}>
          <XMarkIcon />
        </Button>
      </div>
      <dl className="mt-2 space-y-1">
        {commands.map((command) => (
          <div key={command.name} className="grid grid-cols-[minmax(0,1fr)_minmax(0,3fr)] gap-2">
            <dt className="font-mono text-muted-foreground">
              /{command.name}
              {command.argument && <span className="opacity-70"> {command.argument.hint}</span>}
            </dt>
            <dd>
              <span className="font-medium">{t(`${command.name}.label`)}</span>
              <span className="text-muted-foreground"> — {t(`${command.name}.description`)}</span>
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 font-medium">{t("helpShortcutsTitle")}</p>
      <ul className="mt-1 space-y-0.5 text-muted-foreground">
        {SHORTCUTS.map((key) => (
          <li key={key}>{t(`shortcuts.${key}`)}</li>
        ))}
      </ul>
      <Link
        href="/help/ai-assistant-using-the-chat"
        prefetch={false}
        className="mt-2 inline-block font-medium text-primary underline-offset-2 hover:underline"
      >
        {t("helpManual")}
      </Link>
    </section>
  );
}
