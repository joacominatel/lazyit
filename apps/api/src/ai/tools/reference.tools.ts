import { ApplicationCategoriesController } from '../../application-categories/application-categories.controller';
import { ArticleCategoriesController } from '../../article-categories/article-categories.controller';
import { AssetCategoriesController } from '../../asset-categories/asset-categories.controller';
import { AssetModelsController } from '../../asset-models/asset-models.controller';
import { ConsumableCategoriesController } from '../../consumable-categories/consumable-categories.controller';
import { LocationsController } from '../../locations/locations.controller';
import { unexposed, type AiToolset } from '../core/tool-descriptor';

const PENDING = 'Pending: the reference toolset (W2-5) binds or excludes it.';
const CRUD = [
  'findAll',
  'findOne',
  'create',
  'update',
  'remove',
  'restore',
] as const;

/**
 * The REFERENCE toolset (W2-5): the taxonomy and places assets hang off — models, categories, KB folders
 * and locations (`reference_lookup`, `asset_model_create`, `location_create`). Pre-created by the AI core
 * unit; its unit fills `tools` and replaces the pending entries with a decision per handler. The coverage
 * test fails on any handler left undecided.
 */
export const referenceToolset: AiToolset = {
  domain: 'reference',
  tools: [],
  unexposed: [
    unexposed(AssetModelsController, CRUD, PENDING),
    unexposed(AssetCategoriesController, CRUD, PENDING),
    unexposed(ApplicationCategoriesController, CRUD, PENDING),
    unexposed(ConsumableCategoriesController, CRUD, PENDING),
    unexposed(ArticleCategoriesController, CRUD, PENDING),
    unexposed(
      ArticleCategoriesController,
      ['setAccessRules'],
      'Folder access rules: elevated authorization configuration, after v1 (tools-and-execution.md §3).',
    ),
    unexposed(LocationsController, CRUD, PENDING),
  ],
};
