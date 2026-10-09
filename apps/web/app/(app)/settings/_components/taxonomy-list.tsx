"use client";

import { ArrowPathIcon, PlusIcon } from "@heroicons/react/24/outline";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { type ReactNode, useId, useState } from "react";
import { HelpTip } from "@/components/help-tip";
import { SearchInput } from "@/components/search-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { type UsageNoun, usageLabel } from "./taxonomy-usage";

/**
 * The compact-row frame every taxonomy pane shares (#1540; ledger-design-language §4c): a pane header
 * (title, "?" tip, filter box, actions), a hairline-ruled list of rows — name, the description muted
 * only when there is one, the "In use" count, a ⋯ menu — and an optional inline create row at the
 * bottom. Dialogs stay with each manager; this file is presentation only.
 */

export function TaxonomyPaneHeader({
  title,
  help,
  filter,
  onFilterChange,
  actions,
}: {
  title: string;
  help?: ReactNode;
  filter: string;
  onFilterChange: (next: string) => void;
  actions?: ReactNode;
}) {
  const t = useTranslations("settings.taxonomies");
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div className="flex min-w-0 flex-1 items-center gap-0.5">
        <h2 className="text-base font-semibold">{title}</h2>
        {help ? <HelpTip topic={title}>{help}</HelpTip> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      <SearchInput
        value={filter}
        onChange={onFilterChange}
        label={t("filterLabel", { taxonomy: title })}
        placeholder={t("filterPlaceholder")}
        className="w-full sm:w-56"
      />
    </div>
  );
}

/** The list surface. Rows are `<li>`s ({@link TaxonomyRow}, {@link TaxonomyGroupRow}, …). */
export function TaxonomyList({
  label,
  children,
  footer,
}: {
  label: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-xl bg-card text-card-foreground ring-1 ring-foreground/10">
      <ul aria-label={label} className="divide-y">
        {children}
      </ul>
      {footer ? <div className="border-t">{footer}</div> : null}
    </div>
  );
}

/** One compact row. `leading` holds a selection checkbox or a swatch; `actions` the ⋯ menu. */
export function TaxonomyRow({
  leading,
  name,
  description,
  usage,
  actions,
  selected,
  className,
}: {
  leading?: ReactNode;
  name: ReactNode;
  /** Shown muted after the name — omitted entirely when empty. */
  description?: string | null;
  usage?: ReactNode;
  actions?: ReactNode;
  selected?: boolean;
  className?: string;
}) {
  return (
    <li
      data-state={selected ? "selected" : undefined}
      className={cn(
        "flex min-h-11 items-center gap-3 px-4 py-2 data-[state=selected]:bg-muted/60",
        className,
      )}
    >
      {leading}
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-medium">{name}</span>
        {description ? (
          <span className="min-w-0 truncate text-xs text-muted-foreground" title={description}>
            {description}
          </span>
        ) : null}
      </div>
      {usage ? <div className="shrink-0">{usage}</div> : null}
      <div className="flex size-7 shrink-0 items-center justify-center">{actions}</div>
    </li>
  );
}

/** A non-interactive heading row inside a list (e.g. a built-in status). */
export function TaxonomyGroupRow({ children }: { children: ReactNode }) {
  return (
    <li className="flex min-h-10 items-center gap-3 bg-muted/40 px-4 py-1.5">{children}</li>
  );
}

/**
 * The "In use" count: "42 assets", "Unused", or nothing when the API sent no count. With `href`, a
 * non-zero count links to the filtered list.
 */
export function UsageText({
  noun,
  count,
  href,
  linkLabel,
}: {
  noun: UsageNoun;
  count: number | null | undefined;
  href?: string;
  linkLabel?: string;
}) {
  const t = useTranslations("settings.taxonomies.usage");
  const label = usageLabel(noun, count);
  if (!label) return null;
  const text = t(label.key, { count: label.count });
  const className = cn(
    "font-mono text-xs tabular-nums",
    label.key === "unused" ? "text-muted-foreground/80" : "text-muted-foreground",
  );
  if (href && label.key !== "unused") {
    return (
      <Link
        href={href}
        aria-label={linkLabel}
        className={cn(className, "underline-offset-4 hover:text-foreground hover:underline")}
      >
        {text}
      </Link>
    );
  }
  return <span className={className}>{text}</span>;
}

/**
 * The inline "New …" row at the foot of a list: a name, Enter or Add, done. Resolves `onCreate` and
 * clears on success; the caller owns the toast. The full dialog stays for richer edits.
 */
export function InlineCreateRow({
  placeholder,
  label,
  onCreate,
}: {
  placeholder: string;
  /** The input's accessible name. */
  label: string;
  onCreate: (name: string) => Promise<unknown>;
}) {
  const t = useTranslations("settings.taxonomies");
  const id = useId();
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length === 0 || pending) return;
    setPending(true);
    try {
      await onCreate(trimmed);
      setName("");
    } catch {
      // The caller reported the error; keep the typed name so it can be fixed.
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex items-center gap-2 px-4 py-2.5">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <Input
        id={id}
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder={placeholder}
        maxLength={100}
        autoComplete="off"
        className="h-8 min-w-0 flex-1"
      />
      <Button type="submit" variant="outline" size="sm" disabled={pending || name.trim() === ""}>
        {pending ? <ArrowPathIcon className="animate-spin" /> : <PlusIcon />}
        {t("inlineAdd")}
      </Button>
    </form>
  );
}

/** A loading list: a few row-height bars. */
export function TaxonomyListSkeleton() {
  return (
    <div className="space-y-px overflow-hidden rounded-xl ring-1 ring-foreground/10">
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="flex items-center gap-3 bg-card px-4 py-3">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="ml-auto h-4 w-16" />
        </div>
      ))}
    </div>
  );
}

/** One muted line inside the list, e.g. "No matches" or an empty state. */
export function TaxonomyNote({ children }: { children: ReactNode }) {
  return <li className="px-4 py-3 text-sm text-muted-foreground">{children}</li>;
}
