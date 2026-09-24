import { AccessGrantsController } from '../../access-grants/access-grants.controller';
import { AccessRequestsController } from '../../access-requests/access-requests.controller';
import { ApplicationsController } from '../../applications/applications.controller';
import { unexposed, type AiToolset } from '../core/tool-descriptor';

const PENDING = 'Pending: the access toolset (W2-6) binds or excludes it.';

/**
 * The ACCESS toolset (W2-6): applications, access grants and access requests. Pre-created by the AI core
 * unit; its unit fills `tools` and replaces the pending entries with a decision per handler. The coverage
 * test fails on any handler left undecided. `AccessGrantsController.findMine` is bound by
 * `session_context`.
 */
export const accessToolset: AiToolset = {
  domain: 'access',
  tools: [],
  unexposed: [
    unexposed(
      ApplicationsController,
      [
        // `findAll` and `findOne` are bound by the workflow operations toolset (W2-13) for application
        // names and criticality; W2-6 binds them too (several tools may bind one handler).
        'findGrants',
        'findArticles',
        'create',
        'update',
        'remove',
        'restore',
      ],
      PENDING,
    ),
    unexposed(
      AccessGrantsController,
      [
        'findAll',
        'batchRevoke',
        // `findOne` is bound by the workflow operations toolset (W2-13): whose grant a run is about.
        'create',
        'revoke',
        'updateNotes',
        'updateExpiry',
      ],
      PENDING,
    ),
    unexposed(
      AccessRequestsController,
      ['create', 'findAll', 'findMine', 'approve', 'deny'],
      PENDING,
    ),
  ],
};
