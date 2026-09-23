import { AssetAssignmentsController } from '../../asset-assignments/asset-assignments.controller';
import { AssetsController } from '../../assets/assets.controller';
import { AssetAttachmentsController } from '../../attachments/asset-attachments.controller';
import { unexposed, type AiToolset } from '../core/tool-descriptor';

const PENDING = 'Pending: the assets toolset (W2-5) binds or excludes it.';

/**
 * The ASSETS toolset (W2-5): assets and their check-out / check-in. Pre-created by the AI core unit; its
 * unit fills `tools` and replaces the pending entries with a decision per handler. The coverage test fails
 * on any handler left undecided. `AssetsController.findMine` is bound by `session_context`.
 */
export const assetsToolset: AiToolset = {
  domain: 'assets',
  tools: [],
  unexposed: [
    unexposed(
      AssetsController,
      [
        'findAll',
        'listCompanies',
        'findOne',
        'findAssignments',
        'findHistory',
        'findArticles',
        'create',
        'batchRemove',
        'batchRestore',
        'batchSetStatus',
        'receiveBatch',
        'update',
        'remove',
        'restore',
      ],
      PENDING,
    ),
    unexposed(
      AssetsController,
      ['export'],
      'A bulk CSV file export (@Res stream); use search and list tools instead.',
    ),
    unexposed(
      AssetAssignmentsController,
      ['findAll', 'findOne', 'create', 'release', 'updateNotes', 'acknowledge'],
      PENDING,
    ),
    unexposed(AssetAttachmentsController, ['list', 'remove'], PENDING),
    unexposed(
      AssetAttachmentsController,
      ['upload', 'content'],
      'Binary upload and download: no file tools (synthesis §9.2).',
    ),
  ],
};
