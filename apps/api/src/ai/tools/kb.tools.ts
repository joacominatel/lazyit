import { ArticlesController } from '../../articles/articles.controller';
import { ArticleAttachmentsController } from '../../attachments/article-attachments.controller';
import { unexposed, type AiToolset } from '../core/tool-descriptor';

const PENDING =
  'Pending: the knowledge-base toolset (W2-8) binds or excludes it.';

/**
 * The KNOWLEDGE BASE toolset (W2-8): articles, their versions, links and publication. Pre-created by the
 * AI core unit; its unit fills `tools` and replaces the pending entries with a decision per handler. The
 * coverage test fails on any handler left undecided.
 */
export const kbToolset: AiToolset = {
  domain: 'kb',
  tools: [],
  unexposed: [
    unexposed(
      ArticlesController,
      [
        'findAll',
        'findBySlug',
        'findOne',
        'findVersions',
        'findVersion',
        'restoreVersion',
        'findLinks',
        'backlinks',
        'findAliases',
        'create',
        'update',
        'addLink',
        'removeLink',
        'addAlias',
        'removeAlias',
        'publish',
        'unpublish',
        'remove',
        'restore',
      ],
      PENDING,
    ),
    unexposed(
      ArticlesController,
      ['importArticle', 'importStatus'],
      'The .docx import: a multipart upload and its job status — no file tools (synthesis §9.2).',
    ),
    unexposed(ArticleAttachmentsController, ['list', 'remove'], PENDING),
    unexposed(
      ArticleAttachmentsController,
      ['upload', 'content'],
      'Binary upload and download: no file tools (synthesis §9.2).',
    ),
  ],
};
