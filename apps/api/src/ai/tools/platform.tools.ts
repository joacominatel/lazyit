import { AppController } from '../../app.controller';
import { AssetTagSchemeController } from '../../asset-tag-scheme/asset-tag-scheme.controller';
import { LocalAuthController } from '../../auth/local/local-auth.controller';
import { PasswordLifecycleController } from '../../auth/local/password-lifecycle.controller';
import { DirectoryController } from '../../directory/directory.controller';
import { HealthController } from '../../health/health.controller';
import { ImportController } from '../../import/import.controller';
import { UpdateController } from '../../instance/update.controller';
import { AuthorizeController } from '../../oauth/authorize.controller';
import { GrantsController } from '../../oauth/grants.controller';
import { MetadataController } from '../../oauth/metadata.controller';
import { RegisterController } from '../../oauth/register.controller';
import { RevokeController } from '../../oauth/revoke.controller';
import { TokenController } from '../../oauth/token.controller';
import { ItemsController } from '../../secret-manager/items.controller';
import { KeypairController } from '../../secret-manager/keypair.controller';
import { SecretFetchController } from '../../secret-manager/secret-fetch.controller';
import { ServiceAccountKeypairController } from '../../secret-manager/service-account-keypair.controller';
import { VaultsController } from '../../secret-manager/vaults.controller';
import { ServiceAccountsController } from '../../service-accounts/service-accounts.controller';
import { NotificationPreferencesController } from '../../smtp/notification-preferences.controller';
import { SmtpController } from '../../smtp/smtp.controller';
import { WorkflowConnectionsController } from '../../workflow-engine/definitions/workflow-connections.controller';
import { WorkflowSecretsController } from '../../workflow-engine/definitions/workflow-secrets.controller';
import { WorkflowsController } from '../../workflow-engine/definitions/workflows.controller';
import { WorkflowDryRunController } from '../../workflow-engine/dry-run/workflow-dry-run.controller';
import { WorkflowRunsController } from '../../workflow-engine/runs/workflow-runs.controller';
import { ManualTasksController } from '../../workflow-engine/tasks/manual-tasks.controller';
import { unexposed, type AiToolset } from '../core/tool-descriptor';

const SECRET_MANAGER =
  'Excluded: the Secret Manager is zero-knowledge (ADR-0061, INV-10; structural exclusion).';
const OAUTH_SERVER =
  'Excluded: the OAuth authorization server mints and verifies credentials (INV-AI-5; structural exclusion).';
const INSTANCE_CONFIG =
  'Deferred: instance configuration is elevated and comes later; secret-bearing fields are never tool inputs (tools-and-execution.md §3, INV-AI-5).';

/**
 * The PLATFORM surfaces no domain toolset owns: authentication, instance configuration, the Secret
 * Manager, Service Account management, the Migrator, the workflow engine and the probes. Nothing here is a
 * tool in v1; each handler carries the reason. Owned by the AI core unit; a later unit that brings one of
 * these surfaces into the catalog moves its handlers into its own toolset.
 */
