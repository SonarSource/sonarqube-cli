/*
 * SonarQube CLI
 * Copyright (C) SonarSource Sàrl
 * mailto:info AT sonarsource DOT com
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 3 of the License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program; if not, write to the Free Software Foundation,
 * Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301, USA.
 */

import { join } from 'node:path';

import {
  ANTIGRAVITY_GLOBAL_SKILLS_DIR,
  ANTIGRAVITY_PROJECT_AGENTS_DIR,
} from '../../../../lib/config-constants';
import { createContextAugmentationFeature } from '../_common/features/context-augmentation-feature';
import type { IntegrationContext, IntegrationDeclaration } from '../_common/registry';
import { askUser } from '../_common/registry';
import type { IntegrateAgentOptions } from '../_common/types';

export const ANTIGRAVITY_INTEGRATION_ID = 'antigravity-cli';

export interface AntigravityIntegrationOptions extends IntegrateAgentOptions {
  projectRoot?: string;
  globalSecretsHookExists?: boolean;
  /** Install PostInvocation SQAA hook (project scope). Wired in CLI-551. */
  installSqaaHook?: boolean;
  sqaaEntitled?: boolean;
  installContextAugmentation?: boolean;
}

/**
 * Minimal declarative integration for CLI-549 orchestration. Secrets hooks,
 * SQAA, and MCP features are added in CLI-550/CLI-551.
 */
export const antigravityIntegration: IntegrationDeclaration<AntigravityIntegrationOptions> = {
  id: ANTIGRAVITY_INTEGRATION_ID,
  displayName: 'Antigravity',
  features: [
    {
      id: 'integration-setup',
      displayName: 'Antigravity integration setup',
      shouldInstall: () => askUser(),
    },
    createContextAugmentationFeature<AntigravityIntegrationOptions>({
      agentDisplayName: 'Antigravity',
      targetPath: resolveAntigravitySkillPath,
    }),
  ],
};

function resolveAntigravitySkillPath(context: IntegrationContext): string {
  if (context.scope === 'global') {
    return join(ANTIGRAVITY_GLOBAL_SKILLS_DIR, 'sonar-context-augmentation', 'SKILL.md');
  }
  return join(
    context.targetRoot,
    ANTIGRAVITY_PROJECT_AGENTS_DIR,
    'skills',
    'sonar-context-augmentation',
    'SKILL.md',
  );
}
