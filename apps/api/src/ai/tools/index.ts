import type { AiToolset } from '../core/tool-descriptor';
import { accessToolset } from './access.tools';
import { activityToolset } from './activity.tools';
import { assetsToolset } from './assets.tools';
import { consumablesToolset } from './consumables.tools';
import { contextToolset } from './context.tools';
import { infraToolset } from './infra.tools';
import { kbToolset } from './kb.tools';
import { platformToolset } from './platform.tools';
import { referenceToolset } from './reference.tools';
import { usersToolset } from './users.tools';
import { workflowAuthoringToolset } from './workflow-authoring.tools';
import { workflowsToolset } from './workflows.tools';

/**
 * Every toolset, wired once (synthesis §5, §10): a domain unit fills its own `<domain>.tools.ts` and never
 * edits this file. The registry validates all of them at boot.
 */
export const ALL_TOOLSETS: readonly AiToolset[] = [
  contextToolset,
  assetsToolset,
  referenceToolset,
  accessToolset,
  workflowsToolset,
  workflowAuthoringToolset,
  consumablesToolset,
  kbToolset,
  usersToolset,
  activityToolset,
  infraToolset,
  platformToolset,
];