export const platformToolset: AiToolset = {
  domain: 'platform',
  tools: [],
  unexposed: [
    unexposed(
      AppController,
      ['getHello'],
      'Not applicable: a liveness greeting.',
    ),
    unexposed(
      HealthController,
      ['live', 'ready'],
      'Not applicable: public health probes.',
    ),
    unexposed(
      LocalAuthController,
      ['login', 'logout'],
      'Excluded: authentication — login answers a session token (structural exclusion).',
    ),
    unexposed(
      PasswordLifecycleController,
      ['changePassword', 'forgotPassword', 'resetPassword'],
      'Excluded: credentials (structural exclusion).',
    ),
    unexposed(
      KeypairController,
      ['getMine', 'create', 'reset', 'changePassword', 'publicKey'],
      SECRET_MANAGER,
    ),
    unexposed(
      VaultsController,
      [
        'list',
        'create',
        'getOne',
        'rename',
        'remove',
        'listItems',
        'createItem',
        'updateItem',
        'removeItem',
        'recordExport',
        'recordReveal',
        'listMembers',
        'myMembership',
        'grant',
        'revoke',
        'listServiceAccountMembers',
        'grantServiceAccount',
        'revokeServiceAccount',
      ],
      SECRET_MANAGER,
    ),
    unexposed(ItemsController, ['handles', 'byHandle'], SECRET_MANAGER),
    unexposed(
      ServiceAccountKeypairController,
      ['setKeypair', 'publicKey'],
      SECRET_MANAGER,
    ),
    unexposed(SecretFetchController, ['list', 'fetch'], SECRET_MANAGER),
    unexposed(
      ServiceAccountsController,
      ['create', 'rotate'],
      'Excluded: answers the Service Account token in cleartext (ADR-0097 decision 11; structural exclusion).',
    ),
    unexposed(
      ServiceAccountsController,
      ['findAll', 'findOne', 'update', 'remove', 'restore'],
      'Deferred: Service Account management is elevated with a password step-up, v1.1 (tools-and-execution.md §3).',
    ),
    unexposed(SmtpController, ['get', 'update', 'test'], INSTANCE_CONFIG),
    unexposed(DirectoryController, ['get', 'update', 'sync'], INSTANCE_CONFIG),
    unexposed(
      AssetTagSchemeController,
      [
        'get',
        'update',
        'seedSuggestion',
        'previewNextTag',
        'backfillPreview',
        'backfillApply',
      ],
      INSTANCE_CONFIG,
    ),
    unexposed(
      UpdateController,
      ['getStatus', 'getSettings', 'updateSettings', 'enqueue', 'cancel'],
      'Deferred: instance update status is v1.1; update settings and triggering an update are elevated configuration, later.',
    ),
    unexposed(
      NotificationPreferencesController,
      ['get', 'update'],
      'Deferred: notification preferences are v1.1 (tools-and-execution.md §3).',
    ),
    unexposed(
      ImportController,
      [
        'upload',
        'status',
        'setMapping',
        'runDryRun',
        'savePlan',
        'commit',
        'result',
      ],
      'Excluded in v1: the Migrator is a multi-step file upload (tools-and-execution.md §3).',
    ),
    unexposed(
      WorkflowRunsController,
      ['findAll', 'findOne', 'retry', 'replayLatest'],
      'Deferred: workflow runs are v1.1 (tools-and-execution.md §3).',
    ),
    unexposed(
      ManualTasksController,
      ['findAll', 'findOne', 'submit', 'skip', 'fail'],
      'Deferred: workflow manual tasks are v1.1 (tools-and-execution.md §3).',
    ),
    unexposed(
      WorkflowsController,
      ['findAll', 'findOne', 'create', 'update', 'remove', 'authorVersion'],
      'Deferred: workflow authoring is elevated and needs its own design, later (tools-and-execution.md §3).',
    ),
    unexposed(
      WorkflowConnectionsController,
      ['findAll', 'findOne', 'create', 'update', 'test', 'remove'],
      'Deferred: workflow connections are elevated configuration with egress, later (tools-and-execution.md §3).',
    ),
    unexposed(
      WorkflowDryRunController,
      ['run'],
      'Deferred: the workflow dry-run is part of authoring, later (tools-and-execution.md §3).',
    ),
    unexposed(
      WorkflowSecretsController,
      ['findAll', 'findOne', 'create', 'rotate', 'remove'],
      'Excluded: a workflow secret value would enter model context (INV-AI-5; structural exclusion).',
    ),
    // The OAuth authorization server for MCP (W2-4): protocol endpoints for external clients and the
    // consent/connected-apps surface. None of it is ever a tool — it mints credentials and governs the
    // AI's own access (ADR-0097 decision 3; INV-AI-5, INV-AI-14).
    unexposed(
      MetadataController,
      ['authorizationServer', 'protectedResource'],
      OAUTH_SERVER,
    ),
    unexposed(TokenController, ['token'], OAUTH_SERVER),
    unexposed(RegisterController, ['register'], OAUTH_SERVER),
    unexposed(RevokeController, ['revoke'], OAUTH_SERVER),
    unexposed(AuthorizeController, ['validate', 'decision'], OAUTH_SERVER),
    unexposed(
      GrantsController,
      ['listMine', 'list', 'revoke'],
      'Excluded: connected apps govern the access of external agents, i.e. the AI configuration (structural exclusion).',
    ),
  ],
};
