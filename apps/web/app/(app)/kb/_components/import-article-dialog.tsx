"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { ArticleStatusSchema, type ArticleStatus } from "@lazyit/shared";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useArticleCategories } from "@/lib/api/hooks/use-article-categories";
import { useImportArticle } from "@/lib/api/hooks/use-article-mutations";
import { useCan } from "@/lib/hooks/use-permissions";
import { notifyError } from "@/lib/api/notify-error";

/** Accepted upload types — the backend extracts markdown from each (ADR-0021). */
const ACCEPT = ".md,.markdown,.txt,.docx";

interface ImportArticleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Import an article from a `.md` / `.txt` / `.docx` file. The file plus a target
 * category and status are sent as multipart; the API extracts markdown and
 * attributes authorship via the Bearer token (ADR-0038/0039). On success, jumps
 * to the new article.
 */
export function ImportArticleDialog({
  open,
  onOpenChange,
}: ImportArticleDialogProps) {
  const router = useRouter();
  const { data: categories } = useArticleCategories();
  const { data: session } = useSession();
  const canWrite = useCan("article:write");
  const importArticle = useImportArticle();

  const [file, setFile] = useState<File | null>(null);
  const [categoryId, setCategoryId] = useState("");
  const [status, setStatus] = useState<ArticleStatus>("DRAFT");

  // Reset on close (not in an effect) so a reopened dialog starts clean.
  function handleOpenChange(next: boolean) {
    if (!next) {
      setFile(null);
      setCategoryId("");
      setStatus("DRAFT");
    }
    onOpenChange(next);
  }

  function handleImport() {
    if (!session) {
      toast.error("You must be signed in to import articles");
      return;
    }
    if (!file) {
      toast.error("Choose a file to import");
      return;
    }
    if (!categoryId) {
      toast.error("Choose a category");
      return;
    }
    importArticle.mutate(
      { file, fields: { categoryId, status } },
      {
        onSuccess: (article) => {
          toast.success("Article imported");
          handleOpenChange(false);
          router.push(`/kb/${article.slug}`);
        },
        onError: (error) =>
          notifyError(error, "Couldn't import the file"),
      },
    );
  }

  const hasCategories = (categories?.length ?? 0) > 0;

  // RBAC v2: importing creates an article, so gate on article:write (ADR-0046). Render nothing
  // without it so the dialog never opens; the API still enforces authorship/permission (fails closed).
  if (!canWrite) return null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Import an article</DialogTitle>
          <DialogDescription>
            Upload a Markdown, plain-text or Word (.docx) file. Only the text is
            imported — the original file is not stored.
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="import-file">File</FieldLabel>
            <Input
              id="import-file"
              type="file"
              accept={ACCEPT}
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
            <FieldDescription>Accepts .md, .txt and .docx.</FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="import-category">Category</FieldLabel>
            <Select value={categoryId} onValueChange={setCategoryId}>
              <SelectTrigger id="import-category" className="w-full">
                <SelectValue
                  placeholder={
                    hasCategories ? "Select a category" : "No categories yet"
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {(categories ?? []).map((category) => (
                  <SelectItem key={category.id} value={category.id}>
                    {category.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field>
            <FieldLabel htmlFor="import-status">Status</FieldLabel>
            <Select
              value={status}
              onValueChange={(value) => setStatus(value as ArticleStatus)}
            >
              <SelectTrigger id="import-status" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ArticleStatusSchema.options.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option === "DRAFT" ? "Draft" : "Published"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </FieldGroup>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={importArticle.isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleImport}
            disabled={importArticle.isPending || !session}
          >
            {importArticle.isPending && (
              <ArrowPathIcon className="animate-spin" />
            )}
            Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
