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

import { supportedIntegrations } from '../../_common/registry';
import { huskyIntegration } from './husky';
import { nativeGitIntegration } from './native';
import { preCommitIntegration } from './pre-commit';

const GIT_INTEGRATIONS = [nativeGitIntegration, huskyIntegration, preCommitIntegration] as const;

export function registerGitIntegrations(registry = supportedIntegrations): void {
  for (const integration of GIT_INTEGRATIONS) {
    registry.register(integration);
  }
}

export { HUSKY_INTEGRATION_ID } from './husky';
export { installViaGitHooks, NATIVE_GIT_INTEGRATION_ID } from './native';
export {
  hasSonarHookInPreCommitConfig,
  PRE_COMMIT_CONFIG_FILE,
  PRE_COMMIT_INTEGRATION_ID,
} from './pre-commit';
export { HOOK_MARKER } from './shared';
