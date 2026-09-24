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
import { McpController } from '../../mcp/mcp.controller';
import { MetadataController } from '../../oauth/metadata.controller';
import { PersonalTokensController } from '../../oauth/personal-tokens/personal-tokens.controller';
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
import { WorkflowSecretsController } from '../../workflow-engine/definitions/workflow-secrets.controller';
import { PluginDistributionController } from '../../mcp/distribution/plugin-distribution.controller';
import { AiConversationsController } from '../conversations/ai-conversations.controller';
import { AiModelsController } from '../conversations/ai-models.controller';
import { unexposed, type AiToolset } from '../core/tool-descriptor';
import { AiServiceAccountAccessController } from '../headless/ai-service-account-access.controller';
import { AiRunsController } from '../runs/ai-runs.controller';
import { AiSettingsController } from '../settings/ai-settings.controller';
import { AiStatusController } from '../status/ai-status.controller';

const SECRET_MANAGER =
  'Excluded: the Secret Manager is zero-knowledge (ADR-0061, INV-10; structural exclusion).';
const OAUTH_SERVER =
  'Excluded: the OAuth authorization server mints and verifies credentials (INV-AI-5; structural exclusion).';
const AI_OWN_SURFACE =
  "Excluded: the AI's own configuration and status are never tools (INV-AI-14; structural exclusion of /config/ai and /ai).";
const INSTANCE_CONFIG =
  'Deferred: instance configuration is elevated and comes later; secret-bearing fields are never tool inputs (tools-and-execution.md §3, INV-AI-5).';

/**
 * The PLATFORM surfaces no domain toolset owns: authentication, instance configuration, the Secret
 * Manager, Service Account management, the Migrator, workflow secrets and the probes. Nothing here is a
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
    unexposed(
      AiSettingsController,
      ['get', 'update', 'test', 'models'],
      AI_OWN_SURFACE,
    ),
    unexposed(AiStatusController, ['get'], AI_OWN_SURFACE),
    unexposed(
      AiConversationsController,
      ['create', 'list', 'detail', 'remove', 'send', 'update'],
      AI_OWN_SURFACE,
    ),
    unexposed(AiModelsController, ['get'], AI_OWN_SURFACE),
    unexposed(
      AiRunsController,
      ['create', 'get', 'cancel', 'decide', 'stream'],
      AI_OWN_SURFACE,
    ),
    unexposed(
      AiServiceAccountAccessController,
      ['get', 'update'],
      AI_OWN_SURFACE,
    ),
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
    // The rest of the workflow engine lives in `workflows.tools.ts` (W2-13) and
    // `workflow-authoring.tools.ts` (W2-14); its secrets stay here, a structural exclusion.
    // `WorkflowsController.findAll` (headers only) is bound by the access toolset (W2-6) for the grant,
    // revoke and approve previews, and by the workflow operations toolset (W2-13).
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
    // Personal MCP tokens (W3-4) mint a credential; `/mcp` itself (W3-2) is the channel tools are served
    // through, never a tool (ADR-0097 decision 9; INV-AI-5, INV-AI-14).
    unexposed(
      PersonalTokensController,
      ['create', 'list', 'revoke'],
      'Excluded: personal MCP tokens are credentials that govern the access of external agents (INV-AI-5; structural exclusion).',
    ),
    unexposed(
      McpController,
      ['handle'],
      'Not applicable: /mcp is the channel the tools are served through, not a tool.',
    ),
    // The Claude Code plugin distribution (W3-5): a file download for installing a client, not data.
    unexposed(
      PluginDistributionController,
      ['download', 'marketplace', 'publicArchive'],
      "Excluded: the Claude Code plugin download and marketplace distribute the AI's own client configuration (structural exclusion, INV-AI-14).",
    ),
  ],
};
