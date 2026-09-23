import { UsersController } from '../../users/users.controller';
import { unexposed, type AiToolset } from '../core/tool-descriptor';

/**
 * The USERS toolset (W2-9): the directory and the user lifecycle. Pre-created by the AI core unit; its
 * unit fills `tools` and replaces the pending entries with a decision per handler. The coverage test fails
 * on any handler left undecided. `UsersController.me` is bound by `session_context`.
 */
export const usersToolset: AiToolset = {
  domain: 'users',
  tools: [],
  unexposed: [
    unexposed(
      UsersController,
      [
        'findAll',
        'roleCounts',
        'passwordResetCapabilities',
        'findOne',
        'findAssignments',
        'findAccessGrants',
        'create',
        'clone',
        'update',
        'remove',
        'offboard',
        'restore',
        'provisionAccount',
      ],
      'Pending: the users toolset (W2-9) binds or excludes it.',
    ),
    unexposed(
      UsersController,
      ['resetPassword', 'provisionLocalAccount'],
      'Excluded: may return a temporary password in cleartext (ADR-0097 decision 11; structural exclusion).',
    ),
  ],
};
