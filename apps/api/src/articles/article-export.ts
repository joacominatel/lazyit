import type { ArticleStatus } from '@lazyit/shared';
import {
  folderVisible,
  type VisibleFolders,
} from '../article-categories/folder-access.service';
import type { ExportColumn } from '../common/export';

/** A lean list row plus its resolved folder cell; the body never reaches it (ARTICLE_LIST_SELECT). */
export interface ArticleExportRow {
  id: string;
  title: string;
  slug: string;
  status: ArticleStatus;
  categoryId: string;
  author: {
    firstName: string;
    lastName: string;
    deletedAt: Date | null;
  } | null;
  linkCount: number;
  readingMinutes: number;
  createdAt: Date;
  updatedAt: Date;
  publishedAt: Date | null;
  folder: string;
}

interface NamedFolder {
  id: string;
  parentId: string | null;
  name: string;
}

/** "Parent / Child" up from `folderId`, stopping at the first folder the caller cannot read or that is gone. */
export function visibleFolderPath(
  folderId: string,
  byId: ReadonlyMap<string, NamedFolder>,
  visible: VisibleFolders,
): string {
  const names: string[] = [];
  const seen = new Set<string>();
  let folder = byId.get(folderId);
  while (folder && folderVisible(visible, folder.id) && !seen.has(folder.id)) {
    seen.add(folder.id);
    names.unshift(folder.name);
    folder = folder.parentId ? byId.get(folder.parentId) : undefined;
  }
  return names.join(' / ');
}

function authorName(author: ArticleExportRow['author']): string | null {
  if (!author) return null;
  const name = `${author.firstName} ${author.lastName}`.trim();
  return author.deletedAt ? `${name} (former member)` : name;
}

/** `GET /articles/export` columns: index metadata only, never the body, the excerpt or a version (ADR-0103 §2). */
export const ARTICLE_EXPORT_COLUMNS: readonly ExportColumn<ArticleExportRow>[] =
  [
    { header: 'ID', kind: 'text', value: (a) => a.id },
    { header: 'Title', kind: 'text', value: (a) => a.title },
    { header: 'Slug', kind: 'text', value: (a) => a.slug },
    { header: 'Status', kind: 'text', value: (a) => a.status },
    { header: 'Folder', kind: 'text', value: (a) => a.folder },
    { header: 'Author', kind: 'text', value: (a) => authorName(a.author) },
    { header: 'Links', kind: 'number', value: (a) => a.linkCount },
    {
      header: 'Reading minutes',
      kind: 'number',
      value: (a) => a.readingMinutes,
    },
    { header: 'Created', kind: 'date', value: (a) => a.createdAt },
    { header: 'Updated', kind: 'date', value: (a) => a.updatedAt },
    { header: 'Published', kind: 'date', value: (a) => a.publishedAt },
  ];
