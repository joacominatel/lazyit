"use client";

import { CheckIcon, ClipboardIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { copyText } from "../_lib/copy-text";

/**
 * A command or configuration block with a copy button. The text is `select-all`, so a single click
 * selects it when the clipboard is unavailable (plain HTTP). Never holds a real token: snippets carry a
 * placeholder, and the one-time token reveal has its own component.
 */
export function CodeSnippet({
  code,
  label,
  className,
  copyable = true,
}: {
  code: string;
  /**
   * False when the snippet may not be right for the reader (the instance's configured address could
   * not be confirmed): it renders without a copy button, as text to review, never as copy-ready.
   */
  copyable?: boolean;
  /** What is being copied, for the button's accessible name ("Copy the Claude Code command"). */
  label: string;
  className?: string;
}) {
  const t = useTranslations("oauth");
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  async function onCopy() {
    if (await copyText(code)) {
      setCopied(true);
      toast.success(t("copy.copied"));
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } else {
      toast.error(t("copy.unavailable"));
    }
  }

  return (
    <div
      className={cn(
        "group relative rounded-md border bg-muted/50",
        !copyable && "border-dashed opacity-80",
        className,
      )}
    >
      <pre className="overflow-x-auto p-3 pr-12 font-mono text-xs leading-relaxed whitespace-pre select-all">
        <code>{code}</code>
      </pre>
      {copyable ? (
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={onCopy}
        aria-label={copied ? t("copy.copiedLabel", { label }) : label}
        title={label}
        className="absolute top-2 right-2 text-muted-foreground"
      >
        {copied ? (
          <CheckIcon className="text-success" aria-hidden />
        ) : (
          <ClipboardIcon aria-hidden />
        )}
      </Button>
      ) : null}
    </div>
  );
}
